/**
 * Exercises the MCP tool-result cache policy directly with a spied cache
 * backend: TTL gating by tool name, org-scoped cache keys derived from a
 * key-order-insensitive params hash, the belt-and-suspenders expiry sweep
 * (stale entries are deleted rather than served), and invalidation. No MCP
 * server or real Redis backend is involved; `cache` method calls are
 * intercepted with spyOn per the established service-cache test pattern.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { cache } from "./client";
import {
  getCachedToolResult,
  getToolCacheStats,
  invalidateToolCache,
  setCachedToolResult,
} from "./mcp-tool-cache";

/** Verifiable result payloads distinct per params. */
const resultFor = (organizationId: string, params: unknown) => ({
  marker: `hit:${organizationId}:${JSON.stringify(params)}`,
});

/** Records every cache.set() call the module under test issues. */
function trackSets(): {
  calls: Array<{ key: string; value: unknown; ttl: number }>;
  restore: () => void;
} {
  const calls: Array<{ key: string; value: unknown; ttl: number }> = [];
  const spy = spyOn(cache, "set").mockImplementation(async (key, value, ttl) => {
    calls.push({ key: key as string, value, ttl: ttl as number });
  });
  return { calls, restore: () => spy.mockRestore() };
}

describe("mcp-tool-cache", () => {
  const spies: Array<{ mockRestore: () => void }> = [];

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  function mockGet<T>(impl: (key: string) => Promise<T | null>) {
    const spy = spyOn(cache, "get").mockImplementation(impl as typeof cache.get);
    spies.push(spy);
    return spy;
  }

  function mockDel(impl: (key: string) => Promise<boolean | void>) {
    const spy = spyOn(cache, "del").mockImplementation(impl as typeof cache.del);
    spies.push(spy);
    return spy;
  }

  test("writes a fresh entry under the org-scoped tool key with the configured TTL", async () => {
    const { calls, restore } = trackSets();
    try {
      await setCachedToolResult(
        "list_agents",
        { agentId: "agent-1" },
        "org-1",
        resultFor("org-1", { agentId: "agent-1" }),
      );
    } finally {
      restore();
    }

    expect(calls).toHaveLength(1);
    const { key, value, ttl } = calls[0] as {
      key: string;
      value: { result: unknown; cachedAt: number; ttl: number };
      ttl: number;
    };
    expect(key.startsWith("mcp:tool:v1:list_agents:org-1:")).toBe(true);
    // list_agents is a stable read with a 5-minute TTL per TOOL_CACHE_TTLS.
    expect(ttl).toBe(300);
    expect(value.ttl).toBe(300);
    expect(value.result).toEqual(resultFor("org-1", { agentId: "agent-1" }));
    // cachedAt is a real epoch timestamp (not a clock skew artifact).
    expect(Number.isFinite(value.cachedAt)).toBe(true);
    expect(value.cachedAt).toBeGreaterThan(0);
  });

  test("never writes cache entries for tools with no TTL policy", async () => {
    const { calls, restore } = trackSets();
    try {
      await setCachedToolResult("generate_text", { prompt: "hi" }, "org-1", { text: "nope" });
    } finally {
      restore();
    }
    expect(calls).toHaveLength(0);
  });

  test("never writes cache entries for tools whose TTL is explicitly 0", async () => {
    const { calls, restore } = trackSets();
    try {
      await setCachedToolResult("subscribe_agent_events", {}, "org-1", { events: [] });
    } finally {
      restore();
    }
    expect(calls).toHaveLength(0);
  });

  test("returns the cached result on a fresh hit without touching del", async () => {
    const result = resultFor("org-1", {});
    const del = mockDel(async () => true);
    mockGet(async (key: string) => {
      expect(key.startsWith("mcp:tool:v1:get_recent_usage:org-1:")).toBe(true);
      return { result, cachedAt: Date.now(), ttl: 60 } as never;
    });

    const cached = await getCachedToolResult("get_recent_usage", {}, "org-1");
    expect(cached).toEqual(result);
    expect(del).not.toHaveBeenCalled();
  });

  test("treats a cache miss (null) as a miss without erroring", async () => {
    mockGet(async () => null);
    expect(await getCachedToolResult("get_recent_usage", {}, "org-1")).toBeNull();
  });

  test("serves nothing for uncacheable tools even when a stale entry exists", async () => {
    const get = mockGet(async () => ({ result: { leaked: true }, cachedAt: 1, ttl: 30 }) as never);
    expect(await getCachedToolResult("generate_text", {}, "org-1")).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  test("expires and deletes a stale entry instead of serving it", async () => {
    const del = mockDel(async () => true);
    // cachedAt 10 minutes ago with a 30s TTL — beyond the belt-and-suspenders sweep.
    mockGet(
      async () => ({ result: { stale: true }, cachedAt: Date.now() - 600_000, ttl: 30 }) as never,
    );

    expect(await getCachedToolResult("get_recent_usage", {}, "org-1")).toBeNull();
    expect(del).toHaveBeenCalledTimes(1);
  });

  test("deletes the exact key it failed to serve on the expiry sweep", async () => {
    let deletedKey = "";
    let servedKey = "";
    mockDel(async (key: string) => {
      deletedKey = key;
      return true;
    });
    mockGet(async (key: string) => {
      servedKey = key;
      return { result: { stale: true }, cachedAt: 1, ttl: 30 } as never;
    });

    await getCachedToolResult("get_recent_usage", { q: "x" }, "org-42");
    expect(deletedKey.startsWith("mcp:tool:v1:get_recent_usage:org-42:")).toBe(true);
    // The sweep deletes the exact entry it declined to serve.
    expect(deletedKey).toBe(servedKey);
  });

  test("serves an entry at the exact TTL boundary (age === ttl seconds)", async () => {
    // Freeze the clock: production re-reads Date.now() after this test computes
    // cachedAt, so a real clock could roll 1ms and turn the boundary case into
    // an expired one. Frozen, age is deterministically exactly ttl * 1000.
    const frozenNow = 1_700_000_000_000;
    const clock = spyOn(Date, "now").mockReturnValue(frozenNow);
    spies.push(clock);
    const del = mockDel(async () => true);
    mockGet(
      async () => ({ result: { edge: true }, cachedAt: frozenNow - 30_000, ttl: 30 }) as never,
    );

    const cached = await getCachedToolResult("get_recent_usage", {}, "org-1");
    expect(cached).toEqual({ edge: true });
    expect(del).not.toHaveBeenCalled();
  });

  test("keys ignore the order of object keys in params (stable hash)", async () => {
    const { calls, restore } = trackSets();
    try {
      await setCachedToolResult("list_agents", { a: 1, b: [2, 3] }, "org-1", "r1");
      await setCachedToolResult("list_agents", { b: [2, 3], a: 1 }, "org-1", "r2");
    } finally {
      restore();
    }
    expect(calls).toHaveLength(2);
    expect(calls[0]?.key).toBe(calls[1]?.key);
  });

  test("keys are scoped per organization (same tool+params, different org)", async () => {
    const { calls, restore } = trackSets();
    try {
      await setCachedToolResult("list_agents", { x: 1 }, "org-1", "r1");
      await setCachedToolResult("list_agents", { x: 1 }, "org-2", "r2");
    } finally {
      restore();
    }
    expect(calls).toHaveLength(2);
    expect(calls[0]?.key).not.toBe(calls[1]?.key);
    expect(calls[0]?.key).toContain("org-1");
    expect(calls[1]?.key).toContain("org-2");
  });

  test("keys distinguish different params (no hash collisions across inputs)", async () => {
    const { calls, restore } = trackSets();
    try {
      await setCachedToolResult("search_conversations", { q: "abc" }, "org-1", "r1");
      await setCachedToolResult("search_conversations", { q: "abd" }, "org-1", "WSTR");
    } finally {
      restore();
    }
    expect(calls).toHaveLength(2);
    expect(calls[0]?.key).not.toBe(calls[1]?.key);
  });

  test("nested object keys are sorted recursively in the params hash", async () => {
    const { calls, restore } = trackSets();
    try {
      await setCachedToolResult(
        "retrieve_memories",
        { z: { inner: 1, outer: 2 }, a: 3 },
        "org-1",
        "r1",
      );
      await setCachedToolResult(
        "retrieve_memories",
        { a: 3, z: { outer: 2, inner: 1 } },
        "org-1",
        "r2",
      );
    } finally {
      restore();
    }
    expect(calls).toHaveLength(2);
    expect(calls[0]?.key).toBe(calls[1]?.key);
  });

  test("invalidates the exact key for tool+org+params", async () => {
    const del = mockDel(async () => true);
    const { calls, restore } = trackSets();
    try {
      await setCachedToolResult("list_agents", { agentId: "a-1" }, "org-9", "r");
    } finally {
      restore();
    }
    await invalidateToolCache("list_agents", "org-9", { agentId: "a-1" });
    expect(del).toHaveBeenCalledTimes(1);
    const arg = del.mock.calls[0]?.[0] as string;
    expect(arg.startsWith("mcp:tool:v1:list_agents:org-9:")).toBe(true);
    // Invalidation removes the exact entry the write created.
    expect(arg).toBe(calls[0]?.key);
  });

  test("pattern-based invalidation without params is skipped (TTL-only expiry)", async () => {
    const del = mockDel(async () => true);
    await invalidateToolCache("list_agents", "org-9");
    expect(del).not.toHaveBeenCalled();
  });

  test("stats partition tools into cacheable, non-cacheable, and TTL map", async () => {
    const stats = await getToolCacheStats();
    expect(stats.cacheable).toContain("list_agents");
    expect(stats.cacheable).toContain("get_recent_usage");
    expect(stats.nonCacheable).toContain("subscribe_agent_events");
    expect(stats.nonCacheable).toContain("stream_credit_updates");
    for (const tool of stats.cacheable) {
      expect(stats.ttls[tool]).toBeGreaterThan(0);
    }
    for (const tool of stats.nonCacheable) {
      expect(stats.ttls[tool]).toBe(0);
    }
    // The partition is exhaustive over the policy table.
    expect(stats.cacheable.length + stats.nonCacheable.length).toBe(Object.keys(stats.ttls).length);
  });

  test("stats scoped to one tool keep the same TTL map shape", async () => {
    const stats = await getToolCacheStats("list_agents");
    expect(stats.ttls.list_agents).toBe(300);
    expect(stats.cacheable).toContain("list_agents");
  });
});
