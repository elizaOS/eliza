/**
 * Article Rate Limiter Service Tests
 *
 * Tests for the ArticleRateLimiterService which prevents article flooding
 * by enforcing hourly limits.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  ArticleRateLimiterService,
  BreakingArticleRateLimiterService,
  createArticleRateLimiter,
} from '../services/article-rate-limiter';

// Mock the database module
let mockDbCount = 0;
const mockDb = {
  select: mock(() => mockDb),
  from: mock(() => mockDb),
  where: mock(() => Promise.resolve([{ count: mockDbCount }])),
};

mock.module('@feed/db', () => ({
  db: mockDb,
  and: (...args: unknown[]) => args,
  eq: (a: unknown, b: unknown) => [a, b],
  gte: (a: unknown, b: unknown) => [a, b],
  isNull: (a: unknown) => [a],
  posts: { type: 'type', timestamp: 'timestamp', deletedAt: 'deletedAt' },
  sql: (strings: TemplateStringsArray) => strings.join(''),
}));

describe('ArticleRateLimiterService', () => {
  beforeEach(() => {
    // Reset mock call counts
    mockDbCount = 0;
    mockDb.select.mockClear();
    mockDb.from.mockClear();
    mockDb.where.mockClear();
    // Default to 0 articles
    mockDb.where.mockImplementation(() =>
      Promise.resolve([{ count: mockDbCount }])
    );
  });

  describe('constructor', () => {
    test('uses default config when no config provided', () => {
      const limiter = new ArticleRateLimiterService();
      const config = limiter.getConfig();

      // Default is 2 per hour for a calmer news feed (configurable via ARTICLE_RATE_LIMIT_PER_HOUR env var)
      expect(config.maxArticlesPerHour).toBe(2);
      expect(config.windowMs).toBe(60 * 60 * 1000);
    });

    test('accepts partial config and merges with defaults', () => {
      const limiter = new ArticleRateLimiterService({ maxArticlesPerHour: 5 });
      const config = limiter.getConfig();

      expect(config.maxArticlesPerHour).toBe(5);
      expect(config.windowMs).toBe(60 * 60 * 1000); // default
    });

    test('accepts full custom config', () => {
      const limiter = new ArticleRateLimiterService({
        maxArticlesPerHour: 10,
        windowMs: 30 * 60 * 1000, // 30 minutes
      });
      const config = limiter.getConfig();

      expect(config.maxArticlesPerHour).toBe(10);
      expect(config.windowMs).toBe(30 * 60 * 1000);
    });
  });

  describe('getRecentArticleCount', () => {
    test('returns 0 when no articles exist', async () => {
      mockDb.where.mockImplementation(() => Promise.resolve([{ count: 0 }]));

      const limiter = new ArticleRateLimiterService();
      const count = await limiter.getRecentArticleCount();

      expect(count).toBe(0);
    });

    test('returns correct count when articles exist', async () => {
      mockDb.where.mockImplementation(() => Promise.resolve([{ count: 5 }]));

      const limiter = new ArticleRateLimiterService();
      const count = await limiter.getRecentArticleCount();

      expect(count).toBe(5);
    });

    test('handles null result gracefully', async () => {
      mockDb.where.mockImplementation(() => Promise.resolve([null]));

      const limiter = new ArticleRateLimiterService();
      const count = await limiter.getRecentArticleCount();

      expect(count).toBe(0);
    });

    test('handles empty result gracefully', async () => {
      mockDb.where.mockImplementation(() => Promise.resolve([]));

      const limiter = new ArticleRateLimiterService();
      const count = await limiter.getRecentArticleCount();

      expect(count).toBe(0);
    });
  });

  describe('canGenerateArticle', () => {
    test('allows generation when under limit', async () => {
      mockDb.where.mockImplementation(() => Promise.resolve([{ count: 0 }]));

      const limiter = new ArticleRateLimiterService({ maxArticlesPerHour: 2 });
      const result = await limiter.canGenerateArticle();

      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(0);
      expect(result.maxAllowed).toBe(2);
      expect(result.remaining).toBe(2);
    });

    test('allows generation when exactly one under limit', async () => {
      mockDb.where.mockImplementation(() => Promise.resolve([{ count: 1 }]));

      const limiter = new ArticleRateLimiterService({ maxArticlesPerHour: 2 });
      const result = await limiter.canGenerateArticle();

      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(1);
      expect(result.remaining).toBe(1);
    });

    test('blocks generation when at limit', async () => {
      mockDb.where.mockImplementation(() => Promise.resolve([{ count: 2 }]));

      const limiter = new ArticleRateLimiterService({ maxArticlesPerHour: 2 });
      const result = await limiter.canGenerateArticle();

      expect(result.allowed).toBe(false);
      expect(result.currentCount).toBe(2);
      expect(result.maxAllowed).toBe(2);
      expect(result.remaining).toBe(0);
    });

    test('blocks generation when over limit', async () => {
      mockDb.where.mockImplementation(() => Promise.resolve([{ count: 5 }]));

      const limiter = new ArticleRateLimiterService({ maxArticlesPerHour: 2 });
      const result = await limiter.canGenerateArticle();

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0); // remaining is clamped to 0
    });
  });

  describe('getRemainingSlots', () => {
    test('returns correct remaining slots', async () => {
      mockDb.where.mockImplementation(() => Promise.resolve([{ count: 1 }]));

      const limiter = new ArticleRateLimiterService({ maxArticlesPerHour: 5 });
      const remaining = await limiter.getRemainingSlots();

      expect(remaining).toBe(4);
    });

    test('returns 0 when at limit', async () => {
      mockDb.where.mockImplementation(() => Promise.resolve([{ count: 5 }]));

      const limiter = new ArticleRateLimiterService({ maxArticlesPerHour: 5 });
      const remaining = await limiter.getRemainingSlots();

      expect(remaining).toBe(0);
    });
  });

  describe('checkAndLog', () => {
    test('returns true when under limit', async () => {
      mockDb.where.mockImplementation(() => Promise.resolve([{ count: 0 }]));

      const limiter = new ArticleRateLimiterService({ maxArticlesPerHour: 2 });
      const allowed = await limiter.checkAndLog('test-source');

      expect(allowed).toBe(true);
    });

    test('returns false when at limit', async () => {
      mockDb.where.mockImplementation(() => Promise.resolve([{ count: 2 }]));

      const limiter = new ArticleRateLimiterService({ maxArticlesPerHour: 2 });
      const allowed = await limiter.checkAndLog('test-source');

      expect(allowed).toBe(false);
    });
  });

  describe('getConfig', () => {
    test('returns a copy of the config', () => {
      const limiter = new ArticleRateLimiterService({ maxArticlesPerHour: 5 });
      const config1 = limiter.getConfig();
      const config2 = limiter.getConfig();

      expect(config1).not.toBe(config2); // Different object references
      expect(config1).toEqual(config2); // Same values
    });
  });
});

describe('createArticleRateLimiter', () => {
  test('creates a limiter with custom config', () => {
    const limiter = createArticleRateLimiter({ maxArticlesPerHour: 10 });
    const config = limiter.getConfig();

    expect(config.maxArticlesPerHour).toBe(10);
  });

  test('throws error for maxArticlesPerHour <= 0', () => {
    expect(() => createArticleRateLimiter({ maxArticlesPerHour: 0 })).toThrow(
      'maxArticlesPerHour must be a positive number'
    );

    expect(() => createArticleRateLimiter({ maxArticlesPerHour: -1 })).toThrow(
      'maxArticlesPerHour must be a positive number'
    );
  });

  test('throws error for windowMs <= 0', () => {
    expect(() => createArticleRateLimiter({ windowMs: 0 })).toThrow(
      'windowMs must be a positive number'
    );

    expect(() => createArticleRateLimiter({ windowMs: -1000 })).toThrow(
      'windowMs must be a positive number'
    );
  });

  test('allows valid positive values', () => {
    const limiter = createArticleRateLimiter({
      maxArticlesPerHour: 1,
      windowMs: 1000,
    });
    const config = limiter.getConfig();

    expect(config.maxArticlesPerHour).toBe(1);
    expect(config.windowMs).toBe(1000);
  });

  test('allows undefined values (uses defaults)', () => {
    const limiter = createArticleRateLimiter({});
    const config = limiter.getConfig();

    // Default is 2 per hour for a calmer news feed (configurable via ARTICLE_RATE_LIMIT_PER_HOUR env var)
    expect(config.maxArticlesPerHour).toBe(2);
    expect(config.windowMs).toBe(60 * 60 * 1000);
  });
});

describe('BreakingArticleRateLimiterService', () => {
  describe('constructor', () => {
    test('uses default config when no config provided', () => {
      const limiter = new BreakingArticleRateLimiterService();
      const config = limiter.getConfig();

      // Default is DEFAULT_MAX_ARTICLES_PER_HOUR + 1 = 3 (regular budget + breaking budget)
      expect(config.maxArticlesPerHour).toBe(3);
      expect(config.windowMs).toBe(60 * 60 * 1000);
    });

    test('accepts custom config', () => {
      const limiter = new BreakingArticleRateLimiterService({
        maxArticlesPerHour: 5,
        windowMs: 30 * 60 * 1000,
      });
      const config = limiter.getConfig();

      expect(config.maxArticlesPerHour).toBe(5);
      expect(config.windowMs).toBe(30 * 60 * 1000);
    });
  });

  describe('getRecentArticleCount', () => {
    test('returns 0 when no articles recorded', async () => {
      mockDbCount = 0;
      const limiter = new BreakingArticleRateLimiterService();
      expect(await limiter.getRecentArticleCount()).toBe(0);
    });

    test('returns correct count from DB', async () => {
      mockDbCount = 2;
      const limiter = new BreakingArticleRateLimiterService();

      expect(await limiter.getRecentArticleCount()).toBe(2);
    });

    test('includes in-flight reservations in count', async () => {
      mockDbCount = 0;
      const limiter = new BreakingArticleRateLimiterService({
        maxArticlesPerHour: 5,
      });

      await limiter.tryReserveSlot();
      await limiter.tryReserveSlot();

      expect(await limiter.getRecentArticleCount()).toBe(2);
    });
  });

  describe('canGenerateArticle', () => {
    test('allows generation when under limit', async () => {
      const limiter = new BreakingArticleRateLimiterService({
        maxArticlesPerHour: 2,
      });

      const result = await limiter.canGenerateArticle();

      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(0);
      expect(result.maxAllowed).toBe(2);
      expect(result.remaining).toBe(2);
    });

    test('blocks generation when at limit', async () => {
      mockDbCount = 1;
      const limiter = new BreakingArticleRateLimiterService({
        maxArticlesPerHour: 1,
      });

      const result = await limiter.canGenerateArticle();

      expect(result.allowed).toBe(false);
      expect(result.currentCount).toBe(1);
      expect(result.remaining).toBe(0);
    });

    test('counts DB articles plus reservations', async () => {
      mockDbCount = 0;
      const limiter = new BreakingArticleRateLimiterService({
        maxArticlesPerHour: 2,
      });

      await limiter.tryReserveSlot();

      const result = await limiter.canGenerateArticle();
      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(1);
    });
  });

  describe('tryReserveSlot', () => {
    test('reserves slot when under limit and returns reservationId', async () => {
      mockDbCount = 0;
      const limiter = new BreakingArticleRateLimiterService({
        maxArticlesPerHour: 2,
      });

      const reservationId = await limiter.tryReserveSlot();

      expect(reservationId).not.toBeNull();
      expect(typeof reservationId).toBe('string');
      expect(await limiter.getRecentArticleCount()).toBe(1);
    });

    test('fails to reserve when at limit and returns null', async () => {
      mockDbCount = 1;
      const limiter = new BreakingArticleRateLimiterService({
        maxArticlesPerHour: 1,
      });

      const reservationId = await limiter.tryReserveSlot();

      expect(reservationId).toBeNull();
      expect(await limiter.getRecentArticleCount()).toBe(1); // Still just DB count
    });

    test('multiple reservations consume slots', async () => {
      mockDbCount = 0;
      const limiter = new BreakingArticleRateLimiterService({
        maxArticlesPerHour: 3,
      });

      expect(await limiter.tryReserveSlot()).not.toBeNull();
      expect(await limiter.tryReserveSlot()).not.toBeNull();
      expect(await limiter.tryReserveSlot()).not.toBeNull();
      expect(await limiter.tryReserveSlot()).toBeNull(); // 4th should fail

      expect(await limiter.getRecentArticleCount()).toBe(3);
    });

    test('returns unique reservation IDs', async () => {
      mockDbCount = 0;
      const limiter = new BreakingArticleRateLimiterService({
        maxArticlesPerHour: 3,
      });

      const id1 = await limiter.tryReserveSlot();
      const id2 = await limiter.tryReserveSlot();
      const id3 = await limiter.tryReserveSlot();

      expect(id1).not.toBeNull();
      expect(id2).not.toBeNull();
      expect(id3).not.toBeNull();
      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
      expect(id1).not.toBe(id3);
    });
  });

  describe('releaseSlot', () => {
    test('releases a reserved slot by reservationId', async () => {
      mockDbCount = 0;
      const limiter = new BreakingArticleRateLimiterService({
        maxArticlesPerHour: 1,
      });
      const reservationId = await limiter.tryReserveSlot();

      expect(await limiter.getRecentArticleCount()).toBe(1);
      expect(reservationId).not.toBeNull();

      const released = limiter.releaseSlot(reservationId!);

      expect(released).toBe(true);
      expect(await limiter.getRecentArticleCount()).toBe(0);
    });

    test('returns false when reservationId not found', () => {
      const limiter = new BreakingArticleRateLimiterService();

      const released = limiter.releaseSlot('non-existent-id');

      expect(released).toBe(false);
    });

    test('allows new reservation after release', async () => {
      mockDbCount = 0;
      const limiter = new BreakingArticleRateLimiterService({
        maxArticlesPerHour: 1,
      });

      const reservationId = await limiter.tryReserveSlot();
      expect(reservationId).not.toBeNull();
      expect(await limiter.tryReserveSlot()).toBeNull(); // At limit

      limiter.releaseSlot(reservationId!);
      expect(await limiter.tryReserveSlot()).not.toBeNull(); // Can reserve again
    });

    test('releases only the specified reservation', async () => {
      mockDbCount = 0;
      const limiter = new BreakingArticleRateLimiterService({
        maxArticlesPerHour: 3,
      });

      const id1 = await limiter.tryReserveSlot();
      const id2 = await limiter.tryReserveSlot();
      const id3 = await limiter.tryReserveSlot();

      expect(await limiter.getRecentArticleCount()).toBe(3);

      // Release the middle one
      const released = limiter.releaseSlot(id2!);
      expect(released).toBe(true);
      expect(await limiter.getRecentArticleCount()).toBe(2);

      // Releasing the same ID again should fail
      const releasedAgain = limiter.releaseSlot(id2!);
      expect(releasedAgain).toBe(false);
      expect(await limiter.getRecentArticleCount()).toBe(2);

      // Other reservations still exist
      expect(limiter.releaseSlot(id1!)).toBe(true);
      expect(limiter.releaseSlot(id3!)).toBe(true);
      expect(await limiter.getRecentArticleCount()).toBe(0);
    });
  });

  describe('recordBreakingArticle', () => {
    test('is a no-op (DB-backed counting)', async () => {
      mockDbCount = 0;
      const limiter = new BreakingArticleRateLimiterService();
      limiter.recordBreakingArticle();

      // recordBreakingArticle is a no-op, count comes from DB
      expect(await limiter.getRecentArticleCount()).toBe(0);
    });

    test('count reflects DB state, not recordBreakingArticle calls', async () => {
      mockDbCount = 3;
      const limiter = new BreakingArticleRateLimiterService();
      limiter.recordBreakingArticle();

      expect(await limiter.getRecentArticleCount()).toBe(3);
    });
  });

  describe('getRemainingSlots', () => {
    test('returns correct remaining slots', async () => {
      mockDbCount = 1;
      const limiter = new BreakingArticleRateLimiterService({
        maxArticlesPerHour: 3,
      });

      const remaining = await limiter.getRemainingSlots();

      expect(remaining).toBe(2);
    });
  });

  describe('reset', () => {
    test('clears all in-flight reservations', async () => {
      mockDbCount = 0;
      const limiter = new BreakingArticleRateLimiterService({
        maxArticlesPerHour: 5,
      });
      await limiter.tryReserveSlot();
      await limiter.tryReserveSlot();

      expect(await limiter.getRecentArticleCount()).toBe(2);

      limiter.reset();

      expect(await limiter.getRecentArticleCount()).toBe(0);
    });
  });

  describe('window boundary behavior', () => {
    test('DB articles within window are counted', async () => {
      mockDbCount = 1;
      const limiter = new BreakingArticleRateLimiterService({
        windowMs: 60000, // 1 minute
        maxArticlesPerHour: 2,
      });

      expect(await limiter.getRecentArticleCount()).toBe(1);
    });

    test('DB articles outside window are not counted (handled by DB query)', async () => {
      // The DB query uses windowMs to filter, so if DB returns 0, count is 0
      mockDbCount = 0;
      const limiter = new BreakingArticleRateLimiterService({
        windowMs: 60000, // 1 minute
        maxArticlesPerHour: 2,
      });

      expect(await limiter.getRecentArticleCount()).toBe(0);
    });
  });
});
