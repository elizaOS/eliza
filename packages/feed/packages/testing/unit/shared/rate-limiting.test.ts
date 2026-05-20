/**
 * Rate Limiting Unit Tests
 * Tests for shared rate limiting utilities
 */

import { beforeEach, describe, expect, it } from 'bun:test';

import {
  checkDuplicate,
  checkRateLimit,
  clearAllDuplicates,
  clearAllRateLimits,
  DUPLICATE_DETECTION_CONFIGS,
  getDuplicateStats,
  getRateLimitStatus,
  RATE_LIMIT_CONFIGS,
} from '@feed/engine';

describe('Rate Limiting (Shared)', () => {
  beforeEach(async () => {
    await clearAllRateLimits();
    await clearAllDuplicates();
  });

  describe('User Rate Limiter', () => {
    const uid = (n: number) => `rate-limiting-test-user-${n}`;

    it('should allow requests within rate limit', () => {
      const userId = uid(1);
      const config = RATE_LIMIT_CONFIGS.CREATE_POST;

      const result1 = checkRateLimit(userId, config);
      expect(result1.allowed).toBe(true);
      expect(result1.remaining).toBe(2);

      const result2 = checkRateLimit(userId, config);
      expect(result2.allowed).toBe(true);
      expect(result2.remaining).toBe(1);
    });

    it('should block requests exceeding rate limit', () => {
      const userId = uid(2);
      const config = RATE_LIMIT_CONFIGS.CREATE_POST;

      checkRateLimit(userId, config);
      checkRateLimit(userId, config);
      checkRateLimit(userId, config);

      const result = checkRateLimit(userId, config);
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('should track rate limits separately for different users', () => {
      const user1 = uid(3);
      const user2 = uid(4);
      const config = RATE_LIMIT_CONFIGS.CREATE_POST;

      checkRateLimit(user1, config);
      checkRateLimit(user1, config);

      const result = checkRateLimit(user2, config);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(2);
    });

    it('should provide accurate rate limit status', async () => {
      const userId = uid(5);
      const config = RATE_LIMIT_CONFIGS.CREATE_POST;

      checkRateLimit(userId, config);
      checkRateLimit(userId, config);

      const status = await getRateLimitStatus(userId, config);
      expect(status.count).toBe(2);
      expect(status.remaining).toBe(1);
      expect(status.resetAt).toBeInstanceOf(Date);
    });
  });

  describe('Duplicate Detection', () => {
    it('should allow unique content', () => {
      const userId = 'shared-test-user-6';
      const content1 = 'Unique content A';
      const content2 = 'Unique content B';

      const result1 = checkDuplicate(
        userId,
        content1,
        DUPLICATE_DETECTION_CONFIGS.POST
      );
      expect(result1.isDuplicate).toBe(false);

      const result2 = checkDuplicate(
        userId,
        content2,
        DUPLICATE_DETECTION_CONFIGS.POST
      );
      expect(result2.isDuplicate).toBe(false);
    });

    it('should detect duplicate content', () => {
      const userId = 'shared-test-user-7';
      const content = 'Duplicate content';

      checkDuplicate(userId, content, DUPLICATE_DETECTION_CONFIGS.POST);
      const result = checkDuplicate(
        userId,
        content,
        DUPLICATE_DETECTION_CONFIGS.POST
      );
      expect(result.isDuplicate).toBe(true);
      expect(result.lastPostedAt).toBeInstanceOf(Date);
    });

    it('should normalize content for duplicate detection', () => {
      const userId = 'shared-test-user-8';
      const content1 = 'Same Content';
      const content2 = '  same content  ';

      checkDuplicate(userId, content1, DUPLICATE_DETECTION_CONFIGS.POST);
      const result = checkDuplicate(
        userId,
        content2,
        DUPLICATE_DETECTION_CONFIGS.POST
      );
      expect(result.isDuplicate).toBe(true);
    });

    it('should track duplicates separately for different users', () => {
      const user1 = 'shared-test-user-9';
      const user2 = 'shared-test-user-10';
      const content = 'Shared content';

      checkDuplicate(user1, content, DUPLICATE_DETECTION_CONFIGS.POST);
      const result = checkDuplicate(
        user2,
        content,
        DUPLICATE_DETECTION_CONFIGS.POST
      );
      expect(result.isDuplicate).toBe(false);
    });
  });

  describe('Rate Limit Configurations', () => {
    it('should have expected configs', () => {
      expect(RATE_LIMIT_CONFIGS.CREATE_POST).toBeDefined();
      expect(RATE_LIMIT_CONFIGS.CREATE_COMMENT).toBeDefined();
      expect(RATE_LIMIT_CONFIGS.LIKE_POST).toBeDefined();
      expect(RATE_LIMIT_CONFIGS.FOLLOW_USER).toBeDefined();
    });

    it('should have sensible limits', () => {
      expect(RATE_LIMIT_CONFIGS.CREATE_POST.maxRequests).toBeGreaterThan(0);
      expect(RATE_LIMIT_CONFIGS.CREATE_POST.windowMs).toBeGreaterThan(0);
    });
  });

  describe('Duplicate Detection Stats', () => {
    it('should return stats about duplicate detection', () => {
      const stats = getDuplicateStats();
      expect(stats).toHaveProperty('totalUsers');
      expect(stats).toHaveProperty('totalRecords');
      expect(stats).toHaveProperty('recordsByType');
    });

    it('should update stats after recording content', () => {
      checkDuplicate('stats-user', 'content', DUPLICATE_DETECTION_CONFIGS.POST);
      const stats = getDuplicateStats();
      expect(stats.totalUsers).toBeGreaterThan(0);
    });
  });
});
