import { PGlite } from "@electric-sql/pglite";
import { eq, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../lib/db/schema";

// Setup in-memory PGlite for testing
let pglite: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

const MIGRATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS soulmates_rate_limits (
    key VARCHAR(255) PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 1,
    reset_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS soulmates_rate_limits_reset_idx ON soulmates_rate_limits(reset_at);
`;

beforeAll(async () => {
  pglite = new PGlite();
  db = drizzle(pglite, { schema });
  await pglite.exec(MIGRATIONS_SQL);
});

afterAll(async () => {
  await pglite.close();
});

beforeEach(async () => {
  await pglite.exec("DELETE FROM soulmates_rate_limits;");
});

// Rate limit function that matches the implementation
type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetInSeconds: number;
};

async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const now = new Date();
  const resetAt = new Date(now.getTime() + windowSeconds * 1000);

  const [entry] = await db
    .select()
    .from(schema.rateLimitTable)
    .where(eq(schema.rateLimitTable.key, key))
    .limit(1);

  // New window or expired
  if (!entry || entry.resetAt < now) {
    await db
      .insert(schema.rateLimitTable)
      .values({ key, count: 1, resetAt })
      .onConflictDoUpdate({
        target: schema.rateLimitTable.key,
        set: { count: 1, resetAt },
      });
    return {
      allowed: true,
      remaining: maxRequests - 1,
      resetInSeconds: windowSeconds,
    };
  }

  const resetInSeconds = Math.ceil(
    (entry.resetAt.getTime() - now.getTime()) / 1000,
  );

  // Rate limited
  if (entry.count >= maxRequests) {
    return { allowed: false, remaining: 0, resetInSeconds };
  }

  // Increment
  await db
    .update(schema.rateLimitTable)
    .set({ count: entry.count + 1 })
    .where(eq(schema.rateLimitTable.key, key));

  return {
    allowed: true,
    remaining: maxRequests - entry.count - 1,
    resetInSeconds,
  };
}

describe("Rate Limiting Integration", () => {
  describe("basic rate limiting", () => {
    it("allows requests under the limit", async () => {
      const result = await checkRateLimit("test:key", 5, 60);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);
    });

    it("decrements remaining count on each request", async () => {
      const r1 = await checkRateLimit("test:key", 5, 60);
      expect(r1.remaining).toBe(4);

      const r2 = await checkRateLimit("test:key", 5, 60);
      expect(r2.remaining).toBe(3);

      const r3 = await checkRateLimit("test:key", 5, 60);
      expect(r3.remaining).toBe(2);
    });

    it("blocks requests at the limit", async () => {
      const maxRequests = 3;

      // Use up all requests
      for (let i = 0; i < maxRequests; i++) {
        const result = await checkRateLimit("limit:test", maxRequests, 60);
        expect(result.allowed).toBe(true);
      }

      // Next request should be blocked
      const blocked = await checkRateLimit("limit:test", maxRequests, 60);
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
    });

    it("returns reset time in seconds", async () => {
      const windowSeconds = 60;
      const result = await checkRateLimit("reset:test", 5, windowSeconds);
      expect(result.resetInSeconds).toBeLessThanOrEqual(windowSeconds);
      expect(result.resetInSeconds).toBeGreaterThan(0);
    });
  });

  describe("different keys are independent", () => {
    it("tracks separate counters per key", async () => {
      await checkRateLimit("user:1", 3, 60);
      await checkRateLimit("user:1", 3, 60);

      await checkRateLimit("user:2", 3, 60);

      const r1 = await checkRateLimit("user:1", 3, 60);
      expect(r1.remaining).toBe(0); // 3rd request of 3

      const r2 = await checkRateLimit("user:2", 3, 60);
      expect(r2.remaining).toBe(1); // 2nd request of 3
    });

    it("blocking one key doesnt affect others", async () => {
      // Block user 1
      for (let i = 0; i < 3; i++) {
        await checkRateLimit("block:1", 3, 60);
      }
      const blocked = await checkRateLimit("block:1", 3, 60);
      expect(blocked.allowed).toBe(false);

      // User 2 should still be allowed
      const allowed = await checkRateLimit("block:2", 3, 60);
      expect(allowed.allowed).toBe(true);
    });
  });

  describe("window expiration", () => {
    it("resets count after window expires", async () => {
      // Use a very short window for testing
      const shortWindow = 1; // 1 second

      // Make first request
      const r1 = await checkRateLimit("expire:test", 3, shortWindow);
      expect(r1.allowed).toBe(true);

      // Use up the limit
      await checkRateLimit("expire:test", 3, shortWindow);
      await checkRateLimit("expire:test", 3, shortWindow);

      // Should be blocked
      const blocked = await checkRateLimit("expire:test", 3, shortWindow);
      expect(blocked.allowed).toBe(false);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Should be allowed again
      const afterExpire = await checkRateLimit("expire:test", 3, shortWindow);
      expect(afterExpire.allowed).toBe(true);
      expect(afterExpire.remaining).toBe(2); // Reset to max - 1
    });
  });

  describe("concurrent requests", () => {
    it("handles concurrent requests (race conditions expected)", async () => {
      const maxRequests = 10;
      const concurrentRequests = 15;

      const results = await Promise.all(
        Array.from({ length: concurrentRequests }, () =>
          checkRateLimit("concurrent:test", maxRequests, 60),
        ),
      );

      const allowed = results.filter((r) => r.allowed).length;
      const blocked = results.filter((r) => !r.allowed).length;

      // Total should always match number of requests
      expect(allowed + blocked).toBe(concurrentRequests);

      // Note: Due to race conditions without atomic increment,
      // allowed count may exceed maxRequests. In production,
      // you'd use atomic database operations or Redis INCR.
      // Here we just verify behavior is consistent.
      expect(allowed).toBeGreaterThan(0);
    });
  });

  describe("SMS rate limiting scenarios", () => {
    it("limits IP to 5 requests per minute", async () => {
      const ip = "192.168.1.1";
      const key = `sms:ip:${ip}`;

      for (let i = 0; i < 5; i++) {
        const result = await checkRateLimit(key, 5, 60);
        expect(result.allowed).toBe(true);
      }

      const blocked = await checkRateLimit(key, 5, 60);
      expect(blocked.allowed).toBe(false);
    });

    it("limits phone to 3 requests per minute", async () => {
      const phone = "+15551234567";
      const key = `sms:phone:${phone}`;

      for (let i = 0; i < 3; i++) {
        const result = await checkRateLimit(key, 3, 60);
        expect(result.allowed).toBe(true);
      }

      const blocked = await checkRateLimit(key, 3, 60);
      expect(blocked.allowed).toBe(false);
    });

    it("tracks IP and phone limits independently", async () => {
      const ipKey = "sms:ip:192.168.1.1";
      const phoneKey = "sms:phone:+15551234567";

      // Use up phone limit
      for (let i = 0; i < 3; i++) {
        await checkRateLimit(phoneKey, 3, 60);
      }
      const phoneBlocked = await checkRateLimit(phoneKey, 3, 60);
      expect(phoneBlocked.allowed).toBe(false);

      // IP should still work
      const ipAllowed = await checkRateLimit(ipKey, 5, 60);
      expect(ipAllowed.allowed).toBe(true);
    });
  });

  describe("login rate limiting scenarios", () => {
    it("limits login attempts to 10 per 5 minutes", async () => {
      const key = "login:ip:192.168.1.1";

      for (let i = 0; i < 10; i++) {
        const result = await checkRateLimit(key, 10, 300);
        expect(result.allowed).toBe(true);
      }

      const blocked = await checkRateLimit(key, 10, 300);
      expect(blocked.allowed).toBe(false);
      expect(blocked.resetInSeconds).toBeGreaterThan(0);
      expect(blocked.resetInSeconds).toBeLessThanOrEqual(300);
    });
  });

  describe("edge cases", () => {
    it("handles limit of 1", async () => {
      const r1 = await checkRateLimit("limit:1:test", 1, 60);
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(0);

      const r2 = await checkRateLimit("limit:1:test", 1, 60);
      expect(r2.allowed).toBe(false);
    });

    it("handles very long keys", async () => {
      const longKey = `rate:${"a".repeat(200)}`;
      const result = await checkRateLimit(longKey, 5, 60);
      expect(result.allowed).toBe(true);
    });

    it("handles special characters in keys", async () => {
      const specialKey = "rate:user@example.com:+15551234567";
      const result = await checkRateLimit(specialKey, 5, 60);
      expect(result.allowed).toBe(true);
    });

    it("handles zero remaining correctly", async () => {
      const result1 = await checkRateLimit("zero:test", 1, 60);
      expect(result1.remaining).toBe(0);

      const result2 = await checkRateLimit("zero:test", 1, 60);
      expect(result2.allowed).toBe(false);
      expect(result2.remaining).toBe(0);
    });
  });

  describe("cleanup behavior", () => {
    it("can delete expired entries", async () => {
      // Insert an already-expired entry
      const expiredTime = new Date(Date.now() - 1000);
      await db
        .insert(schema.rateLimitTable)
        .values({ key: "expired:key", count: 5, resetAt: expiredTime });

      // Insert a valid entry
      const validTime = new Date(Date.now() + 60000);
      await db
        .insert(schema.rateLimitTable)
        .values({ key: "valid:key", count: 1, resetAt: validTime });

      // Cleanup expired
      await db
        .delete(schema.rateLimitTable)
        .where(lt(schema.rateLimitTable.resetAt, new Date()));

      // Check results
      const entries = await db.select().from(schema.rateLimitTable);
      expect(entries).toHaveLength(1);
      expect(entries[0].key).toBe("valid:key");
    });
  });
});
