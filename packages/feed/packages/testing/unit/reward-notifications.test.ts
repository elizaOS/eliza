import { describe, expect, test } from "bun:test";
import {
  buildAchievementUnlockedNotification,
  buildChallengeCompletedNotification,
} from "@feed/shared";

describe("reward notification builders", () => {
  test("builds achievement notification copy with structured data", () => {
    const notification = buildAchievementUnlockedNotification({
      achievementId: "achievement-1",
      achievementName: "Macro Hunter",
      tier: "epic",
      pointsReward: 250,
      iconKey: "macro-hunter",
    });

    expect(notification).toEqual({
      title: "Achievement Unlocked: Macro Hunter",
      message: "Epic tier - +250 points",
      data: {
        kind: "achievement_unlocked",
        achievementId: "achievement-1",
        achievementName: "Macro Hunter",
        tier: "epic",
        pointsReward: 250,
        iconKey: "macro-hunter",
      },
    });
  });

  test("builds challenge notification copy with structured data", () => {
    const notification = buildChallengeCompletedNotification({
      challengeId: "challenge-1",
      challengeName: "3 Winning Trades",
      pointsReward: 40,
      periodKey: "2026-03-26",
      iconKey: "winning-trades",
    });

    expect(notification).toEqual({
      title: "Challenge Complete: 3 Winning Trades",
      message: "+40 points",
      data: {
        kind: "challenge_completed",
        challengeId: "challenge-1",
        challengeName: "3 Winning Trades",
        pointsReward: 40,
        periodKey: "2026-03-26",
        iconKey: "winning-trades",
      },
    });
  });
});
