/**
 * Cache Keys - User Metrics Namespace Tests
 *
 * Verifies that cache key generators produce correct, unique,
 * versioned keys for the engagement metrics feature.
 */

import { describe, expect, test } from "bun:test";
import { CacheKeys, CacheStaleTTL, CacheTTL } from "@/lib/cache/keys";

describe("CacheKeys.userMetrics", () => {
  test("overview returns a versioned key scoped by range", () => {
    expect(CacheKeys.userMetrics.overview()).toBe("user-metrics:overview:30d:v1");
    expect(CacheKeys.userMetrics.overview(7)).toBe("user-metrics:overview:7d:v1");
    expect(CacheKeys.userMetrics.overview(90)).toBe("user-metrics:overview:90d:v1");
  });

  test("daily returns a key scoped by date range", () => {
    const key = CacheKeys.userMetrics.daily("2025-01-01", "2025-01-31");
    expect(key).toBe("user-metrics:daily:2025-01-01:2025-01-31:v1");
  });

  test("daily keys with different ranges are distinct", () => {
    const k1 = CacheKeys.userMetrics.daily("2025-01-01", "2025-01-31");
    const k2 = CacheKeys.userMetrics.daily("2025-02-01", "2025-02-28");
    expect(k1).not.toBe(k2);
  });

  test("retention returns a key scoped by date range", () => {
    const key = CacheKeys.userMetrics.retention("2024-11-01", "2025-01-31");
    expect(key).toBe("user-metrics:retention:2024-11-01:2025-01-31:v1");
  });

  test("activeUsers returns a key scoped by time range", () => {
    expect(CacheKeys.userMetrics.activeUsers("day")).toBe("user-metrics:active:day:v1");
    expect(CacheKeys.userMetrics.activeUsers("7d")).toBe("user-metrics:active:7d:v1");
    expect(CacheKeys.userMetrics.activeUsers("30d")).toBe("user-metrics:active:30d:v1");
  });

  test("pattern returns a wildcard for invalidation", () => {
    const pattern = CacheKeys.userMetrics.pattern();
    expect(pattern).toBe("user-metrics:*");
  });

  test("all keys include version suffix v1", () => {
    const keys = [
      CacheKeys.userMetrics.overview(),
      CacheKeys.userMetrics.daily("a", "b"),
      CacheKeys.userMetrics.retention("a", "b"),
      CacheKeys.userMetrics.activeUsers("day"),
    ];
    for (const key of keys) {
      expect(key).toMatch(/:v1$/);
    }
  });
});

describe("CacheTTL.userMetrics", () => {
  test("overview TTL is 300 seconds", () => {
    expect(CacheTTL.userMetrics.overview).toBe(300);
  });

  test("daily TTL is 3600 seconds (pre-computed data)", () => {
    expect(CacheTTL.userMetrics.daily).toBe(3600);
  });

  test("retention TTL is 3600 seconds (pre-computed data)", () => {
    expect(CacheTTL.userMetrics.retention).toBe(3600);
  });

  test("activeUsers TTL is 300 seconds", () => {
    expect(CacheTTL.userMetrics.activeUsers).toBe(300);
  });

  test("pre-computed TTLs are longer than live query TTLs", () => {
    expect(CacheTTL.userMetrics.daily).toBeGreaterThan(CacheTTL.userMetrics.overview);
    expect(CacheTTL.userMetrics.retention).toBeGreaterThan(CacheTTL.userMetrics.activeUsers);
  });
});

describe("CacheStaleTTL.userMetrics", () => {
  test("overview stale TTL is 180 seconds", () => {
    expect(CacheStaleTTL.userMetrics.overview).toBe(180);
  });

  test("activeUsers stale TTL is 180 seconds", () => {
    expect(CacheStaleTTL.userMetrics.activeUsers).toBe(180);
  });

  test("stale TTLs are shorter than their corresponding TTLs", () => {
    expect(CacheStaleTTL.userMetrics.overview).toBeLessThan(CacheTTL.userMetrics.overview);
    expect(CacheStaleTTL.userMetrics.activeUsers).toBeLessThan(CacheTTL.userMetrics.activeUsers);
  });
});
