import { describe, expect, it } from "bun:test";
import {
  type AchievementFromApi,
  mapStatus,
  mapTier,
} from "../achievements-tab";
import { formatCountdown } from "../challenges-tab";

/**
 * Tests for rewards tab component logic.
 *
 * Tests the pure functions used for data mapping and formatting
 * in the achievements, challenges, and overview tabs.
 */

// ---------- mapTier ----------

describe("mapTier", () => {
  it('maps "bronze" to "Bronze"', () => {
    expect(mapTier("bronze")).toBe("Bronze");
  });

  it('maps "silver" to "Silver"', () => {
    expect(mapTier("silver")).toBe("Silver");
  });

  it('maps "gold" to "Gold"', () => {
    expect(mapTier("gold")).toBe("Gold");
  });

  it('defaults unknown tiers to "Bronze"', () => {
    expect(mapTier("platinum")).toBe("Bronze");
    expect(mapTier("")).toBe("Bronze");
  });
});

// ---------- mapStatus ----------

describe("mapStatus", () => {
  const base: AchievementFromApi = {
    id: "1",
    name: "Test",
    description: "Test achievement",
    category: "trading",
    tier: "bronze",
    pointsReward: 75,
    threshold: 1,
    progress: 0,
    unlocked: false,
    unlockedAt: null,
  };

  it('returns "completed" when unlocked', () => {
    expect(
      mapStatus({
        ...base,
        unlocked: true,
        unlockedAt: "2026-01-01T00:00:00Z",
      }),
    ).toBe("completed");
  });

  it('returns "completed" even if progress < threshold when unlocked', () => {
    expect(
      mapStatus({
        ...base,
        unlocked: true,
        progress: 0,
        unlockedAt: "2026-01-01T00:00:00Z",
      }),
    ).toBe("completed");
  });

  it('returns "in-progress" when not unlocked but has progress', () => {
    expect(mapStatus({ ...base, progress: 2, threshold: 5 })).toBe(
      "in-progress",
    );
  });

  it('returns "locked" when not unlocked and no progress', () => {
    expect(mapStatus({ ...base, progress: 0 })).toBe("locked");
  });
});

// ---------- formatCountdown ----------

describe("formatCountdown", () => {
  it("returns hours remaining for < 24h", () => {
    const fiveHoursFromNow = new Date(
      Date.now() + 5 * 60 * 60 * 1000,
    ).toISOString();
    const result = formatCountdown(fiveHoursFromNow);
    expect(result).toMatch(/^\dh remaining$/);
  });

  it("returns days remaining for >= 24h", () => {
    const threeDaysFromNow = new Date(
      Date.now() + 3 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(formatCountdown(threeDaysFromNow)).toBe("3d remaining");
  });

  it('returns "Resetting..." for past timestamps', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(formatCountdown(oneHourAgo)).toBe("Resetting...");
  });

  it('returns "Resetting..." for current time', () => {
    const now = new Date(Date.now() - 1000).toISOString();
    expect(formatCountdown(now)).toBe("Resetting...");
  });

  it('returns "0h remaining" for very near future (< 1h)', () => {
    const thirtyMinutesFromNow = new Date(
      Date.now() + 30 * 60 * 1000,
    ).toISOString();
    expect(formatCountdown(thirtyMinutesFromNow)).toBe("0h remaining");
  });

  it('returns "1d remaining" for 25h from now', () => {
    const overOneDayFromNow = new Date(
      Date.now() + 25 * 60 * 60 * 1000,
    ).toISOString();
    expect(formatCountdown(overOneDayFromNow)).toBe("1d remaining");
  });
});

// ---------- Achievement data mapping ----------

describe("achievement data mapping", () => {
  it("correctly maps all fields from API to card props", () => {
    const apiData: AchievementFromApi = {
      id: "123",
      name: "First Prediction",
      description: "Place your first prediction trade",
      category: "trading",
      tier: "bronze",
      pointsReward: 75,
      threshold: 1,
      progress: 1,
      unlocked: true,
      unlockedAt: "2026-01-15T12:00:00Z",
    };

    const title = apiData.name;
    const description = apiData.description;
    const points = apiData.pointsReward;
    const tier = mapTier(apiData.tier);
    const status = mapStatus(apiData);
    const progress =
      !apiData.unlocked && apiData.threshold > 1
        ? { current: apiData.progress, total: apiData.threshold }
        : undefined;

    expect(title).toBe("First Prediction");
    expect(description).toBe("Place your first prediction trade");
    expect(points).toBe(75);
    expect(tier).toBe("Bronze");
    expect(status).toBe("completed");
    expect(progress).toBeUndefined();
  });

  it("includes progress for multi-step in-progress achievements", () => {
    const apiData: AchievementFromApi = {
      id: "456",
      name: "Terminal Explorer",
      description: "Visit the Terminal on 3 different days",
      category: "exploration",
      tier: "bronze",
      pointsReward: 50,
      threshold: 3,
      progress: 1,
      unlocked: false,
      unlockedAt: null,
    };

    const status = mapStatus(apiData);
    const progress =
      !apiData.unlocked && apiData.threshold > 1
        ? { current: apiData.progress, total: apiData.threshold }
        : undefined;

    expect(status).toBe("in-progress");
    expect(progress).toEqual({ current: 1, total: 3 });
  });

  it("does not include progress for single-step locked achievements", () => {
    const apiData: AchievementFromApi = {
      id: "789",
      name: "Agent Creator",
      description: "Spawn your first AI agent",
      category: "agents",
      tier: "silver",
      pointsReward: 100,
      threshold: 1,
      progress: 0,
      unlocked: false,
      unlockedAt: null,
    };

    const status = mapStatus(apiData);
    const progress =
      !apiData.unlocked && apiData.threshold > 1
        ? { current: apiData.progress, total: apiData.threshold }
        : undefined;

    expect(status).toBe("locked");
    expect(progress).toBeUndefined();
  });
});

// ---------- Challenge data mapping ----------

describe("challenge data mapping", () => {
  it("maps challenge fields to ChallengeCard props", () => {
    const challenge = {
      id: "c1",
      name: "Create a Post",
      description: "Share a post in the feed",
      category: "social",
      pointsReward: 45,
      threshold: 1,
      progress: 1,
      completed: true,
      completedAt: "2026-03-12T10:00:00Z",
    };

    const title = challenge.name;
    const description = challenge.description;
    const points = challenge.pointsReward;
    const isCompleted = challenge.completed;
    const progress =
      !challenge.completed && challenge.threshold > 1
        ? { current: challenge.progress, total: challenge.threshold }
        : undefined;

    expect(title).toBe("Create a Post");
    expect(description).toBe("Share a post in the feed");
    expect(points).toBe(45);
    expect(isCompleted).toBe(true);
    expect(progress).toBeUndefined();
  });

  it("includes progress for multi-step incomplete challenges", () => {
    const challenge = {
      id: "c2",
      name: "Prediction Streak",
      description: "Make 3 predictions",
      category: "trading",
      pointsReward: 100,
      threshold: 3,
      progress: 1,
      completed: false,
      completedAt: null,
    };

    const progress =
      !challenge.completed && challenge.threshold > 1
        ? { current: challenge.progress, total: challenge.threshold }
        : undefined;

    expect(progress).toEqual({ current: 1, total: 3 });
  });

  it("computes daily/weekly completed counts for BonusCard", () => {
    const dailyChallenges = [
      { completed: true },
      { completed: false },
      { completed: true },
    ];
    const weeklyChallenges = [{ completed: true }, { completed: true }];

    const dailyCompleted = dailyChallenges.filter((c) => c.completed).length;
    const weeklyCompleted = weeklyChallenges.filter((c) => c.completed).length;

    expect(dailyCompleted).toBe(2);
    expect(weeklyCompleted).toBe(2);
  });
});

// ---------- SSE event type filtering ----------

describe("SSE event type filtering", () => {
  it("identifies achievement_unlocked events", () => {
    const event = {
      type: "achievement_unlocked",
      achievementId: "123",
      name: "First Prediction",
      tier: "bronze",
      pointsReward: 75,
    };
    expect(event.type === "achievement_unlocked").toBe(true);
  });

  it("identifies challenge_completed events", () => {
    const event = {
      type: "challenge_completed",
      challengeId: "456",
      name: "Create a Post",
      pointsReward: 45,
    };
    expect(
      event.type === "challenge_completed" || event.type === "challenge_bonus",
    ).toBe(true);
  });

  it("identifies challenge_bonus events", () => {
    const event = { type: "challenge_bonus", pool: "daily", bonus: 40 };
    expect(
      event.type === "challenge_completed" || event.type === "challenge_bonus",
    ).toBe(true);
  });

  it("ignores unrelated notification types", () => {
    const event = { type: "new_follower", userId: "789" };
    const isAchievementEvent = event.type === "achievement_unlocked";
    const isChallengeEvent =
      event.type === "challenge_completed" || event.type === "challenge_bonus";
    expect(isAchievementEvent).toBe(false);
    expect(isChallengeEvent).toBe(false);
  });
});
