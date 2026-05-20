/**
 * Article Rate Limiter Integration Tests
 *
 * Tests for verifying rate limiting works correctly across multiple sources
 * and handles race conditions properly.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createArticleRateLimiter } from "../services/article-rate-limiter";

// Track article count for simulating database state
let mockArticleCount = 0;

// Mock the database module with a controllable article count
const mockDb = {
  select: mock(() => mockDb),
  from: mock(() => mockDb),
  where: mock(() => Promise.resolve([{ count: mockArticleCount }])),
};

mock.module("@feed/db", () => ({
  db: mockDb,
  and: (...args: unknown[]) => args,
  eq: (a: unknown, b: unknown) => [a, b],
  gte: (a: unknown, b: unknown) => [a, b],
  isNull: (a: unknown) => [a],
  posts: { type: "type", timestamp: "timestamp", deletedAt: "deletedAt" },
  sql: (strings: TemplateStringsArray) => strings.join(""),
}));

describe("Rate Limiting Across Multiple Sources", () => {
  beforeEach(() => {
    mockArticleCount = 0;
    mockDb.select.mockClear();
    mockDb.from.mockClear();
    mockDb.where.mockClear();
    mockDb.where.mockImplementation(() =>
      Promise.resolve([{ count: mockArticleCount }]),
    );
  });

  describe("Sequential Source Access", () => {
    test("should block second source when first exhausts limit", async () => {
      const limiter = createArticleRateLimiter({ maxArticlesPerHour: 2 });

      // First source checks - allowed
      const check1 = await limiter.canGenerateArticle();
      expect(check1.allowed).toBe(true);
      expect(check1.remaining).toBe(2);

      // Simulate first source creating an article
      mockArticleCount = 1;

      // First source checks again - still allowed
      const check2 = await limiter.canGenerateArticle();
      expect(check2.allowed).toBe(true);
      expect(check2.remaining).toBe(1);

      // Simulate first source creating another article
      mockArticleCount = 2;

      // Second source tries - should be blocked
      const check3 = await limiter.canGenerateArticle();
      expect(check3.allowed).toBe(false);
      expect(check3.remaining).toBe(0);
    });

    test("should track articles from article-tick, organization-tick, and arc events", async () => {
      const limiter = createArticleRateLimiter({ maxArticlesPerHour: 3 });

      // Simulate article-tick creating 1 article
      mockArticleCount = 1;
      const afterArticleTick = await limiter.canGenerateArticle();
      expect(afterArticleTick.currentCount).toBe(1);
      expect(afterArticleTick.remaining).toBe(2);

      // Simulate organization-tick creating 1 article
      mockArticleCount = 2;
      const afterOrgTick = await limiter.canGenerateArticle();
      expect(afterOrgTick.currentCount).toBe(2);
      expect(afterOrgTick.remaining).toBe(1);

      // Simulate arc event creating 1 article
      mockArticleCount = 3;
      const afterArcEvent = await limiter.canGenerateArticle();
      expect(afterArcEvent.currentCount).toBe(3);
      expect(afterArcEvent.allowed).toBe(false);
      expect(afterArcEvent.remaining).toBe(0);
    });
  });

  describe("Multiple Limiter Instances", () => {
    test("all instances should see same database state", async () => {
      const limiter1 = createArticleRateLimiter({ maxArticlesPerHour: 2 });
      const limiter2 = createArticleRateLimiter({ maxArticlesPerHour: 2 });

      mockArticleCount = 1;

      const check1 = await limiter1.canGenerateArticle();
      const check2 = await limiter2.canGenerateArticle();

      expect(check1.currentCount).toBe(check2.currentCount);
      expect(check1.remaining).toBe(check2.remaining);
    });
  });
});

describe("Race Condition Scenarios", () => {
  beforeEach(() => {
    mockArticleCount = 0;
    mockDb.where.mockImplementation(() =>
      Promise.resolve([{ count: mockArticleCount }]),
    );
  });

  describe("Concurrent Rate Limit Checks", () => {
    test("should demonstrate TOCTOU vulnerability with parallel checks", async () => {
      const limiter = createArticleRateLimiter({ maxArticlesPerHour: 2 });
      mockArticleCount = 1; // One slot remaining

      // Both processes check at the same time - both see 1 remaining
      const [check1, check2] = await Promise.all([
        limiter.canGenerateArticle(),
        limiter.canGenerateArticle(),
      ]);

      // Both see the same state and both are allowed
      // This demonstrates the TOCTOU issue - if both proceed to create,
      // we'll exceed the limit
      expect(check1.allowed).toBe(true);
      expect(check2.allowed).toBe(true);
      expect(check1.remaining).toBe(1);
      expect(check2.remaining).toBe(1);

      // Note: This is the documented behavior. The fix in generateArticlesForArcEvent
      // addresses this by checking rate limit per-article BEFORE creating each one,
      // rather than checking once and creating in parallel.
    });

    test("sequential checks should respect updated state", async () => {
      const limiter = createArticleRateLimiter({ maxArticlesPerHour: 2 });
      mockArticleCount = 1;

      // First check
      const check1 = await limiter.canGenerateArticle();
      expect(check1.allowed).toBe(true);

      // Simulate article creation
      mockArticleCount = 2;

      // Second check sees updated state
      const check2 = await limiter.canGenerateArticle();
      expect(check2.allowed).toBe(false);
    });
  });

  describe("Per-Article Rate Check Pattern (Recommended)", () => {
    test("should properly gate each article in sequential generation", async () => {
      const limiter = createArticleRateLimiter({ maxArticlesPerHour: 2 });
      mockArticleCount = 0;

      const orgsToPublish = [
        { id: "org-1", name: "Org 1" },
        { id: "org-2", name: "Org 2" },
        { id: "org-3", name: "Org 3" },
      ];

      let articlesCreated = 0;

      // Sequential generation with per-article rate check
      // This is the pattern used in the fixed generateArticlesForArcEvent
      for (const _org of orgsToPublish) {
        const { allowed } = await limiter.canGenerateArticle();
        if (!allowed) {
          break;
        }

        // Simulate article creation
        mockArticleCount++;
        articlesCreated++;
      }

      // Should only create 2 articles (limit)
      expect(articlesCreated).toBe(2);
      expect(mockArticleCount).toBe(2);
    });

    test("should stop immediately when rate limit is reached", async () => {
      const limiter = createArticleRateLimiter({ maxArticlesPerHour: 1 });
      mockArticleCount = 1; // Already at limit

      const orgsToPublish = [
        { id: "org-1", name: "Org 1" },
        { id: "org-2", name: "Org 2" },
      ];

      let articlesCreated = 0;

      for (const _org of orgsToPublish) {
        const { allowed } = await limiter.canGenerateArticle();
        if (!allowed) {
          break;
        }
        articlesCreated++;
        mockArticleCount++;
      }

      // Should not create any articles
      expect(articlesCreated).toBe(0);
    });
  });

  describe("Parallel Generation Anti-Pattern (Fixed)", () => {
    test("demonstrates why parallel generation without per-article checks is problematic", async () => {
      const limiter = createArticleRateLimiter({ maxArticlesPerHour: 2 });
      mockArticleCount = 1; // Only 1 slot remaining

      // Initial check (like the old code did)
      const initialCheck = await limiter.canGenerateArticle();
      expect(initialCheck.allowed).toBe(true);
      expect(initialCheck.remaining).toBe(1);

      // Old pattern: check once, then generate all in parallel
      // This could exceed the limit if remaining > 1 org wants to publish
      // With parallel generation and no per-article check, both would proceed
      // simultaneously and potentially exceed limit. The fix converts this to
      // sequential with per-article checks.

      // With parallel generation and no per-article check:
      // Both would proceed simultaneously and potentially exceed limit
      // The fix converts this to sequential with per-article checks
    });
  });
});

describe("Rate Limit Recovery", () => {
  beforeEach(() => {
    mockArticleCount = 0;
    mockDb.where.mockImplementation(() =>
      Promise.resolve([{ count: mockArticleCount }]),
    );
  });

  test("should allow generation after window expires (simulated)", async () => {
    const limiter = createArticleRateLimiter({ maxArticlesPerHour: 2 });

    // At limit
    mockArticleCount = 2;
    const blocked = await limiter.canGenerateArticle();
    expect(blocked.allowed).toBe(false);

    // Simulate window expiry (old articles no longer count)
    mockArticleCount = 0;
    const allowed = await limiter.canGenerateArticle();
    expect(allowed.allowed).toBe(true);
    expect(allowed.remaining).toBe(2);
  });

  test("should correctly report partial recovery", async () => {
    const limiter = createArticleRateLimiter({ maxArticlesPerHour: 3 });

    // At limit
    mockArticleCount = 3;
    const blocked = await limiter.canGenerateArticle();
    expect(blocked.allowed).toBe(false);

    // One article expires
    mockArticleCount = 2;
    const partial = await limiter.canGenerateArticle();
    expect(partial.allowed).toBe(true);
    expect(partial.remaining).toBe(1);
  });
});

describe("Edge Cases", () => {
  beforeEach(() => {
    mockArticleCount = 0;
    mockDb.where.mockImplementation(() =>
      Promise.resolve([{ count: mockArticleCount }]),
    );
  });

  test("should handle limit of 1", async () => {
    const limiter = createArticleRateLimiter({ maxArticlesPerHour: 1 });

    const first = await limiter.canGenerateArticle();
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(1);

    mockArticleCount = 1;
    const second = await limiter.canGenerateArticle();
    expect(second.allowed).toBe(false);
    expect(second.remaining).toBe(0);
  });

  test("should handle very high limits", async () => {
    const limiter = createArticleRateLimiter({ maxArticlesPerHour: 100 });

    mockArticleCount = 50;
    const check = await limiter.canGenerateArticle();
    expect(check.allowed).toBe(true);
    expect(check.remaining).toBe(50);
  });

  test("should clamp remaining to 0 when over limit", async () => {
    const limiter = createArticleRateLimiter({ maxArticlesPerHour: 2 });

    // More articles than limit (shouldn't happen but handle gracefully)
    mockArticleCount = 5;
    const check = await limiter.canGenerateArticle();
    expect(check.allowed).toBe(false);
    expect(check.remaining).toBe(0);
  });
});
