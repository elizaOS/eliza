/**
 * Tests for Content Pacing Configuration
 *
 * Verifies that content generation pacing works correctly:
 * - Time-of-day multipliers
 * - Actor post limits
 * - Tick-level calculations
 * - Day boundary detection
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTENT_PACING,
  calculatePostsForTick,
  getTimeOfDayMultiplier,
  isNewDay,
  shouldActorPost,
} from '../../config/content-pacing';

describe('Content Pacing', () => {
  describe('CONTENT_PACING constants', () => {
    it('should have sensible default values', () => {
      expect(CONTENT_PACING.peakHoursMultiplier).toBe(1.0);
      expect(CONTENT_PACING.offPeakMultiplier).toBeLessThan(1.0);
      expect(CONTENT_PACING.offPeakMultiplier).toBeGreaterThan(0);

      expect(CONTENT_PACING.maxPostsPerActorPerDay).toBeGreaterThan(0);
      expect(CONTENT_PACING.maxPostsPerTick).toBeGreaterThan(0);
      expect(CONTENT_PACING.targetPostsPerHour).toBeGreaterThan(0);

      expect(CONTENT_PACING.peakHourStart).toBeLessThan(
        CONTENT_PACING.peakHourEnd
      );
      expect(CONTENT_PACING.minTimeBetweenPostsMs).toBeGreaterThan(0);
    });

    it('should have peak hours in valid range (0-23)', () => {
      expect(CONTENT_PACING.peakHourStart).toBeGreaterThanOrEqual(0);
      expect(CONTENT_PACING.peakHourStart).toBeLessThanOrEqual(23);
      expect(CONTENT_PACING.peakHourEnd).toBeGreaterThanOrEqual(0);
      expect(CONTENT_PACING.peakHourEnd).toBeLessThanOrEqual(24);
    });
  });

  describe('getTimeOfDayMultiplier', () => {
    it('should return peak multiplier during peak hours', () => {
      // Test all peak hours (9am to 8pm inclusive)
      for (
        let hour = CONTENT_PACING.peakHourStart;
        hour < CONTENT_PACING.peakHourEnd;
        hour++
      ) {
        expect(getTimeOfDayMultiplier(hour)).toBe(
          CONTENT_PACING.peakHoursMultiplier
        );
      }
    });

    it('should return off-peak multiplier during off-peak hours', () => {
      // Early morning (0-8am)
      for (let hour = 0; hour < CONTENT_PACING.peakHourStart; hour++) {
        expect(getTimeOfDayMultiplier(hour)).toBe(
          CONTENT_PACING.offPeakMultiplier
        );
      }

      // Late night (9pm-11pm)
      for (let hour = CONTENT_PACING.peakHourEnd; hour < 24; hour++) {
        expect(getTimeOfDayMultiplier(hour)).toBe(
          CONTENT_PACING.offPeakMultiplier
        );
      }
    });

    it('should handle boundary hours correctly', () => {
      // 8am should be off-peak
      expect(getTimeOfDayMultiplier(8)).toBe(CONTENT_PACING.offPeakMultiplier);

      // 9am should be peak (start of peak)
      expect(getTimeOfDayMultiplier(9)).toBe(
        CONTENT_PACING.peakHoursMultiplier
      );

      // 20 (8pm) should be peak
      expect(getTimeOfDayMultiplier(20)).toBe(
        CONTENT_PACING.peakHoursMultiplier
      );

      // 21 (9pm) should be off-peak (end of peak)
      expect(getTimeOfDayMultiplier(21)).toBe(CONTENT_PACING.offPeakMultiplier);
    });

    it('should use current hour when no argument provided', () => {
      // This test verifies the function works without arguments
      const result = getTimeOfDayMultiplier();
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThanOrEqual(1);
    });
  });

  describe('shouldActorPost', () => {
    beforeEach(() => {
      vi.spyOn(Math, 'random');
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should return false when daily limit is exceeded', () => {
      const result = shouldActorPost(
        null,
        CONTENT_PACING.maxPostsPerActorPerDay,
        12
      );
      expect(result).toBe(false);
    });

    it('should return false when daily limit is exceeded by more', () => {
      const result = shouldActorPost(
        null,
        CONTENT_PACING.maxPostsPerActorPerDay + 5,
        12
      );
      expect(result).toBe(false);
    });

    it('should return true when under daily limit with no last post', () => {
      // Force random to return 0 (always passes probability check)
      vi.spyOn(Math, 'random').mockReturnValue(0);

      const result = shouldActorPost(null, 0, 12); // Peak hour
      expect(result).toBe(true);
    });

    it('should return false when minimum interval not passed', () => {
      const recentPost = new Date(Date.now() - 60000); // 1 minute ago
      const result = shouldActorPost(recentPost, 0, 12);
      expect(result).toBe(false);
    });

    it('should return true when minimum interval has passed', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);

      // Post from 31 minutes ago (past the 30-minute minimum)
      const oldPost = new Date(Date.now() - 31 * 60 * 1000);
      const result = shouldActorPost(oldPost, 0, 12);
      expect(result).toBe(true);
    });

    it('should apply probability check during off-peak hours', () => {
      // Test at 3am (off-peak)
      const offPeakHour = 3;

      // Random returns high value - should fail probability check
      vi.spyOn(Math, 'random').mockReturnValue(0.9);
      expect(shouldActorPost(null, 0, offPeakHour)).toBe(false);

      // Random returns low value - should pass probability check
      vi.spyOn(Math, 'random').mockReturnValue(0.1);
      expect(shouldActorPost(null, 0, offPeakHour)).toBe(true);
    });

    it('should always pass probability check during peak hours', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.99);

      const result = shouldActorPost(null, 0, 12); // Noon, peak hour
      expect(result).toBe(true);
    });

    it('should check all conditions in order', () => {
      // Even with good timing and probability, daily limit should block
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const oldPost = new Date(Date.now() - 3600000); // 1 hour ago

      expect(
        shouldActorPost(oldPost, CONTENT_PACING.maxPostsPerActorPerDay, 12)
      ).toBe(false);
    });
  });

  describe('calculatePostsForTick', () => {
    it('should return 0 for 0 eligible actors', () => {
      expect(calculatePostsForTick(0)).toBe(0);
    });

    it('should not exceed maxPostsPerTick', () => {
      // Even with 1000 eligible actors
      const result = calculatePostsForTick(1000);
      expect(result).toBeLessThanOrEqual(CONTENT_PACING.maxPostsPerTick);
    });

    it('should not exceed eligible actor count', () => {
      // With only 1 eligible actor
      const result = calculatePostsForTick(1);
      expect(result).toBeLessThanOrEqual(1);
    });

    it('should calculate based on target posts per hour', () => {
      // With 60 ticks per hour and 12 posts/hour target = 0.2 posts/tick
      // Ceil(0.2) = 1 post per tick
      const result = calculatePostsForTick(10, 60);
      expect(result).toBeGreaterThan(0);
    });

    it('should scale with different tick rates', () => {
      // Fewer ticks per hour = more posts per tick
      const fast = calculatePostsForTick(10, 60); // 1-minute ticks
      const slow = calculatePostsForTick(10, 6); // 10-minute ticks

      // With slower tick rate, should calculate more posts per tick
      expect(slow).toBeGreaterThanOrEqual(fast);
    });
  });

  describe('isNewDay', () => {
    it('should return false for same day', () => {
      const now = new Date();
      expect(isNewDay(now, now)).toBe(false);

      // Same day, different times
      const morning = new Date('2025-01-04T08:00:00Z');
      const evening = new Date('2025-01-04T20:00:00Z');
      expect(isNewDay(morning, evening)).toBe(false);
    });

    it('should return true for different days', () => {
      const yesterday = new Date('2025-01-03T12:00:00Z');
      const today = new Date('2025-01-04T12:00:00Z');
      expect(isNewDay(yesterday, today)).toBe(true);
    });

    it('should handle year boundaries', () => {
      // Use dates that are clearly in different calendar years in any timezone
      const endOfYear = new Date(2024, 11, 30, 12, 0, 0); // Dec 30, 2024 noon local
      const newYear = new Date(2025, 0, 2, 12, 0, 0); // Jan 2, 2025 noon local
      expect(isNewDay(endOfYear, newYear)).toBe(true);
    });

    it('should handle month boundaries', () => {
      // Use dates clearly in different months in any timezone
      const endOfMonth = new Date(2025, 0, 30, 12, 0, 0); // Jan 30 noon local
      const nextMonth = new Date(2025, 1, 2, 12, 0, 0); // Feb 2 noon local
      expect(isNewDay(endOfMonth, nextMonth)).toBe(true);
    });

    it('should use current time when no second argument provided', () => {
      const veryOldDate = new Date('2020-01-01');
      expect(isNewDay(veryOldDate)).toBe(true);
    });

    it('should detect day change at midnight', () => {
      // Use local time constructor to avoid timezone issues
      const justBeforeMidnight = new Date(2025, 0, 4, 23, 59, 59);
      const justAfterMidnight = new Date(2025, 0, 5, 0, 0, 1);
      expect(isNewDay(justBeforeMidnight, justAfterMidnight)).toBe(true);
    });
  });
});
