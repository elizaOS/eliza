/**
 * `EdgeRuntimeCache` behavioral contract.
 *
 * The edge runtime cache tracks warm-state lifecycle (mark warm, increment
 * request count, invalidate) and cross-instance MCP config versioning through
 * the shared cache client. Its observable contract:
 *   - every operation is a no-op when the cache backend is unavailable;
 *   - markRuntimeWarm writes `edge:runtime:warm:<agentId>` with a 300s TTL,
 *     stamping warmedAt and initializing requestCount to 0;
 *   - incrementRequestCount refreshes the TTL and only writes when warm state
 *     exists;
 *   - bumpMcpVersion increments the org version and applies a 24h TTL so the
 *     version outlives the runtime cache; getMcpVersion reads it back (0 when
 *     absent or unavailable);
 *   - backend failures are swallowed (telemetry path never throws).
 *
 * `getStaticEmbeddingDimension` (used by Edge middleware without a Node
 * runtime) resolves exact names, substring matches, and the default.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let calls: Array<{ method: string; args: unknown[] }> = [];
let store = new Map<string, unknown>();
let available = true;
let failNextSet = false;

const cache = {
  isAvailable: () => available,
  async get<T>(key: string): Promise<T | null> {
    calls.push({ method: "get", args: [key] });
    const value = store.get(key);
    return value === undefined ? null : (value as T);
  },
  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    calls.push({ method: "set", args: [key, value, ttl] });
    if (failNextSet) throw new Error("backend down");
    store.set(key, value);
  },
  async del(...keys: string[]): Promise<void> {
    calls.push({ method: "del", args: keys });
    for (const key of keys) store.delete(key);
  },
  async incr(key: string): Promise<number> {
    calls.push({ method: "incr", args: [key] });
    const next = (Number(store.get(key)) || 0) + 1;
    store.set(key, next);
    return next;
  },
  async expire(key: string, ttl: number): Promise<void> {
    calls.push({ method: "expire", args: [key, ttl] });
  },
};

mock.module("./client", () => ({ cache }));
mock.module("../utils/logger", () => ({
  logger: { debug: () => {}, warn: () => {}, info: () => {} },
}));

const { EdgeRuntimeCache, getStaticEmbeddingDimension } = await import("./edge-runtime-cache");

const WARM_PREFIX = "edge:runtime:warm:";
const MCP_PREFIX = "edge:runtime:mcp-version:";

describe("EdgeRuntimeCache warm-state lifecycle", () => {
  const adapter = new EdgeRuntimeCache();

  beforeEach(() => {
    calls = [];
    store = new Map();
    available = true;
    failNextSet = false;
  });

  function setCalls(method: string): Array<{ method: string; args: unknown[] }> {
    return calls.filter((c) => c.method === method);
  }

  test("markRuntimeWarm writes the full state with warmedAt, zero requestCount, and a 300s TTL", async () => {
    await adapter.markRuntimeWarm("agent-1", {
      isWarm: true,
      embeddingDimension: 1536,
      characterName: "ada",
    });
    const sets = setCalls("set");
    expect(sets).toHaveLength(1);
    expect(sets[0].args[0]).toBe(`${WARM_PREFIX}agent-1`);
    expect(sets[0].args[2]).toBe(300);
    const state = sets[0].args[1] as Record<string, unknown>;
    expect(state.isWarm).toBe(true);
    expect(state.embeddingDimension).toBe(1536);
    expect(state.characterName).toBe("ada");
    expect(state.requestCount).toBe(0);
    expect(typeof state.warmedAt).toBe("number");
    expect(Date.now() - (state.warmedAt as number)).toBeLessThan(5_000);
  });

  test("markRuntimeWarm is a no-op when the cache backend is unavailable", async () => {
    available = false;
    await adapter.markRuntimeWarm("agent-1", { isWarm: true, embeddingDimension: 384 });
    expect(calls).toHaveLength(0);
  });

  test("markRuntimeWarm swallows backend errors instead of throwing", async () => {
    failNextSet = true;
    await expect(
      adapter.markRuntimeWarm("agent-1", { isWarm: true, embeddingDimension: 384 }),
    ).resolves.toBeUndefined();
  });

  test("incrementRequestCount bumps the count and refreshes the TTL when warm state exists", async () => {
    await adapter.markRuntimeWarm("agent-1", { isWarm: true, embeddingDimension: 1536 });
    calls = [];
    await adapter.incrementRequestCount("agent-1");
    const sets = setCalls("set");
    expect(sets).toHaveLength(1);
    expect(sets[0].args[0]).toBe(`${WARM_PREFIX}agent-1`);
    expect(sets[0].args[2]).toBe(300);
    expect((sets[0].args[1] as { requestCount: number }).requestCount).toBe(1);
  });

  test("incrementRequestCount does not write when no warm state exists", async () => {
    await adapter.incrementRequestCount("ghost-agent");
    expect(setCalls("set")).toHaveLength(0);
  });

  test("invalidateCharacter deletes the warm-state key", async () => {
    await adapter.markRuntimeWarm("agent-1", { isWarm: true, embeddingDimension: 1536 });
    calls = [];
    await adapter.invalidateCharacter("agent-1");
    expect(setCalls("del")).toEqual([{ method: "del", args: [`${WARM_PREFIX}agent-1`] }]);
  });
});

describe("EdgeRuntimeCache MCP version tracking", () => {
  const adapter = new EdgeRuntimeCache();

  beforeEach(() => {
    calls = [];
    store = new Map();
    available = true;
    failNextSet = false;
  });

  test("bumpMcpVersion increments the org version and applies a 24h TTL", async () => {
    store.set(`${MCP_PREFIX}org-9`, 2);
    const version = await adapter.bumpMcpVersion("org-9");
    expect(version).toBe(3);
    expect(calls).toContainEqual({ method: "expire", args: [`${MCP_PREFIX}org-9`, 86400] });
  });

  test("getMcpVersion reads the stored version back", async () => {
    store.set(`${MCP_PREFIX}org-9`, 5);
    expect(await adapter.getMcpVersion("org-9")).toBe(5);
  });

  test("getMcpVersion returns 0 when no version exists", async () => {
    expect(await adapter.getMcpVersion("org-9")).toBe(0);
  });

  test("bumpMcpVersion and getMcpVersion return 0 when the backend is unavailable", async () => {
    available = false;
    expect(await adapter.bumpMcpVersion("org-9")).toBe(0);
    expect(await adapter.getMcpVersion("org-9")).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("getStaticEmbeddingDimension", () => {
  test("resolves exact model names", () => {
    expect(getStaticEmbeddingDimension("text-embedding-3-small")).toBe(1536);
    expect(getStaticEmbeddingDimension("text-embedding-3-large")).toBe(3072);
    expect(getStaticEmbeddingDimension("text-embedding-ada-002")).toBe(1536);
    expect(getStaticEmbeddingDimension("bge-small-en-v1.5")).toBe(384);
  });

  test("resolves substring matches (provider-prefixed model names)", () => {
    expect(getStaticEmbeddingDimension("openai/text-embedding-3-small")).toBe(1536);
    expect(getStaticEmbeddingDimension("voyage-2/voyage-large-2")).toBe(1536);
  });

  test("falls back to the default for missing or unknown models", () => {
    expect(getStaticEmbeddingDimension(undefined)).toBe(1536);
    expect(getStaticEmbeddingDimension("")).toBe(1536);
    expect(getStaticEmbeddingDimension("totally-unknown-model")).toBe(1536);
  });
});
