// Pins the strict env-int contract: trailing-garbage or non-canonical values
// fail closed to the fallback instead of silently becoming a different budget.
import { describe, expect, test } from "bun:test";

describe("envInt — strict integer env parsing", () => {
  test("accepts canonical positive integers", async () => {
    const { envInt } = await import("./config");
    expect(envInt("25000", 300)).toBe(25_000);
    expect(envInt("20", 20)).toBe(20);
  });

  test("rejects trailing garbage that parseInt would silently accept", async () => {
    const { envInt } = await import("./config");
    // parseInt("25000junk") === 25000 — envInt must fail closed to the fallback
    expect(envInt("25000junk", 25_000)).toBe(25_000);
    expect(envInt("20abc", 20)).toBe(20);
    expect(envInt("1junk", 300)).toBe(300);
  });

  test("keeps + prefix (backward compat) and rejects negatives/non-numeric", async () => {
    const { envInt } = await import("./config");
    expect(envInt("+300", 300)).toBe(300);
    expect(envInt("-5", 10)).toBe(10);
    expect(envInt("abc", 300)).toBe(300);
    expect(envInt("1.5", 300)).toBe(300);
  });

  test("empty/unset uses the fallback", async () => {
    const { envInt } = await import("./config");
    expect(envInt("", 300)).toBe(300);
    expect(envInt(undefined, 300)).toBe(300);
    expect(envInt("   ", 300)).toBe(300);
  });

  test("proxy config defaults apply when env is unset", async () => {
    const { getProxyConfig } = await import("./config");
    const cfg = getProxyConfig();
    expect(cfg.UPSTREAM_TIMEOUT_MS).toBe(25_000);
    expect(cfg.PRICING_CACHE_TTL).toBe(300);
    expect(cfg.RPC_MAX_RETRIES).toBe(5);
    expect(cfg.MAX_BATCH_SIZE).toBe(20);
  });
});
