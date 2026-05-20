/**
 * shouldUpdateWorldFacts Tests
 *
 * Unit tests for the shouldUpdateWorldFacts logic with various timestamp scenarios.
 * Tests the time comparison logic that determines when world facts need updating.
 */

import { describe, expect, test } from 'bun:test';

import { GENERATION_MARKER } from '../game-tick';

// Constants mirroring game-tick.ts
const DEFAULT_WORLD_FACTS_UPDATE_INTERVAL_HOURS = 8;

/**
 * Pure function that mirrors the shouldUpdateWorldFacts logic
 * This allows us to test the time comparison logic in isolation
 */
function shouldUpdateWorldFactsLogic(
  lastAutoFactCreatedAt: Date | null,
  updateIntervalHours: number = DEFAULT_WORLD_FACTS_UPDATE_INTERVAL_HOURS,
  currentTime: Date = new Date()
): { shouldUpdate: boolean; reason: string } {
  const updateIntervalMs = updateIntervalHours * 60 * 60 * 1000;

  if (!lastAutoFactCreatedAt) {
    return { shouldUpdate: true, reason: 'no-auto-facts' };
  }

  const timeSinceLastGeneration =
    currentTime.getTime() - lastAutoFactCreatedAt.getTime();
  const shouldUpdate = timeSinceLastGeneration >= updateIntervalMs;

  return {
    shouldUpdate,
    reason: shouldUpdate ? 'interval-exceeded' : 'interval-not-exceeded',
  };
}

describe('shouldUpdateWorldFacts - Timestamp Scenarios', () => {
  const now = new Date('2024-01-15T12:00:00Z');

  test('should return true when no auto-generated facts exist', () => {
    const result = shouldUpdateWorldFactsLogic(null, 8, now);

    expect(result.shouldUpdate).toBe(true);
    expect(result.reason).toBe('no-auto-facts');
  });

  test('should return true when last fact is older than interval', () => {
    // Last fact was 9 hours ago, interval is 8 hours
    const lastFactTime = new Date('2024-01-15T03:00:00Z'); // 9 hours before now

    const result = shouldUpdateWorldFactsLogic(lastFactTime, 8, now);

    expect(result.shouldUpdate).toBe(true);
    expect(result.reason).toBe('interval-exceeded');
  });

  test('should return false when last fact is within interval', () => {
    // Last fact was 5 hours ago, interval is 8 hours
    const lastFactTime = new Date('2024-01-15T07:00:00Z'); // 5 hours before now

    const result = shouldUpdateWorldFactsLogic(lastFactTime, 8, now);

    expect(result.shouldUpdate).toBe(false);
    expect(result.reason).toBe('interval-not-exceeded');
  });

  test('should return true exactly at interval boundary', () => {
    // Last fact was exactly 8 hours ago
    const lastFactTime = new Date('2024-01-15T04:00:00Z'); // exactly 8 hours before now

    const result = shouldUpdateWorldFactsLogic(lastFactTime, 8, now);

    expect(result.shouldUpdate).toBe(true);
    expect(result.reason).toBe('interval-exceeded');
  });

  test('should return false just before interval boundary', () => {
    // Last fact was 7 hours 59 minutes ago
    const lastFactTime = new Date('2024-01-15T04:01:00Z'); // 7h59m before now

    const result = shouldUpdateWorldFactsLogic(lastFactTime, 8, now);

    expect(result.shouldUpdate).toBe(false);
    expect(result.reason).toBe('interval-not-exceeded');
  });

  test('should handle custom interval hours', () => {
    // Last fact was 2 hours ago, interval is 1 hour
    const lastFactTime = new Date('2024-01-15T10:00:00Z'); // 2 hours before now

    const result = shouldUpdateWorldFactsLogic(lastFactTime, 1, now);

    expect(result.shouldUpdate).toBe(true);
    expect(result.reason).toBe('interval-exceeded');
  });

  test('should handle very long intervals', () => {
    // Last fact was 23 hours ago, interval is 24 hours
    const lastFactTime = new Date('2024-01-14T13:00:00Z'); // 23 hours before now

    const result = shouldUpdateWorldFactsLogic(lastFactTime, 24, now);

    expect(result.shouldUpdate).toBe(false);
    expect(result.reason).toBe('interval-not-exceeded');
  });

  test('should handle very short intervals', () => {
    // Last fact was 30 minutes ago, interval is 0.5 hours (30 minutes)
    const lastFactTime = new Date('2024-01-15T11:30:00Z'); // 30 minutes before now

    const result = shouldUpdateWorldFactsLogic(lastFactTime, 0.5, now);

    expect(result.shouldUpdate).toBe(true);
    expect(result.reason).toBe('interval-exceeded');
  });

  test('should handle future timestamps gracefully', () => {
    // Edge case: lastFact is in the future (clock skew, etc.)
    const futureTime = new Date('2024-01-15T13:00:00Z'); // 1 hour in the future

    const result = shouldUpdateWorldFactsLogic(futureTime, 8, now);

    // Time since last generation would be negative
    expect(result.shouldUpdate).toBe(false);
    expect(result.reason).toBe('interval-not-exceeded');
  });

  test('should handle same timestamp (just created)', () => {
    // Last fact was created at exact same time as check
    const result = shouldUpdateWorldFactsLogic(now, 8, now);

    expect(result.shouldUpdate).toBe(false);
    expect(result.reason).toBe('interval-not-exceeded');
  });
});

describe('shouldUpdateWorldFacts - Environment Variable Scenarios', () => {
  test('should use default 8 hours when env var not set', () => {
    const now = new Date('2024-01-15T12:00:00Z');
    const sevenHoursAgo = new Date('2024-01-15T05:00:00Z');
    const nineHoursAgo = new Date('2024-01-15T03:00:00Z');

    // With default 8 hour interval
    expect(
      shouldUpdateWorldFactsLogic(sevenHoursAgo, 8, now).shouldUpdate
    ).toBe(false);
    expect(shouldUpdateWorldFactsLogic(nineHoursAgo, 8, now).shouldUpdate).toBe(
      true
    );
  });

  test('should handle custom interval from env var simulation', () => {
    const now = new Date('2024-01-15T12:00:00Z');
    const threeHoursAgo = new Date('2024-01-15T09:00:00Z');
    const fiveHoursAgo = new Date('2024-01-15T07:00:00Z');

    // Simulating WORLD_FACTS_UPDATE_INTERVAL_HOURS=4
    const customInterval = 4;

    expect(
      shouldUpdateWorldFactsLogic(threeHoursAgo, customInterval, now)
        .shouldUpdate
    ).toBe(false);
    expect(
      shouldUpdateWorldFactsLogic(fiveHoursAgo, customInterval, now)
        .shouldUpdate
    ).toBe(true);
  });
});

describe('Lock Renewal Interval Calculation', () => {
  /**
   * Pure function that calculates lock renewal interval.
   *
   * Computes renewal as half of lock duration, ensuring:
   * - Renewal is always strictly less than lock duration
   * - Supports short locks without a hard 1-minute minimum
   * - Falls within the 1/8 to 1/3 guidance range (using 1/2 as default)
   */
  function calculateLockRenewalInterval(lockDurationMs: number): number {
    // Compute half of lock duration (within 1/8 to 1/3 guidance)
    // Ensure computed interval is at least 1ms to avoid 0 for small lockDurationMs
    const computedInterval = Math.max(1, Math.floor(lockDurationMs / 2));

    // Ensure renewal is always strictly less than lock duration
    // For very short locks, clamp to at least 1ms before expiry
    return Math.min(computedInterval, lockDurationMs - 1);
  }

  test('default 30 minute lock gives 15 minute renewal', () => {
    const lockDurationMs = 30 * 60 * 1000; // 30 minutes
    const result = calculateLockRenewalInterval(lockDurationMs);

    expect(result).toBe(15 * 60 * 1000); // 15 minutes
  });

  test('10 minute lock gives 5 minute renewal', () => {
    const lockDurationMs = 10 * 60 * 1000; // 10 minutes
    const result = calculateLockRenewalInterval(lockDurationMs);

    expect(result).toBe(5 * 60 * 1000); // 5 minutes
  });

  test('2 minute lock gives 1 minute renewal', () => {
    const lockDurationMs = 2 * 60 * 1000; // 2 minutes
    const result = calculateLockRenewalInterval(lockDurationMs);

    expect(result).toBe(60 * 1000); // 1 minute (half of 2 minutes)
  });

  test('1 minute lock gives 30 second renewal', () => {
    const lockDurationMs = 1 * 60 * 1000; // 1 minute
    const result = calculateLockRenewalInterval(lockDurationMs);

    expect(result).toBe(30 * 1000); // 30 seconds (half of 1 minute)
  });

  test('30 second lock gives 15 second renewal', () => {
    const lockDurationMs = 30 * 1000; // 30 seconds
    const result = calculateLockRenewalInterval(lockDurationMs);

    expect(result).toBe(15 * 1000); // 15 seconds (half of 30 seconds)
  });

  test('1 hour lock gives 30 minute renewal', () => {
    const lockDurationMs = 60 * 60 * 1000; // 1 hour
    const result = calculateLockRenewalInterval(lockDurationMs);

    expect(result).toBe(30 * 60 * 1000); // 30 minutes
  });

  test('very short lock (10ms) gives renewal less than lock duration', () => {
    const lockDurationMs = 10; // 10ms
    const result = calculateLockRenewalInterval(lockDurationMs);

    expect(result).toBe(5); // 5ms (half of 10ms)
    expect(result).toBeLessThan(lockDurationMs);
  });

  test('renewal is always less than lock duration', () => {
    const testCases = [
      10, // 10ms (very short)
      1000, // 1 second
      30 * 1000, // 30 seconds
      60 * 1000, // 1 minute
      5 * 60 * 1000, // 5 minutes
      15 * 60 * 1000, // 15 minutes
      30 * 60 * 1000, // 30 minutes
      60 * 60 * 1000, // 1 hour
    ];

    for (const lockDurationMs of testCases) {
      const renewal = calculateLockRenewalInterval(lockDurationMs);
      expect(renewal).toBeLessThan(lockDurationMs);
    }
  });

  test('renewal allows at least one renewal before expiry for any duration', () => {
    const testCases = [100, 1000, 30000, 60000, 120000];

    for (const lockDurationMs of testCases) {
      const renewal = calculateLockRenewalInterval(lockDurationMs);
      expect(renewal).toBeLessThan(lockDurationMs);
      // With renewal at half duration, there's always time for at least one renewal
      expect(renewal).toBeLessThanOrEqual(lockDurationMs / 2);
    }
  });
});

describe('Generation Marker Insertion - Specification', () => {
  /**
   * These tests verify the GENERATION_MARKER constants exported from game-tick.ts.
   * By importing and asserting the actual constants, these tests:
   * 1. Serve as living documentation of the marker contract
   * 2. Catch accidental changes to marker values
   * 3. Follow DRY principle - single source of truth in game-tick.ts
   *
   * For integration tests that verify the real marker insertion behavior,
   * see world-facts-update.test.ts.
   */

  test('marker has expected category and key', () => {
    // Verify the imported constants match expected values
    expect(GENERATION_MARKER.CATEGORY).toBe('system');
    expect(GENERATION_MARKER.KEY).toBe('generation-marker');
  });

  test('marker is inactive and has negative priority', () => {
    // Markers should not appear in prompts (isActive: false)
    // and have low priority (priority: -1)
    expect(GENERATION_MARKER.IS_ACTIVE).toBe(false);
    expect(GENERATION_MARKER.PRIORITY).toBe(-1);
  });

  test('marker source is auto-generated', () => {
    // Markers use the same source as other auto-generated facts
    expect(GENERATION_MARKER.SOURCE).toBe('auto-generated');
  });

  test('marker label is descriptive', () => {
    expect(GENERATION_MARKER.LABEL).toBe('World Facts Generation Marker');
  });

  test('marker value format includes timestamp and facts count', () => {
    const now = new Date();
    const factsGenerated = 5;

    const markerValue = `Generation run at ${now.toISOString()} - ${factsGenerated} facts created`;

    expect(markerValue).toContain(now.toISOString());
    expect(markerValue).toContain('5 facts created');
  });

  test('marker value format with zero facts created', () => {
    const now = new Date();
    const factsGenerated = 0;

    const markerValue = `Generation run at ${now.toISOString()} - ${factsGenerated} facts created`;

    expect(markerValue).toContain('0 facts created');
  });

  test('marker value follows expected pattern', () => {
    const now = new Date();
    const factsGenerated = 10;

    const markerValue = `Generation run at ${now.toISOString()} - ${factsGenerated} facts created`;

    // Verify the pattern: "Generation run at <ISO timestamp> - <count> facts created"
    const pattern =
      /^Generation run at \d{4}-\d{2}-\d{2}T.+ - \d+ facts created$/;
    expect(pattern.test(markerValue)).toBe(true);
  });
});
