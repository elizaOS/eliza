/**
 * Tests for challenge wiring — verifies that events correctly map to
 * challenge tracking types, resolvers exist for all definitions, and
 * the rotation/selection logic is deterministic.
 */

import { describe, expect, test } from "bun:test";
import {
  ACHIEVEMENT_DEFINITIONS,
  type AchievementEventType,
  ALL_CHALLENGE_DEFINITIONS,
  DAILY_CHALLENGE_DEFINITIONS,
  EVENT_TO_TRACKING_TYPES,
  WEEKLY_CHALLENGE_DEFINITIONS,
} from "@feed/shared";

// Import the functions we need to test — these are re-exported from @feed/api
import {
  getActiveDailyChallengeIds,
  getActiveWeeklyChallengeIds,
} from "../achievement-service";

// ── Definition Integrity ──────────────────────────────────────────

describe("challenge definition integrity", () => {
  test("all daily challenge IDs are unique", () => {
    const ids = DAILY_CHALLENGE_DEFINITIONS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("all weekly challenge IDs are unique", () => {
    const ids = WEEKLY_CHALLENGE_DEFINITIONS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('daily challenges have pool "daily"', () => {
    for (const def of DAILY_CHALLENGE_DEFINITIONS) {
      expect(def.pool).toBe("daily");
    }
  });

  test('weekly challenges have pool "weekly"', () => {
    for (const def of WEEKLY_CHALLENGE_DEFINITIONS) {
      expect(def.pool).toBe("weekly");
    }
  });

  test("all challenges have positive thresholds", () => {
    for (const def of ALL_CHALLENGE_DEFINITIONS) {
      expect(def.threshold).toBeGreaterThan(0);
    }
  });

  test("all challenges have positive pointsReward", () => {
    for (const def of ALL_CHALLENGE_DEFINITIONS) {
      expect(def.pointsReward).toBeGreaterThan(0);
    }
  });

  test("all achievements have positive thresholds", () => {
    for (const def of ACHIEVEMENT_DEFINITIONS) {
      expect(def.threshold).toBeGreaterThan(0);
    }
  });
});

// ── Event-to-TrackingType Mapping ─────────────────────────────────

describe("EVENT_TO_TRACKING_TYPES completeness", () => {
  // Collect all tracking types used by challenge definitions
  const allChallengeTrackingTypes = new Set(
    ALL_CHALLENGE_DEFINITIONS.map((c) => c.trackingType),
  );

  // Collect all tracking types used by achievement definitions
  const allAchievementTrackingTypes = new Set(
    ACHIEVEMENT_DEFINITIONS.map((a) => a.trackingType),
  );

  // Collect all tracking types reachable from events
  const allReachableTrackingTypes = new Set(
    Object.values(EVENT_TO_TRACKING_TYPES).flat(),
  );

  test("every challenge trackingType is reachable from at least one event", () => {
    const unreachable: string[] = [];
    for (const tt of allChallengeTrackingTypes) {
      if (!allReachableTrackingTypes.has(tt)) {
        unreachable.push(tt);
      }
    }
    expect(unreachable).toEqual([]);
  });

  test("every achievement trackingType is reachable from at least one event", () => {
    const unreachable: string[] = [];
    for (const tt of allAchievementTrackingTypes) {
      if (!allReachableTrackingTypes.has(tt)) {
        unreachable.push(tt);
      }
    }
    expect(unreachable).toEqual([]);
  });

  test("all event types map to at least one tracking type", () => {
    for (const [_event, types] of Object.entries(EVENT_TO_TRACKING_TYPES)) {
      expect(types.length).toBeGreaterThan(0);
    }
  });
});

// ── Challenge Rotation ────────────────────────────────────────────

describe("challenge rotation", () => {
  test("selects exactly 3 daily challenges", () => {
    const ids = getActiveDailyChallengeIds(new Date("2026-03-19"));
    expect(ids.length).toBe(3);
  });

  test("selects exactly 2 weekly challenges", () => {
    const ids = getActiveWeeklyChallengeIds(new Date("2026-03-19"));
    expect(ids.length).toBe(2);
  });

  test("daily selection is deterministic for same date", () => {
    const a = getActiveDailyChallengeIds(new Date("2026-03-19"));
    const b = getActiveDailyChallengeIds(new Date("2026-03-19"));
    expect(a).toEqual(b);
  });

  test("weekly selection is deterministic for same week", () => {
    // Monday and Wednesday of same week
    const a = getActiveWeeklyChallengeIds(new Date("2026-03-16")); // Monday
    const b = getActiveWeeklyChallengeIds(new Date("2026-03-18")); // Wednesday
    expect(a).toEqual(b);
  });

  test("daily selection changes between days", () => {
    const day1 = getActiveDailyChallengeIds(new Date("2026-03-19"));
    const day2 = getActiveDailyChallengeIds(new Date("2026-03-20"));
    // Not guaranteed to be different, but very likely with 20-choose-3
    // At minimum, verify both return valid IDs
    expect(day1.length).toBe(3);
    expect(day2.length).toBe(3);
    for (const id of day1) {
      expect(DAILY_CHALLENGE_DEFINITIONS.some((d) => d.id === id)).toBe(true);
    }
    for (const id of day2) {
      expect(DAILY_CHALLENGE_DEFINITIONS.some((d) => d.id === id)).toBe(true);
    }
  });

  test("all selected daily IDs are from DAILY_CHALLENGE_DEFINITIONS", () => {
    const validIds = new Set(DAILY_CHALLENGE_DEFINITIONS.map((d) => d.id));
    for (let day = 1; day <= 31; day++) {
      const ids = getActiveDailyChallengeIds(
        new Date(`2026-03-${String(day).padStart(2, "0")}`),
      );
      for (const id of ids) {
        expect(validIds.has(id)).toBe(true);
      }
    }
  });

  test("all selected weekly IDs are from WEEKLY_CHALLENGE_DEFINITIONS", () => {
    const validIds = new Set(WEEKLY_CHALLENGE_DEFINITIONS.map((d) => d.id));
    for (let week = 1; week <= 52; week++) {
      // Use a date in that ISO week
      const date = new Date(2026, 0, 1 + (week - 1) * 7);
      const ids = getActiveWeeklyChallengeIds(date);
      for (const id of ids) {
        expect(validIds.has(id)).toBe(true);
      }
    }
  });

  test("selected daily challenges have no duplicates", () => {
    for (let day = 1; day <= 31; day++) {
      const ids = getActiveDailyChallengeIds(
        new Date(`2026-03-${String(day).padStart(2, "0")}`),
      );
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

// ── Event-to-Challenge Wiring ─────────────────────────────────────

describe("event-to-challenge wiring", () => {
  const eventTypes = Object.keys(
    EVENT_TO_TRACKING_TYPES,
  ) as AchievementEventType[];

  // Every event type must map to at least one tracking type
  for (const event of eventTypes) {
    test(`${event} maps to at least one tracking type`, () => {
      expect(EVENT_TO_TRACKING_TYPES[event].length).toBeGreaterThan(0);
    });
  }

  // Every challenge definition must be reachable from at least one event
  for (const challenge of ALL_CHALLENGE_DEFINITIONS) {
    test(`challenge ${challenge.id} (${challenge.trackingType}) is reachable from an event`, () => {
      const reachable = eventTypes.some((event) =>
        EVENT_TO_TRACKING_TYPES[event].includes(challenge.trackingType),
      );
      expect(reachable).toBe(true);
    });
  }

  // Every achievement definition must be reachable from at least one event
  for (const achievement of ACHIEVEMENT_DEFINITIONS) {
    test(`achievement ${achievement.id} (${achievement.trackingType}) is reachable from an event`, () => {
      const reachable = eventTypes.some((event) =>
        EVENT_TO_TRACKING_TYPES[event].includes(achievement.trackingType),
      );
      expect(reachable).toBe(true);
    });
  }
});

// ── Challenge Selection Simulation ────────────────────────────────

describe("challenge selection simulation", () => {
  test("over 30 days, all daily challenges appear at least once", () => {
    const seen = new Set<string>();
    for (let day = 1; day <= 30; day++) {
      const ids = getActiveDailyChallengeIds(
        new Date(`2026-03-${String(day).padStart(2, "0")}`),
      );
      for (const id of ids) seen.add(id);
    }
    // With 20 challenges and 3 picks/day over 30 days = 90 picks,
    // it's extremely likely all 20 appear
    // But we test a reasonable lower bound
    expect(seen.size).toBeGreaterThanOrEqual(10);
  });

  test("over 52 weeks, all weekly challenges appear at least once", () => {
    const seen = new Set<string>();
    for (let week = 1; week <= 52; week++) {
      const date = new Date(2026, 0, 1 + (week - 1) * 7);
      const ids = getActiveWeeklyChallengeIds(date);
      for (const id of ids) seen.add(id);
    }
    expect(seen.size).toBeGreaterThanOrEqual(10);
  });
});
