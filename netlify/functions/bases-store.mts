import { getStore } from "@netlify/blobs";

const STORE_NAME = "orcc-bases";
const INDEX_KEY = "index.json";

type LibraryMeta = {
  id: string;
  name: string;
  source: string;
  uf: string;
  baseDate: string;
  type: string;
  createdAt?: string;
  updatedAt?: string;
  compositionCount?: number;
  supplyCount?: number;
  storage?: string;
  blobKey?: string;
  chunked?: boolean;
  compositionChunks?: number;
  supplyChunks?: number;
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
    .slice(0, 120);
}

function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

async function readIndex(): Promise<LibraryMeta[]> {
  return ((await store().get(INDEX_KEY, { type: "json" })) as LibraryMeta[] | null) || [];
}

async function writeIndex(items: LibraryMeta[]) {
  await store().setJSON(INDEX_KEY, items, {
    metadata: { updatedAt: new Date().toISOString(), contentType: "application/json" }
  });
}

async function handleGet(url: URL) {
  const action = url.searchParams.get("action") || "list";
  const id = url.searchParams.get("id") || "";

  if (action === "list") {
    return json({ ok: true, libraries: await readIndex() });
  }

  if (action === "load") {
    if (!id) return json({ ok: false, mensagem: "ID da biblioteca nao informado." }, 400);
    const meta = (await readIndex()).find(x => x.id === id);
    if (!meta) return json({ ok: false, mensagem: "Biblioteca nao encontrada no Blobs." }, 404);

    if (meta.chunked) {
      const sid = safeId(id);
      const compositions = [];
      const supplies = [];

      for (let i = 0; i < (meta.compositionChunks || 0); i++) {
        const chunk = await store().get(`bases/${sid}/compositions-${i}.json`, { type: "json" }) as unknown[] | null;
        if (Array.isArray(chunk)) compositions.push(...chunk);
      }

      for (let i = 0; i < (meta.supplyChunks || 0); i++) {
        const chunk = await store().get(`bases/${sid}/supplies-${i}.json`, { type: "json" }) as unknown[] | null;
        if (Array.isArray(chunk)) supplies.push(...chunk);
      }

      return json({ ok: true, library: meta, base: { library: meta, compositions, supplies } });
    }

    const key = meta.blobKey || `bases/${safeId(id)}.json`;
    const base = await store().get(key, { type: "json" });
    if (!base) return json({ ok: false, mensagem: "Arquivo da biblioteca nao encontrado no Blobs." }, 404);
    return json({ ok: true, library: meta, base });
  }

  return json({ ok: false, mensagem: "Acao invalida." }, 400);
}

async function handlePost(req: Request) {
  const payload = await req.json();
  const action = payload?.action || "save";

  if (action === "save") {
    const library = payload.library as LibraryMeta | undefined;
    if (!library?.id) return json({ ok: false, mensagem: "Biblioteca sem ID." }, 400);

    const compositions = Array.isArray(payload.compositions) ? payload.compositions : [];
    const supplies = Array.isArray(payload.supplies) ? payload.supplies : [];
    const now = new Date().toISOString();
    const key = `bases/${safeId(library.id)}.json`;
    const meta: LibraryMeta = {
      ...library,
      storage: "blob",
      blobKey: key,
      updatedAt: now,
      createdAt: library.createdAt || now,
      compositionCount: compositions.length,
      supplyCount: supplies.length
    };

    await store().setJSON(key, { library: meta, compositions, supplies }, {
      metadata: {
        id: meta.id,
        name: meta.name || "",
        source: meta.source || "",
        uf: meta.uf || "",
        baseDate: meta.baseDate || "",
        updatedAt: now,
        contentType: "application/json"
      }
    });

    const index = (await readIndex()).filter(x => x.id !== meta.id);
    index.unshift(meta);
    await writeIndex(index);
    return json({ ok: true, library: meta });
  }

  if (action === "save-chunk") {
    const library = payload.library as LibraryMeta | undefined;
    const kind = String(payload.kind || "");
    const chunkIndex = Number(payload.index ?? -1);
    const records = Array.isArray(payload.records) ? payload.records : [];
    if (!library?.id) return json({ ok: false, mensagem: "Biblioteca sem ID." }, 400);
    if (!["compositions", "supplies"].includes(kind) || chunkIndex < 0) {
      return json({ ok: false, mensagem: "Bloco invalido." }, 400);
    }

    const key = `bases/${safeId(library.id)}/${kind}-${chunkIndex}.json`;
    await store().setJSON(key, records, {
      metadata: {
        id: library.id,
        kind,
        index: String(chunkIndex),
        updatedAt: new Date().toISOString(),
        contentType: "application/json"
      }
    });
    return json({ ok: true, key });
  }

  if (action === "finalize-chunked") {
    const library = payload.library as LibraryMeta | undefined;
    if (!library?.id) return json({ ok: false, mensagem: "Biblioteca sem ID." }, 400);

    const now = new Date().toISOString();
    const sid = safeId(library.id);
    const meta: LibraryMeta = {
      ...library,
      storage: "blob",
      blobKey: `bases/${sid}`,
      chunked: true,
      compositionChunks: Number(payload.compositionChunks || 0),
      supplyChunks: Number(payload.supplyChunks || 0),
      compositionCount: Number(payload.compositionCount || 0),
      supplyCount: Number(payload.supplyCount || 0),
      updatedAt: now,
      createdAt: library.createdAt || now
    };

    const index = (await readIndex()).filter(x => x.id !== meta.id);
    index.unshift(meta);
    await writeIndex(index);
    return json({ ok: true, library: meta });
  }

  if (action === "delete") {
    const id = String(payload.id || "");
    if (!id) return json({ ok: false, mensagem: "ID da biblioteca nao informado." }, 400);
    const index = await readIndex();
    const meta = index.find(x => x.id === id);

    if (meta?.chunked) {
      const sid = safeId(id);
      for (let i = 0; i < (meta.compositionChunks || 0); i++) await store().delete(`bases/${sid}/compositions-${i}.json`);
      for (let i = 0; i < (meta.supplyChunks || 0); i++) await store().delete(`bases/${sid}/supplies-${i}.json`);
    } else if (meta) {
      await store().delete(meta.blobKey || `bases/${safeId(id)}.json`);
    }

    await writeIndex(index.filter(x => x.id !== id));
    return json({ ok: true });
  }

  return json({ ok: false, mensagem: "Acao invalida." }, 400);
}

export default async (req: Request) => {
  try {
    if (req.method === "GET") return await handleGet(new URL(req.url));
    if (req.method === "POST") return await handlePost(req);
    return json({ ok: false, mensagem: "Metodo nao permitido." }, 405);
  } catch (error) {
    return json({ ok: false, mensagem: error instanceof Error ? error.message : String(error) }, 500);
  }
};
