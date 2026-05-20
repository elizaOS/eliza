/**
 * Rate Limiting Unit Tests
 *
 * Tests for user-level rate limiting and duplicate detection
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  checkDuplicate,
  checkRateLimit,
  clearAllDuplicates,
  clearAllRateLimits,
  DUPLICATE_DETECTION_CONFIGS,
  getRateLimitStatus,
  RATE_LIMIT_CONFIGS,
} from "@feed/engine";

describe("Rate Limiting", () => {
  beforeEach(() => {
    // Clear all rate limits before each test
    clearAllRateLimits();
    clearAllDuplicates();
  });

  describe("User Rate Limiter", () => {
    it("should allow requests within rate limit", () => {
      const userId = "test-user-1";
      const config = RATE_LIMIT_CONFIGS.CREATE_POST;

      // First request should be allowed
      const result1 = checkRateLimit(userId, config);
      expect(result1.allowed).toBe(true);
      expect(result1.remaining).toBe(2); // 3 max - 1 used = 2 remaining

      // Second request should be allowed
      const result2 = checkRateLimit(userId, config);
      expect(result2.allowed).toBe(true);
      expect(result2.remaining).toBe(1);

      // Third request should be allowed
      const result3 = checkRateLimit(userId, config);
      expect(result3.allowed).toBe(true);
      expect(result3.remaining).toBe(0);
    });

    it("should block requests exceeding rate limit", () => {
      const userId = "test-user-2";
      const config = RATE_LIMIT_CONFIGS.CREATE_POST;

      // Use up all 3 requests
      checkRateLimit(userId, config);
      checkRateLimit(userId, config);
      checkRateLimit(userId, config);

      // Fourth request should be blocked
      const result4 = checkRateLimit(userId, config);
      expect(result4.allowed).toBe(false);
      expect(result4.retryAfter).toBeGreaterThan(0);
      expect(result4.remaining).toBe(0);
    });

    it("should track rate limits separately for different users", () => {
      const user1 = "test-user-3";
      const user2 = "test-user-4";
      const config = RATE_LIMIT_CONFIGS.CREATE_POST;

      // User 1 uses 2 requests
      checkRateLimit(user1, config);
      checkRateLimit(user1, config);

      // User 2 should have full quota
      const result = checkRateLimit(user2, config);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(2);
    });

    it("should track rate limits separately for different actions", () => {
      const userId = "test-user-5";

      // Use up post limit
      checkRateLimit(userId, RATE_LIMIT_CONFIGS.CREATE_POST);
      checkRateLimit(userId, RATE_LIMIT_CONFIGS.CREATE_POST);
      checkRateLimit(userId, RATE_LIMIT_CONFIGS.CREATE_POST);

      // Comment limit should still be available
      const result = checkRateLimit(userId, RATE_LIMIT_CONFIGS.CREATE_COMMENT);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9); // 10 max - 1 used
    });

    it("should provide accurate rate limit status", async () => {
      const userId = "test-user-6";
      const config = RATE_LIMIT_CONFIGS.CREATE_POST;

      // Use 2 requests
      checkRateLimit(userId, config);
      checkRateLimit(userId, config);

      // Check status (async now for Redis support)
      const status = await getRateLimitStatus(userId, config);
      expect(status.count).toBe(2);
      expect(status.remaining).toBe(1);
      expect(status.resetAt).toBeInstanceOf(Date);
    });
  });

  describe("Duplicate Detection", () => {
    it("should allow unique content", () => {
      const userId = "test-user-7";
      const content1 = "This is a unique post";
      const content2 = "This is another unique post";

      const result1 = checkDuplicate(
        userId,
        content1,
        DUPLICATE_DETECTION_CONFIGS.POST,
      );
      expect(result1.isDuplicate).toBe(false);

      const result2 = checkDuplicate(
        userId,
        content2,
        DUPLICATE_DETECTION_CONFIGS.POST,
      );
      expect(result2.isDuplicate).toBe(false);
    });

    it("should detect exact duplicate content", () => {
      const userId = "test-user-8";
      const content = "This is a duplicate post";

      // First post should be allowed
      const result1 = checkDuplicate(
        userId,
        content,
        DUPLICATE_DETECTION_CONFIGS.POST,
      );
      expect(result1.isDuplicate).toBe(false);

      // Same content should be flagged as duplicate
      const result2 = checkDuplicate(
        userId,
        content,
        DUPLICATE_DETECTION_CONFIGS.POST,
      );
      expect(result2.isDuplicate).toBe(true);
      expect(result2.lastPostedAt).toBeInstanceOf(Date);
    });

    it("should normalize content for duplicate detection", () => {
      const userId = "test-user-9";
      const content1 = "This is a post";
      const content2 = "   this is a post  "; // Extra spaces
      const content3 = "THIS IS A POST"; // Different case

      // First post
      checkDuplicate(userId, content1, DUPLICATE_DETECTION_CONFIGS.POST);

      // Should detect as duplicate despite whitespace differences
      const result2 = checkDuplicate(
        userId,
        content2,
        DUPLICATE_DETECTION_CONFIGS.POST,
      );
      expect(result2.isDuplicate).toBe(true);

      // Should detect as duplicate despite case differences
      const result3 = checkDuplicate(
        userId,
        content3,
        DUPLICATE_DETECTION_CONFIGS.POST,
      );
      expect(result3.isDuplicate).toBe(true);
    });

    it("should track duplicates separately for different users", () => {
      const user1 = "test-user-10";
      const user2 = "test-user-11";
      const content = "Shared content";

      // User 1 posts content
      checkDuplicate(user1, content, DUPLICATE_DETECTION_CONFIGS.POST);

      // User 2 should be able to post the same content
      const result = checkDuplicate(
        user2,
        content,
        DUPLICATE_DETECTION_CONFIGS.POST,
      );
      expect(result.isDuplicate).toBe(false);
    });

    it("should track duplicates separately for different content types", () => {
      const userId = "test-user-12";
      const content = "Duplicate content";

      // Post the content as a post
      checkDuplicate(userId, content, DUPLICATE_DETECTION_CONFIGS.POST);

      // Same content as a comment should be allowed (different context)
      const result = checkDuplicate(
        userId,
        content,
        DUPLICATE_DETECTION_CONFIGS.COMMENT,
      );
      expect(result.isDuplicate).toBe(false);
    });

    it("should have different time windows for different content types", () => {
      // Posts have 5-minute window
      expect(DUPLICATE_DETECTION_CONFIGS.POST.windowMs).toBe(5 * 60 * 1000);

      // Comments have 2-minute window
      expect(DUPLICATE_DETECTION_CONFIGS.COMMENT.windowMs).toBe(2 * 60 * 1000);

      // Messages have 1-minute window
      expect(DUPLICATE_DETECTION_CONFIGS.MESSAGE.windowMs).toBe(1 * 60 * 1000);
    });
  });

  describe("Rate Limit Configurations", () => {
    it("should have appropriate limits for each action", () => {
      // Content creation
      expect(RATE_LIMIT_CONFIGS.CREATE_POST.maxRequests).toBe(3);
      expect(RATE_LIMIT_CONFIGS.CREATE_COMMENT.maxRequests).toBe(10);

      // Interactions
      expect(RATE_LIMIT_CONFIGS.LIKE_POST.maxRequests).toBe(20);
      expect(RATE_LIMIT_CONFIGS.LIKE_COMMENT.maxRequests).toBe(20);
      expect(RATE_LIMIT_CONFIGS.SHARE_POST.maxRequests).toBe(5);

      // Social actions
      expect(RATE_LIMIT_CONFIGS.FOLLOW_USER.maxRequests).toBe(10);
      expect(RATE_LIMIT_CONFIGS.UNFOLLOW_USER.maxRequests).toBe(10);

      // Messages
      expect(RATE_LIMIT_CONFIGS.SEND_MESSAGE.maxRequests).toBe(20);

      // Uploads
      expect(RATE_LIMIT_CONFIGS.UPLOAD_IMAGE.maxRequests).toBe(5);
    });

    it("should have stricter limits for anonymous IP requests vs identified IPs", () => {
      // Anonymous requests should have much stricter limits
      // since they share a single bucket
      expect(
        RATE_LIMIT_CONFIGS.PUBLIC_BALANCE_FETCH_ANONYMOUS.maxRequests,
      ).toBe(10);
      expect(RATE_LIMIT_CONFIGS.PUBLIC_BALANCE_FETCH.maxRequests).toBe(60);

      // Anonymous limit should be significantly lower than identified IP limit
      expect(
        RATE_LIMIT_CONFIGS.PUBLIC_BALANCE_FETCH_ANONYMOUS.maxRequests,
      ).toBeLessThan(RATE_LIMIT_CONFIGS.PUBLIC_BALANCE_FETCH.maxRequests);

      // Both should use the same time window
      expect(RATE_LIMIT_CONFIGS.PUBLIC_BALANCE_FETCH_ANONYMOUS.windowMs).toBe(
        RATE_LIMIT_CONFIGS.PUBLIC_BALANCE_FETCH.windowMs,
      );
    });

    it("should use 1-minute windows for all actions", () => {
      const oneMinute = 60_000;

      expect(RATE_LIMIT_CONFIGS.CREATE_POST.windowMs).toBe(oneMinute);
      expect(RATE_LIMIT_CONFIGS.CREATE_COMMENT.windowMs).toBe(oneMinute);
      expect(RATE_LIMIT_CONFIGS.LIKE_POST.windowMs).toBe(oneMinute);
      expect(RATE_LIMIT_CONFIGS.SEND_MESSAGE.windowMs).toBe(oneMinute);
    });
  });

  describe("Combined Rate Limiting and Duplicate Detection", () => {
    it("should prevent both rate limit violations and duplicates", () => {
      const userId = "test-user-14";
      const content1 = "First post";
      const content2 = "First post"; // Duplicate

      // First post should pass both checks
      const rateLimit1 = checkRateLimit(userId, RATE_LIMIT_CONFIGS.CREATE_POST);
      const duplicate1 = checkDuplicate(
        userId,
        content1,
        DUPLICATE_DETECTION_CONFIGS.POST,
      );
      expect(rateLimit1.allowed).toBe(true);
      expect(duplicate1.isDuplicate).toBe(false);

      // Duplicate post should be caught
      const duplicate2 = checkDuplicate(
        userId,
        content2,
        DUPLICATE_DETECTION_CONFIGS.POST,
      );
      expect(duplicate2.isDuplicate).toBe(true);
    });
  });
});
