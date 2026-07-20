/**
 * Regression: a voice session must REUSE its bridge conversation across turns.
 *
 * `bridgeStream` used to POST `/api/conversations` on EVERY turn — a serialized
 * round-trip on the first-token critical path that also started a brand-new
 * conversation each turn, dropping prior-turn context. It now caches the created
 * conversation id keyed by the stable session identity `(agentId, orgId,
 * roomId)`:
 *   - turn 1 creates,
 *   - turn 2+ reuse (no create round-trip; the SAME conversation id carries the
 *     turn, so multi-turn context survives),
 *   - a stale/expired cached id (the stream POST answers 404) evicts and
 *     recreates exactly once,
 *   - a distinct session (different roomId/agent) gets its own fresh
 *     conversation,
 *   - a caller with no stable roomId keeps create-per-call behavior.
 *
 * Real `bridgeStream`, no network: the sandbox repo and `fetch` are mocked so we
 * can count creates vs stream POSTs and assert which conversation id each turn's
 * stream request carried.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const sandboxRecord = {
  id: "sandbox-1",
  bridge_url: "https://bridge.example",
  environment_vars: { ELIZA_API_TOKEN: "agent-token" },
};

const findRunningSandbox = mock(async (_agentId: string, _orgId: string) => sandboxRecord);

mock.module("../../db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {
    findRunningSandbox,
  },
}));

const { ElizaSandboxBridgeService } = await import("./eliza-sandbox-bridge");

const originalFetch = globalThis.fetch;

/** Minimal deps: endpoints echo the path, headers are static. */
function makeDeps() {
  return {
    getAgentApiEndpoint: async (_rec: unknown, path: string) => `https://bridge.example${path}`,
    getAgentJsonHeaders: () => ({ "content-type": "application/json" }),
    listRuntimeAgents: async () => ({ supported: false, agents: [] }),
    selectRuntimeAgent: () => undefined,
    isRuntimeAgentReady: () => false,
    ensureRuntimeAgentStarted: async () => null,
  } as never;
}

function sseOk(): Response {
  return new Response('data: {"type":"done","fullText":"hi"}\n\n', {
    headers: { "content-type": "text/event-stream" },
  });
}

function conversationCreateResponse(id: string): Response {
  return new Response(JSON.stringify({ conversation: { id } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

type FetchCall = { url: string; method: string; body: string };

/**
 * Install a fetch mock that:
 *  - answers `/api/conversations` (create) with sequential ids conv-1, conv-2…
 *  - answers `/messages/stream` per the `streamStatus` sequence (200 unless a
 *    status is queued, letting us simulate a stale-id 404), and
 *  - records every call for assertions.
 * Every other endpoint (the compat ladder) 404s so we never leave the cached
 * conversation path silently.
 */
function installFetch(options?: { streamStatuses?: number[] }) {
  const calls: FetchCall[] = [];
  let createSeq = 0;
  const streamStatuses = [...(options?.streamStatuses ?? [])];
  const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, method, body });

    if (url.endsWith("/api/conversations") && method === "POST") {
      createSeq += 1;
      return conversationCreateResponse(`conv-${createSeq}`);
    }
    if (url.includes("/messages/stream") && method === "POST") {
      const status = streamStatuses.shift() ?? 200;
      if (status === 200) return sseOk();
      return new Response("", { status });
    }
    // compat ladder (openai-compat / central-channel) — force it unavailable.
    return new Response("", { status: 404 });
  });
  globalThis.fetch = fetchMock as never;
  return { calls };
}

function streamRpc(roomId?: string) {
  return {
    jsonrpc: "2.0" as const,
    id: 1,
    method: "message.send",
    params: {
      text: "hello",
      source: "voice",
      ...(roomId ? { roomId } : {}),
    },
  };
}

const creates = (calls: FetchCall[]) =>
  calls.filter((c) => c.url.endsWith("/api/conversations") && c.method === "POST");

const streamCalls = (calls: FetchCall[]) =>
  calls.filter((c) => c.url.includes("/messages/stream") && c.method === "POST");

// The conversation id lives in the stream URL: /api/conversations/<id>/messages/stream
const streamConversationId = (url: string) =>
  /\/api\/conversations\/([^/]+)\/messages\/stream/.exec(url)?.[1] ?? null;

let service: InstanceType<typeof ElizaSandboxBridgeService>;

beforeEach(() => {
  service = new ElizaSandboxBridgeService(makeDeps());
  findRunningSandbox.mockClear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("bridgeStream conversation reuse", () => {
  test("first turn creates a conversation, second turn reuses it (no second create)", async () => {
    const { calls } = installFetch();

    const first = await service.bridgeStream("agent-1", "org-1", streamRpc("room-A"));
    const second = await service.bridgeStream("agent-1", "org-1", streamRpc("room-A"));

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    // Only ONE create across two turns.
    expect(creates(calls)).toHaveLength(1);

    // Both turns streamed against the SAME (reused) conversation id — context
    // is preserved across the session.
    const streams = streamCalls(calls);
    expect(streams).toHaveLength(2);
    expect(streamConversationId(streams[0].url)).toBe("conv-1");
    expect(streamConversationId(streams[1].url)).toBe("conv-1");
  });

  test("a stale/invalid cached id (stream 404) recreates exactly once and reuses after", async () => {
    // turn 1: create conv-1, stream 200.
    // turn 2: stream against conv-1 → 404 (sandbox dropped it) → evict, create
    //         conv-2, stream 200.
    // turn 3: reuse conv-2, stream 200 (no new create).
    const { calls } = installFetch({ streamStatuses: [200, 404, 200, 200] });

    await service.bridgeStream("agent-1", "org-1", streamRpc("room-A"));
    const recovered = await service.bridgeStream("agent-1", "org-1", streamRpc("room-A"));
    await service.bridgeStream("agent-1", "org-1", streamRpc("room-A"));

    // The 404 turn still succeeds via the recreated conversation.
    expect(recovered).not.toBeNull();

    // Exactly two creates total: the initial one and the single stale-recovery
    // recreate. NOT one-per-turn, and NOT more than one recovery.
    expect(creates(calls)).toHaveLength(2);

    const streams = streamCalls(calls);
    // turn1 conv-1, turn2 first-attempt conv-1 (404), turn2 retry conv-2, turn3 conv-2.
    expect(streams.map((c) => streamConversationId(c.url))).toEqual([
      "conv-1",
      "conv-1",
      "conv-2",
      "conv-2",
    ]);
  });

  test("a persistent 404 recreates only once, then falls through (no infinite loop)", async () => {
    // Every stream 404s: first attempt (conv-1) → recreate conv-2 → still 404 →
    // stop. Exactly two creates, two stream attempts, then the compat ladder.
    const { calls } = installFetch({ streamStatuses: [404, 404, 404, 404] });

    await service.bridgeStream("agent-1", "org-1", streamRpc("room-A"));

    expect(creates(calls)).toHaveLength(2);
    expect(streamCalls(calls)).toHaveLength(2);
  });

  test("distinct sessions (different roomId) each get their own fresh conversation", async () => {
    const { calls } = installFetch();

    await service.bridgeStream("agent-1", "org-1", streamRpc("room-A"));
    await service.bridgeStream("agent-1", "org-1", streamRpc("room-B"));
    await service.bridgeStream("agent-1", "org-1", streamRpc("room-A"));

    // room-A create, room-B create; room-A's second turn reuses → 2 creates.
    expect(creates(calls)).toHaveLength(2);

    const streams = streamCalls(calls);
    expect(streamConversationId(streams[0].url)).toBe("conv-1"); // room-A turn 1
    expect(streamConversationId(streams[1].url)).toBe("conv-2"); // room-B turn 1
    expect(streamConversationId(streams[2].url)).toBe("conv-1"); // room-A turn 2 reuse
  });

  test("a different agent with the same roomId does not share a conversation", async () => {
    const { calls } = installFetch();

    await service.bridgeStream("agent-1", "org-1", streamRpc("room-A"));
    await service.bridgeStream("agent-2", "org-1", streamRpc("room-A"));

    // Session identity includes agentId → two separate conversations.
    expect(creates(calls)).toHaveLength(2);
  });

  test("no roomId falls back to create-per-call (one-shot callers unchanged)", async () => {
    const { calls } = installFetch();

    await service.bridgeStream("agent-1", "org-1", streamRpc());
    await service.bridgeStream("agent-1", "org-1", streamRpc());

    // No stable session key → each call creates its own conversation.
    expect(creates(calls)).toHaveLength(2);
  });
});
