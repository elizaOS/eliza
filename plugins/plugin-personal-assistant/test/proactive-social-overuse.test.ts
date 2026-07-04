// Exercises LifeOps owner workflows, connector boundaries, and scheduled-task behavior.
import { describe, expect, it } from "vitest";
import {
  planSocialOveruseCheck,
  SOCIAL_OVERUSE_COOLDOWN_MS,
  selectTargetPlatform,
} from "../src/activity-profile/proactive-planner.js";
import type { ActivityProfile } from "../src/activity-profile/types.js";

/**
 * Proactive social-overuse nudge logic (#8795). It must fire only when the user
 * is awake, has crossed the usage threshold, and isn't in cooldown — and pick
 * the right platform. Over-firing here is real nagging, so the gates are pinned.
 */

const NOW = new Date("2026-06-23T12:00:00Z");

const profile = (o: Partial<ActivityProfile>): ActivityProfile =>
  ({
    isCurrentlySleeping: false,
    isCurrentlyActive: true,
    lastSeenPlatform: "discord",
    primaryPlatform: "client_chat",
    ...o,
  }) as unknown as ActivityProfile;

// biome-ignore lint/suspicious/noExplicitAny: minimal slim stand-ins.
const summary = (totalMinutes: number): any => ({
  totalSeconds: totalMinutes * 60,
  services: [{ label: "Instagram", totalSeconds: totalMinutes * 60 }],
});

describe("selectTargetPlatform", () => {
  it("prefers the current platform when active, else the primary", () => {
    expect(selectTargetPlatform(profile({}), true)).toBe("discord");
    expect(
      selectTargetPlatform(profile({ isCurrentlyActive: false }), true),
    ).toBe("client_chat");
    expect(selectTargetPlatform(profile({}), false)).toBe("client_chat");
    expect(
      selectTargetPlatform(
        profile({ primaryPlatform: undefined, isCurrentlyActive: false }),
        true,
      ),
    ).toBe("client_chat");
  });
});

describe("planSocialOveruseCheck", () => {
  it("does not fire while sleeping or under threshold", () => {
    expect(
      planSocialOveruseCheck(
        profile({ isCurrentlySleeping: true }),
        summary(120),
        null,
        "UTC",
        NOW,
      ),
    ).toBeNull();
    expect(
      planSocialOveruseCheck(profile({}), summary(30), null, "UTC", NOW),
    ).toBeNull();
  });

  it("fires once over threshold when not in cooldown", () => {
    const action = planSocialOveruseCheck(
      profile({}),
      summary(90),
      null,
      "UTC",
      NOW,
    );
    expect(action).not.toBeNull();
    expect(action?.kind).toBe("social_overuse_check");
    expect(action?.targetPlatform).toBe("discord");
    expect(action?.messageText).toMatch(/90m/);
    expect(action?.status).toBe("pending");
  });

  it("respects the cooldown window", () => {
    const recentlyFired = {
      socialOveruseCheckedAt: NOW.getTime() - SOCIAL_OVERUSE_COOLDOWN_MS / 2,
    };
    expect(
      planSocialOveruseCheck(
        profile({}),
        summary(90),
        recentlyFired as never,
        "UTC",
        NOW,
      ),
    ).toBeNull();

    const longAgo = {
      socialOveruseCheckedAt: NOW.getTime() - SOCIAL_OVERUSE_COOLDOWN_MS * 2,
    };
    expect(
      planSocialOveruseCheck(
        profile({}),
        summary(90),
        longAgo as never,
        "UTC",
        NOW,
      ),
    ).not.toBeNull();
  });
});
