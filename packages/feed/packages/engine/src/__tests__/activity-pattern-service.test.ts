/**
 * Activity Pattern Service Test Suite
 *
 * Tests for simplified NPC activity patterns based on ID hash rotation.
 * Each actor is active for ACTIVE_HOURS_PER_DAY hours per day, rotating based on ID hash + game day.
 */

import { describe, expect, test } from "bun:test";
import {
  ACTIVE_HOURS_PER_DAY,
  type ActivityActor,
  activityPatternService,
  convertToLocalHour,
  deriveActivityPattern,
  getActivityMultiplier,
  isActiveHour,
  isWeekend,
} from "../services/activity-pattern-service";

describe("Activity Pattern Service - Timezone Conversion", () => {
  test("convertToLocalHour returns UTC hour unchanged (simplified implementation)", () => {
    // Simplified: no timezone conversion, always returns input
    expect(convertToLocalHour(12, "UTC")).toBe(12);
    expect(convertToLocalHour(0, "UTC")).toBe(0);
    expect(convertToLocalHour(23, "UTC")).toBe(23);
  });

  test("convertToLocalHour ignores timezone parameter", () => {
    // Simplified implementation ignores timezone
    expect(convertToLocalHour(17, "America/New_York")).toBe(17);
    expect(convertToLocalHour(0, "Asia/Tokyo")).toBe(0);
    expect(convertToLocalHour(3, "Europe/London")).toBe(3);
  });
});

describe("Activity Pattern Service - Pattern Derivation", () => {
  test("deriveActivityPattern returns UTC timezone for all actors", () => {
    const actor: ActivityActor = { id: "test-1" };
    const pattern = deriveActivityPattern(actor);

    expect(pattern.timezone).toBe("UTC");
    expect(pattern.peakHours.length).toBe(ACTIVE_HOURS_PER_DAY);
  });

  test("deriveActivityPattern returns consistent hours for same actor ID", () => {
    const actor: ActivityActor = { id: "test-actor-123", domain: ["crypto"] };
    const pattern1 = deriveActivityPattern(actor, 1);
    const pattern2 = deriveActivityPattern(actor, 1);

    // Same actor, same game day = same hours
    expect(pattern1.peakHours).toEqual(pattern2.peakHours);
  });

  test("deriveActivityPattern changes hours based on game day", () => {
    const actor: ActivityActor = { id: "test-actor-123" };
    const patternDay1 = deriveActivityPattern(actor, 1);
    const patternDay2 = deriveActivityPattern(actor, 2);

    // Different game days = different peak hours
    expect(patternDay1.peakHours).not.toEqual(patternDay2.peakHours);
  });

  test("deriveActivityPattern always returns ACTIVE_HOURS_PER_DAY consecutive hours", () => {
    const actor: ActivityActor = { id: "test-actor-xyz" };
    const pattern = deriveActivityPattern(actor);

    expect(pattern.peakHours.length).toBe(ACTIVE_HOURS_PER_DAY);
    // Hours should be consecutive (modulo 24)
    for (let i = 1; i < pattern.peakHours.length; i++) {
      const expected = (pattern.peakHours[i - 1]! + 1) % 24;
      expect(pattern.peakHours[i]).toBe(expected);
    }
  });

  test("deriveActivityPattern ignores domain and personality (simplified)", () => {
    const financeActor: ActivityActor = { id: "actor-1", domain: ["finance"] };
    const cryptoActor: ActivityActor = { id: "actor-1", domain: ["crypto"] };
    const withPersonality: ActivityActor = {
      id: "actor-1",
      personality: "night owl degen",
    };

    // All should have same pattern since they have same ID
    const p1 = deriveActivityPattern(financeActor);
    const p2 = deriveActivityPattern(cryptoActor);
    const p3 = deriveActivityPattern(withPersonality);

    expect(p1.peakHours).toEqual(p2.peakHours);
    expect(p2.peakHours).toEqual(p3.peakHours);
  });

  test("deriveActivityPattern sets all activity flags to true", () => {
    const actor: ActivityActor = { id: "test-1" };
    const pattern = deriveActivityPattern(actor);

    expect(pattern.nightOwl).toBe(true);
    expect(pattern.workaholic).toBe(true);
    expect(pattern.weekendActive).toBe(true);
  });
});

describe("Activity Pattern Service - Active Hour Check", () => {
  test("isActiveHour returns true during active hours", () => {
    const actor: ActivityActor = { id: "test-actor-1" };
    const pattern = deriveActivityPattern(actor, 1);

    // Should be active during peak hours
    for (const hour of pattern.peakHours) {
      expect(isActiveHour(actor, hour, 1)).toBe(true);
    }
  });

  test("isActiveHour returns false during inactive hours", () => {
    const actor: ActivityActor = { id: "test-actor-1" };
    const pattern = deriveActivityPattern(actor, 1);
    const inactiveHours = Array.from({ length: 24 }, (_, i) => i).filter(
      (h) => !pattern.peakHours.includes(h),
    );

    // Should be inactive during non-peak hours
    for (const hour of inactiveHours) {
      expect(isActiveHour(actor, hour, 1)).toBe(false);
    }
  });

  test("isActiveHour respects game day parameter", () => {
    const actor: ActivityActor = { id: "test-actor-1" };

    // Activity varies by game day (use valid gameDay values >= 1)
    const day1Active = Array.from({ length: 24 }, (_, h) =>
      isActiveHour(actor, h, 1),
    );
    const day2Active = Array.from({ length: 24 }, (_, h) =>
      isActiveHour(actor, h, 2),
    );

    // At least some hours should differ between days
    expect(day1Active).not.toEqual(day2Active);
  });
});

describe("Activity Pattern Service - Weekend Detection", () => {
  test("isWeekend with gameDay uses game-relative week", () => {
    // Game days are 1-indexed: (gameDay - 1) % 7 determines day of week
    // Weekends are when dayOfWeek is 5 or 6
    // Day 1: (1-1) % 7 = 0 = weekday
    // Day 6: (6-1) % 7 = 5 = weekend
    // Day 7: (7-1) % 7 = 6 = weekend
    expect(isWeekend(6)).toBe(true); // Day 6 = weekend
    expect(isWeekend(7)).toBe(true); // Day 7 = weekend
    expect(isWeekend(1)).toBe(false); // Day 1 = weekday
    expect(isWeekend(5)).toBe(false); // Day 5 = weekday (index 4)
    expect(isWeekend(4)).toBe(false); // Day 4 = weekday
    expect(isWeekend(13)).toBe(true); // Day 13: (13-1) % 7 = 5 = weekend
  });

  test("isWeekend without gameDay falls back to real calendar", () => {
    const saturday = new Date("2026-01-03T12:00:00Z"); // Saturday
    expect(isWeekend(undefined, saturday)).toBe(true);

    const monday = new Date("2026-01-05T12:00:00Z"); // Monday
    expect(isWeekend(undefined, monday)).toBe(false);
  });
});

describe("Activity Pattern Service - Activity Multiplier", () => {
  test("getActivityMultiplier returns 1.0 during active hours", () => {
    const actor: ActivityActor = { id: "test-1" };
    const pattern = deriveActivityPattern(actor, 1);

    // Create a date during one of the peak hours
    const activeHour = pattern.peakHours[0]!;
    const date = new Date(
      `2026-01-05T${String(activeHour).padStart(2, "0")}:00:00Z`,
    );
    const multiplier = getActivityMultiplier(actor, date, 1);

    expect(multiplier).toBe(1.0);
  });

  test("getActivityMultiplier returns 0.0 during inactive hours", () => {
    const actor: ActivityActor = { id: "test-1" };
    const pattern = deriveActivityPattern(actor, 1);
    const inactiveHours = Array.from({ length: 24 }, (_, i) => i).filter(
      (h) => !pattern.peakHours.includes(h),
    );

    if (inactiveHours.length > 0) {
      const inactiveHour = inactiveHours[0]!;
      const date = new Date(
        `2026-01-05T${String(inactiveHour).padStart(2, "0")}:00:00Z`,
      );
      const multiplier = getActivityMultiplier(actor, date, 1);

      expect(multiplier).toBe(0.0);
    }
  });

  test("activityPatternService singleton works correctly", () => {
    const actor: ActivityActor = { id: "test-1" };

    const pattern = activityPatternService.derivePattern(actor);
    expect(pattern.timezone).toBe("UTC");
    expect(pattern.peakHours.length).toBe(ACTIVE_HOURS_PER_DAY);

    const isActive = activityPatternService.isActiveHour(actor, 12);
    expect(typeof isActive).toBe("boolean");

    const multiplier = activityPatternService.getMultiplier(actor);
    expect([0, 1]).toContain(multiplier); // Binary: 0 or 1
  });
});

describe("Activity Pattern Service - Edge Cases", () => {
  test("handles actor with empty domain array", () => {
    const actor: ActivityActor = { id: "test-1", domain: [] };
    const pattern = deriveActivityPattern(actor);

    expect(pattern.timezone).toBe("UTC");
    expect(pattern.peakHours.length).toBe(ACTIVE_HOURS_PER_DAY);
  });

  test("different actor IDs produce different activity windows", () => {
    // Test that the hash function provides reasonable distribution across actor IDs
    // Generate N different actor IDs and count how often peak hours differ
    const sampleSize = 100;
    let differentCount = 0;

    // Use a fixed reference pattern
    const referenceActor: ActivityActor = { id: "reference-actor-0" };
    const referencePattern = deriveActivityPattern(referenceActor);

    for (let i = 1; i <= sampleSize; i++) {
      const testActor: ActivityActor = { id: `test-actor-${i}-${i * 7919}` }; // Use prime multiplier for variety
      const testPattern = deriveActivityPattern(testActor);

      // Compare the starting peak hour (determines the activity window)
      if (testPattern.peakHours[0] !== referencePattern.peakHours[0]) {
        differentCount++;
      }
    }

    // With 24 possible starting hours, we expect roughly (23/24) ≈ 95.8% to differ
    // Allow for reasonable variance: at least 70% should be different
    const differenceRate = differentCount / sampleSize;
    expect(differenceRate).toBeGreaterThan(0.7);
  });

  test("handles very large game day numbers", () => {
    const actor: ActivityActor = { id: "test-1" };
    const pattern = deriveActivityPattern(actor, 1000);

    expect(pattern.peakHours.length).toBe(ACTIVE_HOURS_PER_DAY);
    // Hours should still be valid (0-23)
    for (const hour of pattern.peakHours) {
      expect(hour).toBeGreaterThanOrEqual(0);
      expect(hour).toBeLessThan(24);
    }
  });
});
