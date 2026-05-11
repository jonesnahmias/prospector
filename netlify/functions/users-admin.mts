import { getStore } from "@netlify/blobs";
import { admin, getUser } from "@netlify/identity";

const USER_STORE = "orcc-users";
const ADMIN_STORE = "orcc-admin";
const ADMIN_KEY = "config.json";

type AdminConfig = {
  admins: string[];
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
  return ((await adminStore().get(ADMIN_KEY, { type: "json" })) as AdminConfig | null) || { admins: [] };
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

async function saveInitialUserData(userId: string, email: string | undefined, data: unknown) {
  if (!data) return;
  const now = new Date().toISOString();
  await userStore().setJSON(`users/${safeId(userId)}.json`, {
    ...(typeof data === "object" && data ? data as Record<string, unknown> : {}),
    userId,
    userEmail: email || "",
    updatedAt: now,
    seededByAdmin: true
  }, {
    metadata: {
      userId,
      email: email || "",
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

    if (req.method !== "POST") return json({ ok: false, mensagem: "Método não permitido." }, 405);
    const payload = await req.json();

    if (payload.action === "bootstrap-admin") {
      if (config.admins.length) return json({ ok: false, mensagem: "O gestor inicial já foi criado." }, 409);
      const email = String(payload.email || "").trim();
      const password = String(payload.password || "");
      const name = String(payload.name || "Gestor ORCC").trim();
      if (!email || password.length < 6) return json({ ok: false, mensagem: "Informe e-mail e senha com pelo menos 6 caracteres." }, 400);

      const user = await admin.createUser({
        email,
        password,
        data: {
          role: "admin",
          app_metadata: { roles: ["admin"] },
          user_metadata: { full_name: name }
        }
      });

      await writeAdminConfig({ admins: [user.id] });
      return json({ ok: true, user: { id: user.id, email: user.email, name: user.name, roles: user.roles || ["admin"] } });
    }

    const auth = await currentIsAdmin(config);
    if (!auth.ok) return json({ ok: false, mensagem: "Apenas gestor do app pode executar esta ação." }, 403);

    if (payload.action === "create-user") {
      const email = String(payload.email || "").trim();
      const password = String(payload.password || "");
      const name = String(payload.name || "").trim();
      const role = payload.role === "admin" ? "admin" : "user";
      if (!email || password.length < 6) return json({ ok: false, mensagem: "Informe e-mail e senha com pelo menos 6 caracteres." }, 400);

      const user = await admin.createUser({
        email,
        password,
        data: {
          role,
          app_metadata: { roles: [role] },
          user_metadata: { full_name: name || email }
        }
      });

      if (role === "admin" && !config.admins.includes(user.id)) {
        await writeAdminConfig({ ...config, admins: [...config.admins, user.id] });
      }

      await saveInitialUserData(user.id, user.email, payload.initialData);
      return json({ ok: true, user: { id: user.id, email: user.email, name: user.name, roles: user.roles || [role] } });
    }

    if (payload.action === "list-users") {
      const users = await admin.listUsers({ page: 1, perPage: 100 });
      return json({ ok: true, users: users.map(u => ({ id: u.id, email: u.email, name: u.name, roles: u.roles || [], role: u.role })) });
    }

    return json({ ok: false, mensagem: "Ação inválida." }, 400);
  } catch (error) {
    return json({ ok: false, mensagem: error instanceof Error ? error.message : String(error) }, 500);
  }
};
