import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const STORE_NAME = "orcc-users";
const AUTH_STORE = "orcc-auth";
const ADMIN_STORE = "orcc-admin";
const ADMIN_KEY = "config.json";

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

function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

function authStore() {
  return getStore({ name: AUTH_STORE, consistency: "strong" });
}

function adminStore() {
  return getStore({ name: ADMIN_STORE, consistency: "strong" });
}

function emptyPrivateData() {
  return { version: 1, settings: {}, budgets: [], compositions: [], supplies: [], initializedFromInvite: true };
}

async function promotePendingAdmin(userId: string) {
  const cfg = (await adminStore().get(ADMIN_KEY, { type: "json" }) as { admins?: string[]; managed?: unknown[]; createdAt?: string } | null) || { admins: [] };
  if ((cfg.admins || []).includes(userId)) return;
  const now = new Date().toISOString();
  await adminStore().setJSON(ADMIN_KEY, { ...cfg, admins: [...(cfg.admins || []), userId], updatedAt: now, createdAt: cfg.createdAt || now }, {
    metadata: { updatedAt: now, contentType: "application/json" }
  });
}

async function requireUser() {
  return null;
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function currentUser(req: Request) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const session = await authStore().get(`sessions/${tokenHash(token)}.json`, { type: "json" }) as { email?: string } | null;
  if (!session?.email) return null;
  const user = await authStore().get(`users/${safeId(session.email)}.json`, { type: "json" }) as { id: string; email: string; name?: string; roles?: string[] } | null;
  if (!user?.id) return null;
  return user;
}

export default async (req: Request) => {
  try {
    const user = await currentUser(req);
    if (!user) return json({ ok: false, mensagem: "Usuário não autenticado." }, 401);

    const key = `users/${safeId(user.id)}.json`;

    if (req.method === "GET") {
      const data = await store().get(key, { type: "json" });
      if (!data && user.email) {
        const pendingKey = `pending/${safeId(user.email.toLowerCase())}.json`;
        const pending = await store().get(pendingKey, { type: "json" }) as { initialData?: unknown; managed?: { role?: string } } | null;
        if (pending) {
          const now = new Date().toISOString();
          const claimed = {
            ...(typeof pending.initialData === "object" && pending.initialData ? pending.initialData as Record<string, unknown> : emptyPrivateData()),
            userId: user.id,
            userEmail: user.email,
            userRole: pending.managed?.role || "user",
            updatedAt: now,
            seededByAdmin: !!pending.initialData
          };
          await store().setJSON(key, claimed, {
            metadata: {
              userId: user.id,
              email: user.email || "",
              updatedAt: now,
              contentType: "application/json"
            }
          });
          if (pending.managed?.role === "admin") await promotePendingAdmin(user.id);
          return json({
            ok: true,
            user: { id: user.id, email: user.email, name: user.name, roles: user.roles || [] },
            data: claimed
          });
        }
      }
      return json({
        ok: true,
        user: { id: user.id, email: user.email, name: user.name, roles: user.roles || [] },
        data: data || null
      });
    }

    if (req.method === "POST") {
      const payload = await req.json();
      const now = new Date().toISOString();
      const data = {
        ...payload,
        userId: user.id,
        userEmail: user.email,
        updatedAt: now
      };

      await store().setJSON(key, data, {
        metadata: {
          userId: user.id,
          email: user.email || "",
          updatedAt: now,
          contentType: "application/json"
        }
      });

      return json({ ok: true, updatedAt: now });
    }

    return json({ ok: false, mensagem: "Método não permitido." }, 405);
  } catch (error) {
    return json({ ok: false, mensagem: error instanceof Error ? error.message : String(error) }, 500);
  }
};
