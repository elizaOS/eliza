// Exercises rate limit orphaned counter behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, it } from "bun:test";
import type { CompatibleRedis } from "../cache/redis-factory";
import { checkUpstash } from "./rate-limit-hono-cloudflare";

// Live incident (2026-07-02): an IP making ~26 requests/hour was permanently
// 429'd on EVERY endpoint (including the public /models) with
// "retryAfter: 60" that never came true. Root cause: `pexpire` is only issued
// on count===1; if that one sub-request drops, the counter key has no TTL
// (pttl -1) and grows forever. checkUpstash must self-heal orphaned counters.
function fakeRedis(state: { count: number; ttl: number | null }) {
  const calls: string[] = [];
  const redis = {
    incr: async () => {
      calls.push("incr");
      state.count += 1;
      return state.count;
    },
    pexpire: async (_key: string, ms: number) => {
      calls.push("pexpire");
      state.ttl = ms;
      return 1;
    },
    pttl: async () => {
      calls.push("pttl");
      return state.ttl ?? -1;
    },
  } as unknown as CompatibleRedis;
  return { redis, calls, state };
}

describe("checkUpstash — orphaned-counter self-heal", () => {
  it("re-arms the window when the counter has no TTL (pttl -1)", async () => {
    // A bricked key: huge count, no expiry (the original pexpire was lost).
    const { redis, calls, state } = fakeRedis({ count: 50_000, ttl: null });
    const result = await checkUpstash(redis, "ip:1.2.3.4", 60_000, 600);
    // Still denied this request (the count is real), but the key now expires:
    expect(result.allowed).toBe(false);
    expect(calls).toContain("pexpire");
    expect(state.ttl).toBe(60_000);
    // ... so the NEXT window starts clean instead of 429ing forever.
  });

  it("arms the window on the first request of a window", async () => {
    const { redis, state } = fakeRedis({ count: 0, ttl: null });
    const result = await checkUpstash(redis, "ip:1.2.3.4", 60_000, 600);
    expect(result.allowed).toBe(true);
    expect(state.ttl).toBe(60_000);
    expect(result.remaining).toBe(599);
  });

  it("does NOT re-arm a healthy in-window counter (would extend the window)", async () => {
    const { redis, calls } = fakeRedis({ count: 10, ttl: 30_000 });
    const result = await checkUpstash(redis, "ip:1.2.3.4", 60_000, 600);
    expect(result.allowed).toBe(true);
    expect(calls).not.toContain("pexpire");
    // resetAt reflects the REAL remaining window, not a fresh one.
    expect(result.resetAt - Date.now()).toBeLessThanOrEqual(30_000);
  });

  it("reports an honest retryAfter for a denied request on a healed key", async () => {
    const { redis } = fakeRedis({ count: 700, ttl: null });
    const result = await checkUpstash(redis, "ip:1.2.3.4", 60_000, 600);
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
    expect(result.retryAfter).toBeLessThanOrEqual(60);
  });
});
