/**
 * Article Persistence Service Tests
 *
 * Tests for the persistArticle function which is the single source of truth
 * for persisting articles to the database.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { PersistArticleResult } from '../services/article-persistence';

// Track inserted articles for assertions
let insertedArticles: unknown[] = [];
let shouldInsertFail = false;
let insertError = new Error('Database error');

// Mock the database module
const mockInsertValues = mock((values: unknown) => {
  if (shouldInsertFail) {
    return Promise.reject(insertError);
  }
  insertedArticles.push(values);
  return Promise.resolve();
});

const mockInsert = mock(() => ({
  values: mockInsertValues,
}));

const mockUpdateSet = mock(() => ({
  where: mock(() => Promise.resolve()),
}));

const mockUpdate = mock(() => ({
  set: mockUpdateSet,
}));

const mockDb = {
  insert: mockInsert,
  update: mockUpdate,
};

// Mock rate limiter
let rateLimitAllowed = true;
let rateLimitCurrentCount = 0;
const mockCanGenerateArticle = mock(() =>
  Promise.resolve({
    allowed: rateLimitAllowed,
    currentCount: rateLimitCurrentCount,
    maxAllowed: 2,
    remaining: rateLimitAllowed ? 2 - rateLimitCurrentCount : 0,
  })
);

// Mock snowflake ID generation
let snowflakeIdCounter = 1000;
const mockGenerateSnowflakeId = mock(() =>
  Promise.resolve(`${snowflakeIdCounter++}`)
);

// Mock image generation
const mockGenerateArticleImageWithRetry = mock(() =>
  Promise.resolve('https://example.com/image.jpg')
);

// Mock tag services
const mockGenerateTagsFromPost = mock(() => Promise.resolve(['tag1', 'tag2']));
const mockStoreTagsForPost = mock(() => Promise.resolve());

// Set up all mocks before importing the module
mock.module('@feed/db', () => ({
  db: mockDb,
  eq: (a: unknown, b: unknown) => [a, b],
  posts: { id: 'id' },
}));

mock.module('@feed/shared', () => ({
  generateSnowflakeId: mockGenerateSnowflakeId,
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

mock.module('../services/article-rate-limiter', () => ({
  articleRateLimiter: {
    canGenerateArticle: mockCanGenerateArticle,
  },
}));

mock.module('../services/article-image-service', () => ({
  generateArticleImageWithRetry: mockGenerateArticleImageWithRetry,
}));

mock.module('../services/tag-service', () => ({
  generateTagsFromPost: mockGenerateTagsFromPost,
  storeTagsForPost: mockStoreTagsForPost,
}));

// Import after mocks are set up
import { persistArticle } from '../services/article-persistence';

describe('persistArticle', () => {
  beforeEach(() => {
    // Reset state
    insertedArticles = [];
    shouldInsertFail = false;
    insertError = new Error('Database error');
    rateLimitAllowed = true;
    rateLimitCurrentCount = 0;
    snowflakeIdCounter = 1000;

    // Clear mock call counts
    mockInsert.mockClear();
    mockInsertValues.mockClear();
    mockCanGenerateArticle.mockClear();
    mockGenerateSnowflakeId.mockClear();
    mockGenerateArticleImageWithRetry.mockClear();
    mockGenerateTagsFromPost.mockClear();
    mockStoreTagsForPost.mockClear();
  });

  describe('successful persistence', () => {
    test('persists article and returns success with articleId', async () => {
      const article = {
        title: 'Test Article',
        summary: 'Test summary',
        content: 'Test content',
        authorOrgId: 'org-123',
        gameId: 'continuous',
      };

      const result = await persistArticle(article);

      expect(result.success).toBe(true);
      expect(result.articleId).toBe('1000');
      // Type narrowing should work with discriminated union
      if (result.success) {
        expect(result.articleId).toBeDefined();
        expect(result.rateLimited).toBeUndefined();
        expect(result.error).toBeUndefined();
      }
    });

    test('uses provided article ID instead of generating one', async () => {
      const article = {
        id: 'custom-id-123',
        title: 'Test Article',
        summary: 'Test summary',
        content: 'Test content',
        authorOrgId: 'org-123',
        gameId: 'continuous',
      };

      const result = await persistArticle(article);

      expect(result.success).toBe(true);
      expect(result.articleId).toBe('custom-id-123');
      expect(mockGenerateSnowflakeId).not.toHaveBeenCalled();
    });

    test('inserts correct values into database', async () => {
      const article = {
        title: 'Test Article',
        summary: 'Test summary',
        content: 'Test content',
        authorOrgId: 'org-123',
        gameId: 'continuous',
        category: 'technology',
        biasScore: 0.5,
        sentiment: 'positive',
        slant: 'neutral',
        byline: 'Test Author',
        dayNumber: 42,
      };

      await persistArticle(article);

      expect(insertedArticles.length).toBe(1);
      const inserted = insertedArticles[0] as Record<string, unknown>;
      expect(inserted.type).toBe('article');
      expect(inserted.articleTitle).toBe('Test Article');
      expect(inserted.content).toBe('Test summary');
      expect(inserted.fullContent).toBe('Test content');
      expect(inserted.authorId).toBe('org-123');
      expect(inserted.gameId).toBe('continuous');
      expect(inserted.category).toBe('technology');
      expect(inserted.biasScore).toBe(0.5);
      expect(inserted.sentiment).toBe('positive');
      expect(inserted.slant).toBe('neutral');
      expect(inserted.byline).toBe('Test Author');
      expect(inserted.dayNumber).toBe(42);
    });
  });

  describe('rate limiting', () => {
    test('checks rate limit by default', async () => {
      const article = {
        title: 'Test Article',
        summary: 'Test summary',
        content: 'Test content',
        authorOrgId: 'org-123',
        gameId: 'continuous',
      };

      await persistArticle(article);

      expect(mockCanGenerateArticle).toHaveBeenCalled();
    });

    test('returns rate limited result when rate limit exceeded', async () => {
      rateLimitAllowed = false;
      rateLimitCurrentCount = 2;

      const article = {
        title: 'Test Article',
        summary: 'Test summary',
        content: 'Test content',
        authorOrgId: 'org-123',
        gameId: 'continuous',
      };

      const result = await persistArticle(article);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.rateLimited).toBe(true);
        expect(result.articleId).toBeUndefined();
      }
      expect(insertedArticles.length).toBe(0); // Should not insert
    });

    test('skips rate limit check when checkRateLimit is false', async () => {
      rateLimitAllowed = false; // Would block if checked

      const article = {
        title: 'Test Article',
        summary: 'Test summary',
        content: 'Test content',
        authorOrgId: 'org-123',
        gameId: 'continuous',
      };

      const result = await persistArticle(article, { checkRateLimit: false });

      expect(result.success).toBe(true);
      expect(mockCanGenerateArticle).not.toHaveBeenCalled();
      expect(insertedArticles.length).toBe(1);
    });
  });

  describe('error handling', () => {
    test('returns error result when database insert fails', async () => {
      shouldInsertFail = true;
      insertError = new Error('Connection refused');

      const article = {
        title: 'Test Article',
        summary: 'Test summary',
        content: 'Test content',
        authorOrgId: 'org-123',
        gameId: 'continuous',
      };

      const result = await persistArticle(article);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Connection refused');
        expect(result.articleId).toBeUndefined();
      }
    });

    test('handles non-Error exceptions', async () => {
      shouldInsertFail = true;
      insertError = 'String error' as unknown as Error;

      const article = {
        title: 'Test Article',
        summary: 'Test summary',
        content: 'Test content',
        authorOrgId: 'org-123',
        gameId: 'continuous',
      };

      const result = await persistArticle(article);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('String error');
      }
    });
  });

  describe('optional fields', () => {
    test('handles missing optional fields with defaults', async () => {
      const article = {
        title: 'Test Article',
        summary: 'Test summary',
        content: 'Test content',
        authorOrgId: 'org-123',
        gameId: 'continuous',
      };

      await persistArticle(article);

      const inserted = insertedArticles[0] as Record<string, unknown>;
      expect(inserted.category).toBe('news'); // default category
      expect(inserted.byline).toBeUndefined();
      expect(inserted.biasScore).toBeUndefined();
      expect(inserted.sentiment).toBeUndefined();
      expect(inserted.slant).toBeUndefined();
    });

    test('uses nullish coalescing for optional fields', async () => {
      const article = {
        title: 'Test Article',
        summary: 'Test summary',
        content: 'Test content',
        authorOrgId: 'org-123',
        gameId: 'continuous',
        biasScore: 0, // falsy but valid
        dayNumber: 0, // falsy but valid
      };

      await persistArticle(article);

      const inserted = insertedArticles[0] as Record<string, unknown>;
      expect(inserted.biasScore).toBe(0);
      expect(inserted.dayNumber).toBe(0);
    });
  });

  describe('image generation option', () => {
    test('does not generate image when generateImage is false', async () => {
      const article = {
        title: 'Test Article',
        summary: 'Test summary',
        content: 'Test content',
        authorOrgId: 'org-123',
        gameId: 'continuous',
      };

      await persistArticle(article, { generateImage: false });

      expect(mockGenerateArticleImageWithRetry).not.toHaveBeenCalled();
    });

    test('does not generate image when article already has imageUrl', async () => {
      const article = {
        title: 'Test Article',
        summary: 'Test summary',
        content: 'Test content',
        authorOrgId: 'org-123',
        gameId: 'continuous',
        imageUrl: 'https://existing.com/image.jpg',
      };

      await persistArticle(article, { generateImage: true });

      expect(mockGenerateArticleImageWithRetry).not.toHaveBeenCalled();
    });
  });

  describe('discriminated union type safety', () => {
    test('success result has articleId and no error fields', async () => {
      const article = {
        title: 'Test Article',
        summary: 'Test summary',
        content: 'Test content',
        authorOrgId: 'org-123',
        gameId: 'continuous',
      };

      const result: PersistArticleResult = await persistArticle(article);

      if (result.success) {
        // TypeScript should allow this
        const _id: string = result.articleId;
        expect(_id).toBeDefined();
        // These should be undefined/never on success
        expect(result.rateLimited).toBeUndefined();
        expect(result.error).toBeUndefined();
      }
    });

    test('failure result has no articleId', async () => {
      rateLimitAllowed = false;

      const article = {
        title: 'Test Article',
        summary: 'Test summary',
        content: 'Test content',
        authorOrgId: 'org-123',
        gameId: 'continuous',
      };

      const result: PersistArticleResult = await persistArticle(article);

      if (!result.success) {
        // articleId should be undefined on failure
        expect(result.articleId).toBeUndefined();
        expect(result.rateLimited).toBe(true);
      }
    });
  });
});
