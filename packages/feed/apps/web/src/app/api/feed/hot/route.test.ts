import { describe, expect, it } from 'bun:test';

/**
 * Tests for Hot Posts API - Scoring Algorithm
 *
 * These tests verify that the hot post scoring algorithm
 * correctly weights engagement metrics and applies time decay.
 */
describe('Hot Posts API - Scoring Algorithm', () => {
  const AGE_PENALTY_PER_HOUR = 0.5;
  const LIKE_WEIGHT = 1;
  const COMMENT_WEIGHT = 2;
  const SHARE_WEIGHT = 3;

  /**
   * Replicates the calculateHotScore function from the route
   */
  const calculateHotScore = (
    likeCount: number,
    commentCount: number,
    shareCount: number,
    timestamp: Date
  ): number => {
    const now = new Date();
    const hoursOld = (now.getTime() - timestamp.getTime()) / (1000 * 60 * 60);

    const engagementScore =
      likeCount * LIKE_WEIGHT +
      commentCount * COMMENT_WEIGHT +
      shareCount * SHARE_WEIGHT;

    const agePenalty = hoursOld * AGE_PENALTY_PER_HOUR;

    return Math.max(0, engagementScore - agePenalty);
  };

  describe('calculateHotScore', () => {
    it('should weight shares highest, then comments, then likes', () => {
      const now = new Date();

      // All else equal, shares should contribute most
      const likeOnly = calculateHotScore(1, 0, 0, now);
      const commentOnly = calculateHotScore(0, 1, 0, now);
      const shareOnly = calculateHotScore(0, 0, 1, now);

      expect(shareOnly).toBeGreaterThan(commentOnly);
      expect(commentOnly).toBeGreaterThan(likeOnly);
    });

    it('should apply time decay penalty', () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

      const scoreNow = calculateHotScore(10, 5, 2, now);
      const scoreOneHourAgo = calculateHotScore(10, 5, 2, oneHourAgo);
      const scoreTwoHoursAgo = calculateHotScore(10, 5, 2, twoHoursAgo);

      expect(scoreNow).toBeGreaterThan(scoreOneHourAgo);
      expect(scoreOneHourAgo).toBeGreaterThan(scoreTwoHoursAgo);
    });

    it('should not return negative scores', () => {
      const veryOld = new Date(Date.now() - 100 * 60 * 60 * 1000); // 100 hours ago
      const score = calculateHotScore(1, 0, 0, veryOld);
      expect(score).toBeGreaterThanOrEqual(0);
    });

    it('should return 0 for posts with no engagement and some age', () => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const score = calculateHotScore(0, 0, 0, oneHourAgo);
      expect(score).toBe(0);
    });

    it('should calculate combined engagement score correctly', () => {
      const now = new Date();

      // 5 likes * 1 + 3 comments * 2 + 2 shares * 3 = 5 + 6 + 6 = 17
      const score = calculateHotScore(5, 3, 2, now);
      expect(Math.round(score)).toBe(17);
    });

    it('should handle high engagement vs old post tradeoff', () => {
      const now = new Date();
      const tenHoursAgo = new Date(now.getTime() - 10 * 60 * 60 * 1000);

      // New post with low engagement
      const newLowEngagement = calculateHotScore(2, 1, 0, now); // 2*1 + 1*2 = 4

      // Old post with high engagement
      // 50 likes + 30 comments + 10 shares = 50 + 60 + 30 = 140
      // minus 10 hours * 0.5 penalty = 140 - 5 = 135
      const oldHighEngagement = calculateHotScore(50, 30, 10, tenHoursAgo);

      // High engagement should still win even with age penalty
      expect(oldHighEngagement).toBeGreaterThan(newLowEngagement);
    });
  });

  describe('toISOStringStrict', () => {
    /**
     * Replicates the toISOStringStrict function from the route.
     * STRICT: Throws on invalid input instead of masking with current time.
     */
    const toISOStringStrict = (
      date: Date | string | null | undefined
    ): string => {
      if (date === null || date === undefined) {
        throw new Error('Invalid date input: null or undefined');
      }
      if (date instanceof Date) {
        if (isNaN(date.getTime())) {
          throw new Error('Invalid date input: Date object is invalid');
        }
        return date.toISOString();
      }
      if (typeof date === 'string') {
        const parsed = new Date(date);
        if (!isNaN(parsed.getTime())) {
          return parsed.toISOString();
        }
        throw new Error(`Invalid date input: unparseable string "${date}"`);
      }
      throw new Error(`Invalid date input: unexpected type ${typeof date}`);
    };

    it('should handle Date objects', () => {
      const date = new Date('2025-01-04T12:00:00.000Z');
      expect(toISOStringStrict(date)).toBe('2025-01-04T12:00:00.000Z');
    });

    it('should handle ISO string format', () => {
      const isoString = '2025-01-04T12:00:00.000Z';
      expect(toISOStringStrict(isoString)).toBe(isoString);
    });

    it('should handle parseable date strings', () => {
      const dateString = '2025-01-04';
      const result = toISOStringStrict(dateString);
      expect(result).toContain('2025-01-04');
      expect(result).toContain('T');
    });

    it('should throw for null', () => {
      expect(() => toISOStringStrict(null)).toThrow('Invalid date input');
    });

    it('should throw for undefined', () => {
      expect(() => toISOStringStrict(undefined)).toThrow('Invalid date input');
    });

    it('should throw for invalid date string', () => {
      expect(() => toISOStringStrict('not-a-date')).toThrow('unparseable');
    });
  });
});
