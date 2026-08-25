import { describe, expect, it, vi } from "vitest";

vi.mock("./task-definitions.js", () => ({
  compileTaskDefinition: (definition: object) => ({ ...definition }),
}));

import {
  deriveQuietObservations,
  QUIET_THRESHOLD_DAYS,
  QUIET_USER_WATCHER_PACK_KEY,
  quietStreakDaysFromObservations,
  quietUserWatcherPack,
  runQuietUserWatcher,
} from "./quiet-user-watcher.js";

function streak(
  kind: "checkin" | "followup",
  outcome: "expired" | "skipped" | "replied",
  consecutive: number,
) {
  return { kind, outcome, consecutive };
}

describe("deriveQuietObservations", () => {
  it("flags a streak at the default 3-day threshold", () => {
    const observations = deriveQuietObservations({
      streaks: [streak("checkin", "expired", 3)],
    });
    expect(observations).toContainEqual({
      kind: "quiet_for_days",
      days: 3,
      detail: "3 consecutive checkins without reply",
    });
  });

  it("does not flag a streak below the threshold", () => {
    const observations = deriveQuietObservations({
      streaks: [streak("checkin", "expired", 2)],
    });
    expect(observations).not.toContainEqual(
      expect.objectContaining({ kind: "quiet_for_days" }),
    );
  });

  it("counts expired followup streaks toward quiet", () => {
    const observations = deriveQuietObservations({
      streaks: [streak("followup", "expired", 3)],
    });
    expect(observations).toContainEqual(
      expect.objectContaining({ kind: "quiet_for_days", days: 3 }),
    );
  });

  it("counts skipped streaks toward quiet", () => {
    const observations = deriveQuietObservations({
      streaks: [streak("checkin", "skipped", 4)],
    });
    expect(observations).toContainEqual(
      expect.objectContaining({ kind: "quiet_for_days", days: 4 }),
    );
  });

  it("honors an explicit threshold override", () => {
    const observations = deriveQuietObservations(
      { streaks: [streak("checkin", "expired", 1)] },
      { thresholdDays: 1 },
    );
    expect(observations).toContainEqual(
      expect.objectContaining({ kind: "quiet_for_days", days: 1 }),
    );
  });

  it("reports only the first quiet streak", () => {
    const observations = deriveQuietObservations({
      streaks: [
        streak("checkin", "expired", 5),
        streak("followup", "skipped", 4),
      ],
    });
    const quiet = observations.filter((o) => o.kind === "quiet_for_days");
    expect(quiet).toHaveLength(1);
    expect(quiet[0].days).toBe(5);
  });

  it("surfaces missed-yesterday for an expired checkin streak", () => {
    const observations = deriveQuietObservations({
      streaks: [streak("checkin", "expired", 1)],
    });
    expect(observations).toContainEqual({
      kind: "missed_yesterday_checkin",
      detail: "yesterday's check-in expired without reply",
    });
  });

  it("surfaces missed-yesterday for a skipped checkin streak", () => {
    // Regression: the pack contract says expired OR skipped terminal states
    // mean the owner missed yesterday's check-in; skipped was previously
    // ignored by this loop.
    const observations = deriveQuietObservations({
      streaks: [streak("checkin", "skipped", 1)],
    });
    expect(observations).toContainEqual({
      kind: "missed_yesterday_checkin",
      detail: "yesterday's check-in expired without reply",
    });
  });

  it("does not surface missed-yesterday for a skipped followup", () => {
    const observations = deriveQuietObservations({
      streaks: [streak("followup", "skipped", 2)],
    });
    expect(observations).not.toContainEqual(
      expect.objectContaining({ kind: "missed_yesterday_checkin" }),
    );
  });

  it("returns no observations for replied streaks", () => {
    const observations = deriveQuietObservations({
      streaks: [streak("checkin", "replied", 3)],
    });
    expect(observations).toEqual([]);
  });
});

describe("quietStreakDaysFromObservations", () => {
  it("extracts the quiet streak days", () => {
    expect(
      quietStreakDaysFromObservations([
        { kind: "quiet_for_days", days: 4, detail: "" },
      ]),
    ).toBe(4);
  });

  it("returns undefined when not quiet", () => {
    expect(
      quietStreakDaysFromObservations([
        {
          kind: "missed_yesterday_checkin",
          detail: "yesterday's check-in expired without reply",
        },
      ]),
    ).toBeUndefined();
  });
});

describe("runQuietUserWatcher", () => {
  it("asks the provider for checkin/followup states and derives observations", async () => {
    const provider = {
      summarize: vi.fn(async () => ({
        streaks: [streak("checkin", "expired", 3)],
      })),
    };
    const observations = await runQuietUserWatcher(provider as never, {
      thresholdDays: 2,
      asOf: new Date("2026-08-10T08:00:00.000Z"),
    });
    expect(provider.summarize).toHaveBeenCalledWith({
      kinds: ["checkin", "followup"],
      lookbackDays: 7,
      asOf: new Date("2026-08-10T08:00:00.000Z"),
    });
    expect(observations).toContainEqual(
      expect.objectContaining({ kind: "quiet_for_days", days: 3 }),
    );
  });
});

describe("pack wiring", () => {
  it("exposes the pack key and a 3-day default threshold", () => {
    expect(QUIET_USER_WATCHER_PACK_KEY).toBe("quiet-user-watcher");
    expect(QUIET_THRESHOLD_DAYS).toBe(3);
    expect(quietUserWatcherPack.records[0].metadata.quietThresholdDays).toBe(3);
  });
});
