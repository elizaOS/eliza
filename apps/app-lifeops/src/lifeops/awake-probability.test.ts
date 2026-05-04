import type {
  LifeOpsActivitySignal,
  LifeOpsScheduleRegularity,
  LifeOpsSleepCycle,
} from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { computeAwakeProbability } from "./awake-probability.js";
import type { LifeOpsActivityWindow } from "./sleep-cycle.js";

const NOW_ISO = "2026-04-22T15:30:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function activitySignal(
  overrides: Partial<LifeOpsActivitySignal> = {},
): LifeOpsActivitySignal {
  return {
    id: "signal-1",
    agentId: "agent-1",
    source: "desktop_interaction",
    platform: "macos_desktop",
    state: "active",
    observedAt: new Date(NOW_MS - 60_000).toISOString(),
    idleState: "active",
    idleTimeSeconds: 5,
    onBattery: false,
    health: null,
    metadata: {},
    createdAt: new Date(NOW_MS - 60_000).toISOString(),
    ...overrides,
  };
}

function sleepCycle(
  overrides: Partial<
    Pick<
      LifeOpsSleepCycle,
      | "isProbablySleeping"
      | "sleepConfidence"
      | "currentSleepStartedAt"
      | "lastSleepEndedAt"
      | "sleepStatus"
      | "evidence"
    >
  > = {},
): Pick<
  LifeOpsSleepCycle,
  | "isProbablySleeping"
  | "sleepConfidence"
  | "currentSleepStartedAt"
  | "lastSleepEndedAt"
  | "sleepStatus"
  | "evidence"
> {
  return {
    isProbablySleeping: false,
    sleepConfidence: 0,
    currentSleepStartedAt: null,
    lastSleepEndedAt: null,
    sleepStatus: "unknown",
    evidence: [],
    ...overrides,
  };
}

function regularity(
  overrides: Partial<LifeOpsScheduleRegularity> = {},
): LifeOpsScheduleRegularity {
  return {
    sri: 0,
    bedtimeStddevMin: 0,
    wakeStddevMin: 0,
    midSleepStddevMin: 0,
    regularityClass: "insufficient_data",
    sampleCount: 0,
    windowDays: 30,
    ...overrides,
  };
}

function activityWindow(
  overrides: Partial<LifeOpsActivityWindow> = {},
): LifeOpsActivityWindow {
  return {
    startMs: NOW_MS - 30 * 60_000,
    endMs: NOW_MS - 5 * 60_000,
    source: "signal",
    ...overrides,
  };
}

describe("computeAwakeProbability", () => {
  it("returns mostly pUnknown when there are no signals, windows, or sleep state", () => {
    const result = computeAwakeProbability({
      nowMs: NOW_MS,
      timezone: "UTC",
      signals: [],
      windows: [],
      sleepCycle: sleepCycle(),
      regularity: regularity(),
    });
    // With zero contributors evidenceCoverage is clamped to its 0.15 floor,
    // logistic(0) = 0.5, so pAwake/pAsleep split the small known mass and the
    // unknown bucket dominates.
    expect(result.pUnknown).toBeGreaterThanOrEqual(0.8);
    expect(result.pAwake).toBeLessThanOrEqual(0.1);
    expect(result.pAsleep).toBeLessThanOrEqual(0.1);
    expect(result.contributingSources).toEqual([]);
    expect(result.computedAt).toBe(NOW_ISO);
  });

  it("scores high pAwake when desktop_interaction is active within 5 minutes and recent wake observed", () => {
    const signals: LifeOpsActivitySignal[] = [
      activitySignal({
        source: "desktop_interaction",
        state: "active",
        observedAt: new Date(NOW_MS - 60_000).toISOString(),
        idleTimeSeconds: 10,
      }),
    ];
    const result = computeAwakeProbability({
      nowMs: NOW_MS,
      timezone: "UTC",
      signals,
      windows: [activityWindow()],
      sleepCycle: sleepCycle({
        sleepStatus: "slept",
        lastSleepEndedAt: new Date(NOW_MS - 60 * 60_000).toISOString(),
      }),
      regularity: regularity(),
    });
    expect(result.pAwake).toBeGreaterThan(0.7);
    expect(result.pAsleep).toBeLessThan(0.1);
    const sources = result.contributingSources.map((c) => c.source);
    expect(sources).toContain("desktop_interaction");
    expect(sources).toContain("health");
    expect(sources).toContain("activity_gap");
  });

  it("treats app_lifecycle 'active' on a non-manual_override platform as shared-device risk when no concurrent owner interaction", () => {
    const sharedOnly = computeAwakeProbability({
      nowMs: NOW_MS,
      timezone: "UTC",
      signals: [
        activitySignal({
          source: "app_lifecycle",
          platform: "browser_web",
          state: "active",
          observedAt: new Date(NOW_MS - 60_000).toISOString(),
          idleTimeSeconds: 600,
          idleState: "idle",
        }),
      ],
      windows: [],
      sleepCycle: sleepCycle(),
      regularity: regularity(),
    });
    const sharedContributor = sharedOnly.contributingSources.find(
      (c) => c.source === "app_lifecycle",
    );
    expect(sharedContributor).toBeDefined();
    if (!sharedContributor) return;

    const corroboratedContributor = computeAwakeProbability({
      nowMs: NOW_MS,
      timezone: "UTC",
      signals: [
        activitySignal({
          id: "signal-app",
          source: "app_lifecycle",
          platform: "browser_web",
          state: "active",
          observedAt: new Date(NOW_MS - 60_000).toISOString(),
          idleTimeSeconds: 600,
          idleState: "idle",
        }),
        activitySignal({
          id: "signal-desk",
          source: "desktop_interaction",
          platform: "macos_desktop",
          state: "active",
          observedAt: new Date(NOW_MS - 30_000).toISOString(),
          idleTimeSeconds: 5,
        }),
      ],
      windows: [],
      sleepCycle: sleepCycle(),
      regularity: regularity(),
    }).contributingSources.find((c) => c.source === "desktop_interaction");
    expect(corroboratedContributor).toBeDefined();
    if (!corroboratedContributor) return;

    // Shared-device risk discount cuts the LLR weight to 25% of the unscaled
    // value, so the corroborated reading must be strictly larger.
    expect(corroboratedContributor.logLikelihoodRatio).toBeGreaterThan(
      sharedContributor.logLikelihoodRatio,
    );
  });

  it("strongly weights pAsleep when sleepCycle reports sleeping_now", () => {
    const result = computeAwakeProbability({
      nowMs: NOW_MS,
      timezone: "UTC",
      signals: [],
      windows: [],
      sleepCycle: sleepCycle({
        isProbablySleeping: true,
        sleepStatus: "sleeping_now",
        sleepConfidence: 0.9,
        currentSleepStartedAt: new Date(NOW_MS - 3 * 60 * 60_000).toISOString(),
        evidence: [
          { startAt: NOW_ISO, endAt: null, source: "health", confidence: 0.92 },
        ],
      }),
      regularity: regularity(),
    });
    expect(result.pAsleep).toBeGreaterThan(0.7);
    expect(result.pAwake).toBeLessThan(0.2);
    expect(result.contributingSources.map((c) => c.source)).toContain("health");
  });

  it("only applies the schedule prior reduction in the 22:00-06:00 window when regularity is regular or very_regular", () => {
    const insufficient = computeAwakeProbability({
      nowMs: Date.parse("2026-04-22T03:00:00.000Z"),
      timezone: "UTC",
      signals: [],
      windows: [],
      sleepCycle: sleepCycle(),
      regularity: regularity({ regularityClass: "insufficient_data" }),
    });
    expect(
      insufficient.contributingSources.find((c) => c.source === "prior"),
    ).toBeUndefined();

    const regular = computeAwakeProbability({
      nowMs: Date.parse("2026-04-22T03:00:00.000Z"),
      timezone: "UTC",
      signals: [],
      windows: [],
      sleepCycle: sleepCycle(),
      regularity: regularity({
        regularityClass: "regular",
        sri: 80,
        sampleCount: 14,
      }),
    });
    const prior = regular.contributingSources.find((c) => c.source === "prior");
    expect(prior).toBeDefined();
    if (!prior) return;
    // 22:00-06:00 window should produce a negative weight (pulls toward sleep).
    expect(prior.logLikelihoodRatio).toBeLessThan(0);

    const morningPrior = computeAwakeProbability({
      nowMs: Date.parse("2026-04-22T08:00:00.000Z"),
      timezone: "UTC",
      signals: [],
      windows: [],
      sleepCycle: sleepCycle(),
      regularity: regularity({
        regularityClass: "regular",
        sri: 80,
        sampleCount: 14,
      }),
    }).contributingSources.find((c) => c.source === "prior");
    expect(morningPrior).toBeDefined();
    if (!morningPrior) return;
    // 06:00-10:00 should produce a positive prior (pulls toward awake).
    expect(morningPrior.logLikelihoodRatio).toBeGreaterThan(0);
  });

  it("normalizes pAwake + pAsleep + pUnknown to 1 across mixed inputs", () => {
    const result = computeAwakeProbability({
      nowMs: NOW_MS,
      timezone: "UTC",
      signals: [
        activitySignal({
          source: "desktop_interaction",
          state: "active",
          observedAt: new Date(NOW_MS - 4 * 60_000).toISOString(),
        }),
      ],
      windows: [activityWindow()],
      sleepCycle: sleepCycle({
        sleepStatus: "slept",
        lastSleepEndedAt: new Date(NOW_MS - 90 * 60_000).toISOString(),
      }),
      regularity: regularity({
        regularityClass: "very_regular",
        sri: 90,
        sampleCount: 21,
      }),
    });
    const sum = result.pAwake + result.pAsleep + result.pUnknown;
    // Allow for rounding: every probability is rounded to 2 decimals before
    // re-normalization, so worst case the sum drifts up to ~0.03.
    expect(Math.abs(sum - 1)).toBeLessThanOrEqual(0.03);
  });

  it("clamps activity_gap penalty when signal coverage is sparse but recent gap exists", () => {
    const result = computeAwakeProbability({
      nowMs: NOW_MS,
      timezone: "UTC",
      signals: [],
      windows: [
        activityWindow({
          startMs: NOW_MS - 12 * 60 * 60_000,
          endMs: NOW_MS - 5 * 60 * 60_000,
        }),
      ],
      sleepCycle: sleepCycle(),
      regularity: regularity(),
    });
    const gap = result.contributingSources.find(
      (c) => c.source === "activity_gap",
    );
    expect(gap).toBeDefined();
    if (!gap) return;
    // A 5-hour gap (300 min) should produce ~ -1.25 from the unclamped formula
    // but the clamp pins this between -0.8 and -1.8.
    expect(gap.logLikelihoodRatio).toBeLessThanOrEqual(-0.8);
    expect(gap.logLikelihoodRatio).toBeGreaterThanOrEqual(-1.8);
  });
});
