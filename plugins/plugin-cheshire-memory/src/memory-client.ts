/**
 * Hermes + Honcho memory clients — HTTP-shaped stubs with offline fallback store.
 * Keys never leave the process; never log secret values.
 */

export type MemoryMessage = {
  role: "user" | "assistant" | "system" | "trade";
  content: string;
  ts: number;
  meta?: Record<string, unknown>;
};

export type MemoryStore = {
  append: (msg: MemoryMessage) => Promise<void>;
  recent: (limit: number) => Promise<MemoryMessage[]>;
  ask: (query: string) => Promise<string>;
  backend: "offline" | "honcho" | "hermes" | "hybrid";
};

export function createOfflineMemoryStore(seed: MemoryMessage[] = []): MemoryStore {
  const messages = [...seed];
  return {
    backend: "offline",
    async append(msg) {
      messages.push(msg);
      if (messages.length > 500) messages.splice(0, messages.length - 500);
    },
    async recent(limit) {
      return messages.slice(-limit);
    },
    async ask(query) {
      const q = query.toLowerCase();
      const hits = messages
        .filter((m) => m.content.toLowerCase().includes(q.slice(0, 40)))
        .slice(-5);
      if (!hits.length) {
        return "No offline memory matches. Configure HONCHO_API_KEY / HERMES_API_KEY for durable recall.";
      }
      return hits.map((h) => `[${h.role}] ${h.content}`).join("\n");
    },
  };
}

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }>;

/**
 * Honcho-shaped chat/context integration.
 * Uses session message append + peer.chat when key present.
 */
export function createHonchoMemoryStore(opts: {
  apiKey: string;
  baseUrl: string;
  peerId: string;
  sessionId: string;
  fetchImpl?: FetchLike;
}): MemoryStore {
  const fetchImpl = opts.fetchImpl || (globalThis.fetch as unknown as FetchLike);
  const local = createOfflineMemoryStore();
  const base = opts.baseUrl.replace(/\/$/, "");

  return {
    backend: "honcho",
    async append(msg) {
      await local.append(msg);
      try {
        await fetchImpl(`${base}/v1/sessions/${encodeURIComponent(opts.sessionId)}/messages`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            peer_id: opts.peerId,
            content: msg.content,
            role: msg.role,
            metadata: msg.meta,
          }),
        });
      } catch {
        // keep offline mirror
      }
    },
    async recent(limit) {
      return local.recent(limit);
    },
    async ask(query) {
      try {
        const res = await fetchImpl(`${base}/v1/peers/${encodeURIComponent(opts.peerId)}/chat`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query, stream: false }),
        });
        if (res.ok) {
          const body = (await res.json()) as { answer?: string; content?: string; text?: string };
          return body.answer || body.content || body.text || (await res.text());
        }
      } catch {
        // fall through
      }
      return local.ask(query);
    },
  };
}

/**
 * Hermes vault/memory — trade + chat recall for Web3 agent stack.
 */
export function createHermesMemoryStore(opts: {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: FetchLike;
}): MemoryStore {
  const fetchImpl = opts.fetchImpl || (globalThis.fetch as unknown as FetchLike);
  const local = createOfflineMemoryStore();
  const base = opts.baseUrl.replace(/\/$/, "");

  return {
    backend: "hermes",
    async append(msg) {
      await local.append(msg);
      try {
        await fetchImpl(`${base}/v1/memory`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            content: msg.content,
            role: msg.role,
            kind: msg.role === "trade" ? "trade" : "chat",
            metadata: msg.meta,
          }),
        });
      } catch {
        // offline mirror
      }
    },
    async recent(limit) {
      return local.recent(limit);
    },
    async ask(query) {
      try {
        const res = await fetchImpl(
          `${base}/v1/memory/query?q=${encodeURIComponent(query)}`,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${opts.apiKey}` },
          },
        );
        if (res.ok) {
          const body = (await res.json()) as { results?: string[]; answer?: string };
          if (body.answer) return body.answer;
          if (body.results?.length) return body.results.join("\n");
        }
      } catch {
        // fall through
      }
      return local.ask(query);
    },
  };
}

export function createHybridMemoryStore(opts: {
  honcho?: MemoryStore | null;
  hermes?: MemoryStore | null;
}): MemoryStore {
  const stores = [opts.honcho, opts.hermes].filter(Boolean) as MemoryStore[];
  if (!stores.length) return createOfflineMemoryStore();
  if (stores.length === 1) return stores[0]!;

  return {
    backend: "hybrid",
    async append(msg) {
      await Promise.all(stores.map((s) => s.append(msg)));
    },
    async recent(limit) {
      const batches = await Promise.all(stores.map((s) => s.recent(limit)));
      return batches
        .flat()
        .sort((a, b) => a.ts - b.ts)
        .slice(-limit);
    },
    async ask(query) {
      const answers = await Promise.all(stores.map((s) => s.ask(query)));
      return answers.filter(Boolean).join("\n---\n");
    },
  };
}

export function buildMemoryStoreFromConfig(cfg: {
  hermesApiKey: string | null;
  hermesBaseUrl: string;
  honchoApiKey: string | null;
  honchoBaseUrl: string;
  peerId: string;
  sessionId: string;
}): MemoryStore {
  const honcho = cfg.honchoApiKey
    ? createHonchoMemoryStore({
        apiKey: cfg.honchoApiKey,
        baseUrl: cfg.honchoBaseUrl,
        peerId: cfg.peerId,
        sessionId: cfg.sessionId,
      })
    : null;
  const hermes = cfg.hermesApiKey
    ? createHermesMemoryStore({
        apiKey: cfg.hermesApiKey,
        baseUrl: cfg.hermesBaseUrl,
      })
    : null;
  return createHybridMemoryStore({ honcho, hermes });
}
