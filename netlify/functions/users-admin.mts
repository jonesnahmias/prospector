import { getStore } from "@netlify/blobs";
import { getUser } from "@netlify/identity";

const USER_STORE = "orcc-users";
const ADMIN_STORE = "orcc-admin";
const ADMIN_KEY = "config.json";

type ManagedUser = {
  email: string;
  name: string;
  role: string;
  seeded: boolean;
  createdBy?: string;
  createdAt: string;
};

type AdminConfig = {
  admins: string[];
  managed?: ManagedUser[];
  createdAt?: string;
  updatedAt?: string;
};

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

function safeId(value: string) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 160);
}

function adminStore() {
  return getStore({ name: ADMIN_STORE, consistency: "strong" });
}

function userStore() {
  return getStore({ name: USER_STORE, consistency: "strong" });
}

async function readAdminConfig(): Promise<AdminConfig> {
  return ((await adminStore().get(ADMIN_KEY, { type: "json" })) as AdminConfig | null) || { admins: [], managed: [] };
}

async function writeAdminConfig(config: AdminConfig) {
  const now = new Date().toISOString();
  await adminStore().setJSON(ADMIN_KEY, { ...config, updatedAt: now, createdAt: config.createdAt || now }, {
    metadata: { updatedAt: now, contentType: "application/json" }
  });
}

async function currentIsAdmin(config?: AdminConfig) {
  const user = await getUser();
  if (!user?.id) return { user: null, ok: false };
  const cfg = config || await readAdminConfig();
  const roles = new Set([...(user.roles || []), String(user.role || "")]);
  const ok = cfg.admins.includes(user.id) || roles.has("admin") || roles.has("gestor");
  return { user, ok };
}

async function savePendingUserData(email: string, data: unknown, managed: ManagedUser) {
  const now = new Date().toISOString();
  const normalizedEmail = email.trim().toLowerCase();
  await userStore().setJSON(`pending/${safeId(normalizedEmail)}.json`, {
    initialData: typeof data === "object" && data ? data : null,
    managed,
    updatedAt: now,
    seededByAdmin: !!data
  }, {
    metadata: {
      email: normalizedEmail,
      updatedAt: now,
      contentType: "application/json"
    }
  });
}

export default async (req: Request) => {
  try {
    const url = new URL(req.url);
    const action = req.method === "GET" ? (url.searchParams.get("action") || "status") : "";
    const config = await readAdminConfig();

    if (req.method === "GET" && action === "status") {
      const auth = await currentIsAdmin(config);
      return json({
        ok: true,
        initialized: config.admins.length > 0,
        isAdmin: auth.ok,
        user: auth.user ? { id: auth.user.id, email: auth.user.email, name: auth.user.name, roles: auth.user.roles || [] } : null
      });
    }

    if (req.method !== "POST") return json({ ok: false, mensagem: "Metodo nao permitido." }, 405);
    const payload = await req.json();

    if (payload.action === "bootstrap-admin") {
      if (config.admins.length) return json({ ok: false, mensagem: "O gestor inicial ja foi criado." }, 409);
      const user = await getUser();
      if (!user?.id) return json({ ok: false, mensagem: "Entre ou crie uma conta antes de tornar este login gestor." }, 401);

      const managed: ManagedUser = {
        email: user.email || "",
        name: user.name || String(payload.name || "Gestor ORCC"),
        role: "admin",
        seeded: false,
        createdAt: new Date().toISOString()
      };
      await writeAdminConfig({ ...config, admins: [user.id], managed: [managed] });
      return json({ ok: true, user: { id: user.id, email: user.email, name: user.name, roles: ["admin"] } });
    }

    const auth = await currentIsAdmin(config);
    if (!auth.ok) return json({ ok: false, mensagem: "Apenas gestor do app pode executar esta acao." }, 403);

    if (payload.action === "create-user") {
      const email = String(payload.email || "").trim().toLowerCase();
      const name = String(payload.name || "").trim();
      const role = payload.role === "admin" ? "admin" : "user";
      if (!email || !email.includes("@")) return json({ ok: false, mensagem: "Informe um e-mail valido." }, 400);

      const managed: ManagedUser = {
        email,
        name: name || email,
        role,
        seeded: !!payload.initialData,
        createdBy: auth.user?.email || auth.user?.id,
        createdAt: new Date().toISOString()
      };
      const others = (config.managed || []).filter(u => u.email.toLowerCase() !== email);
      await writeAdminConfig({ ...config, managed: [...others, managed] });
      await savePendingUserData(email, payload.initialData, managed);
      return json({ ok: true, user: managed });
    }

    if (payload.action === "list-users") {
      return json({ ok: true, users: config.managed || [] });
    }

    return json({ ok: false, mensagem: "Acao invalida." }, 400);
  } catch (error) {
    return json({ ok: false, mensagem: error instanceof Error ? error.message : String(error) }, 500);
  }
};
