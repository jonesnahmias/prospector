import { getStore } from "@netlify/blobs";
import { getUser } from "@netlify/identity";

const STORE_NAME = "orcc-users";

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

async function requireUser() {
  const user = await getUser();
  if (!user?.id) return null;
  return user;
}

export default async (req: Request) => {
  try {
    const user = await requireUser();
    if (!user) return json({ ok: false, mensagem: "Usuário não autenticado." }, 401);

    const key = `users/${safeId(user.id)}.json`;

    if (req.method === "GET") {
      const data = await store().get(key, { type: "json" });
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
