/**
 * Awake-probability tests pin the directional invariants of the logistic model
 * that gates health check-in timing.
 */
import { describe, expect, it } from "vitest";
import { computeAwakeProbability } from "./awake-probability.js";

// Pin directional invariants rather than hand-computed tuning constants.
const iso = (ms: number) => new Date(ms).toISOString();
const args = (o: Record<string, unknown>) =>
  o as unknown as Parameters<typeof computeAwakeProbability>[0];

const insufficientRegularity = { sri: 0, regularityClass: "insufficient_data" };

const nowDay = Date.parse("2026-06-23T14:00:00Z"); // 2pm, midday
const now3am = Date.parse("2026-06-23T03:00:00Z");

const awake = computeAwakeProbability(
  args({
    nowMs: nowDay,
    timezone: "UTC",
    signals: [
      {
        observedAt: iso(nowDay - 60_000),
        source: "desktop_interaction",
        state: "active",
        platform: "linux",
        idleTimeSeconds: 5,
      },
    ],
    windows: [{ endMs: nowDay - 60_000 }], // ~1m gap -> recent-activity boost
    sleepCycle: {
      isProbablySleeping: false,
      sleepConfidence: 0,
      currentSleepStartedAt: null,
      lastSleepEndedAt: iso(nowDay - 30 * 60_000), // woke 30m ago
      sleepStatus: "awake",
      evidence: [],
    },
    regularity: insufficientRegularity,
  }),
);

const asleep = computeAwakeProbability(
  args({
    nowMs: now3am,
    timezone: "UTC",
    signals: [
      {
        observedAt: iso(now3am - 60_000),
        source: "mobile_device",
        state: "sleeping",
        platform: "android",
      },
    ],
    windows: [{ endMs: now3am - 300 * 60_000 }], // 5h gap -> sleep-gap penalty
    sleepCycle: {
      isProbablySleeping: true,
      sleepConfidence: 0.9,
      currentSleepStartedAt: iso(now3am - 4 * 3_600_000),
      lastSleepEndedAt: null,
      sleepStatus: "sleeping_now",
      evidence: [{ source: "activity_gap", confidence: 0.9 }],
    },
    regularity: insufficientRegularity,
  }),
);

const empty = computeAwakeProbability(
  args({
    nowMs: nowDay,
    timezone: "UTC",
    signals: [],
    windows: [],
    sleepCycle: {
      isProbablySleeping: false,
      sleepConfidence: 0,
      currentSleepStartedAt: null,
      lastSleepEndedAt: null,
      sleepStatus: "unknown",
      evidence: [],
    },
    regularity: insufficientRegularity,
  }),
);

describe("computeAwakeProbability", () => {
  it("a fresh active desktop session reads as awake", () => {
    expect(awake.pAwake).toBeGreaterThan(awake.pAsleep);
    expect(awake.pAwake).toBeGreaterThan(awake.pUnknown);
  });

  it("sleeping_now + 3am + long inactivity reads as asleep", () => {
    expect(asleep.pAsleep).toBeGreaterThan(asleep.pAwake);
    expect(asleep.pAsleep).toBeGreaterThan(asleep.pUnknown);
  });

  it("is monotonic: the awake case is more awake than the asleep case", () => {
    expect(awake.pAwake).toBeGreaterThan(asleep.pAwake);
  });

  it("with no evidence, pUnknown dominates and awake≈asleep", () => {
    expect(empty.pUnknown).toBeGreaterThan(empty.pAwake);
    expect(empty.pUnknown).toBeGreaterThan(empty.pAsleep);
    expect(empty.pAwake).toBeCloseTo(empty.pAsleep, 5);
  });

  it("always returns a normalized distribution + the computedAt instant", () => {
    for (const r of [awake, asleep, empty]) {
      expect(r.pAwake + r.pAsleep + r.pUnknown).toBeCloseTo(1, 2);
    }
    expect(awake.computedAt).toBe(iso(nowDay));
  });
});
