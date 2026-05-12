import { getStore } from "@netlify/blobs";
import { createHash, pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";

const AUTH_STORE = "orcc-auth";
const ADMIN_STORE = "orcc-admin";
const ADMIN_KEY = "config.json";

type AuthUser = {
  id: string;
  email: string;
  name: string;
  salt: string;
  passwordHash: string;
  createdAt: string;
  updatedAt?: string;
};

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function safeId(value: string) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 180);
}

function store() {
  return getStore({ name: AUTH_STORE, consistency: "strong" });
}

function adminStore() {
  return getStore({ name: ADMIN_STORE, consistency: "strong" });
}

function passwordHash(password: string, salt: string) {
  return pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function publicUser(user: AuthUser) {
  return { id: user.id, email: user.email, name: user.name, roles: [] };
}

async function createSession(user: AuthUser) {
  const token = `${randomUUID()}.${randomBytes(32).toString("hex")}`;
  const now = new Date().toISOString();
  await store().setJSON(`sessions/${tokenHash(token)}.json`, {
    userId: user.id,
    email: user.email,
    createdAt: now
  }, {
    metadata: { userId: user.id, email: user.email, createdAt: now }
  });
  return { token, user: publicUser(user) };
}

async function getUserByToken(req: Request) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const session = await store().get(`sessions/${tokenHash(token)}.json`, { type: "json" }) as { email?: string } | null;
  if (!session?.email) return null;
  return await store().get(`users/${safeId(session.email)}.json`, { type: "json" }) as AuthUser | null;
}

export default async (req: Request) => {
  try {
    if (req.method === "GET") {
      const user = await getUserByToken(req);
      return json({ ok: true, user: user ? publicUser(user) : null });
    }

    if (req.method !== "POST") return json({ ok: false, mensagem: "Metodo nao permitido." }, 405);
    const payload = await req.json();
    const action = String(payload.action || "");

    if (action === "signup") {
      const email = String(payload.email || "").trim().toLowerCase();
      const password = String(payload.password || "");
      const name = String(payload.name || "").trim() || email;
      if (!email.includes("@") || password.length < 6) return json({ ok: false, mensagem: "Informe e-mail valido e senha com pelo menos 6 caracteres." }, 400);
      const adminConfig = await adminStore().get(ADMIN_KEY, { type: "json" }) as { admins?: string[] } | null;
      if ((adminConfig?.admins || []).length) return json({ ok: false, mensagem: "Conta criada somente pelo gestor. Use o e-mail e a senha fornecidos." }, 403);
      const key = `users/${safeId(email)}.json`;
      const existing = await store().get(key, { type: "json" });
      if (existing) return json({ ok: false, mensagem: "Conta ja existe. Use Entrar." }, 409);
      const now = new Date().toISOString();
      const salt = randomBytes(16).toString("hex");
      const user: AuthUser = {
        id: randomUUID(),
        email,
        name,
        salt,
        passwordHash: passwordHash(password, salt),
        createdAt: now
      };
      await store().setJSON(key, user, { metadata: { userId: user.id, email, createdAt: now } });
      const session = await createSession(user);
      return json({ ok: true, ...session });
    }

    if (action === "login") {
      const email = String(payload.email || "").trim().toLowerCase();
      const password = String(payload.password || "");
      const user = await store().get(`users/${safeId(email)}.json`, { type: "json" }) as AuthUser | null;
      if (!user || passwordHash(password, user.salt) !== user.passwordHash) return json({ ok: false, mensagem: "E-mail ou senha incorretos." }, 401);
      const session = await createSession(user);
      return json({ ok: true, ...session });
    }

    if (action === "logout") {
      const token = String(payload.token || "");
      if (token) await store().delete(`sessions/${tokenHash(token)}.json`);
      return json({ ok: true });
    }

    return json({ ok: false, mensagem: "Acao invalida." }, 400);
  } catch (error) {
    return json({ ok: false, mensagem: error instanceof Error ? error.message : String(error) }, 500);
  }
};
