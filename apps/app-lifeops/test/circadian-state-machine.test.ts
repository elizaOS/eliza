import type {
  LifeOpsActivitySignal,
  LifeOpsCircadianState,
} from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import type { LifeOpsCircadianStateRow } from "../src/lifeops/repository.js";
import {
  enforceStabilityWindow,
  inferLifeOpsScheduleInsight,
  resolvePriorStateForDerivation,
  STALE_CIRCADIAN_STATE_MS,
} from "../src/lifeops/schedule-insight.js";
import type { LifeOpsActivityWindow } from "../src/lifeops/sleep-cycle.js";

/**
 * These tests lock in the state-machine stability policy documented in
 * `docs/sleep-wake-spec.md` §4-5: the scorer's suggestion only becomes the
 * authoritative circadian state after the required dwell time elapses,
 * unless a manual override or a sleep→waking transition bypasses the gate.
 */

function sleepingHealthSignal(observedAtMs: number): LifeOpsActivitySignal {
  const observedAt = new Date(observedAtMs).toISOString();
  return {
    id: `hk:${observedAtMs}`,
    agentId: "agent-1",
    source: "mobile_health",
    platform: "mobile_app",
    state: "sleeping",
    observedAt,
    idleState: "locked",
    idleTimeSeconds: null,
    onBattery: false,
    health: {
      source: "healthkit",
      permissions: { sleep: true, biometrics: false },
      sleep: {
        available: true,
        isSleeping: true,
        asleepAt: observedAt,
        awakeAt: null,
        durationMinutes: 30,
        stage: null,
      },
      biometrics: {
        sampleAt: null,
        heartRateBpm: null,
        restingHeartRateBpm: null,
        heartRateVariabilityMs: null,
        respiratoryRate: null,
        bloodOxygenPercent: null,
      },
      warnings: [],
    },
    metadata: {},
    createdAt: observedAt,
  };
}

function manualOverrideSignal(args: {
  observedAtMs: number;
  kind: "going_to_bed" | "just_woke_up";
}): LifeOpsActivitySignal {
  const observedAt = new Date(args.observedAtMs).toISOString();
  return {
    id: `manual:${args.observedAtMs}`,
    agentId: "agent-1",
    source: "app_lifecycle",
    platform: "manual_override",
    state: args.kind === "going_to_bed" ? "sleeping" : "active",
    observedAt,
    idleState: args.kind === "going_to_bed" ? "idle" : "active",
    idleTimeSeconds: 0,
    onBattery: null,
    health: null,
    metadata: { userAttested: true, manualOverrideKind: args.kind },
    createdAt: observedAt,
  };
}

function priorAwake(enteredAtMs: number) {
  return {
    circadianState: "awake" as LifeOpsCircadianState,
    enteredAtMs,
  };
}

function priorSleeping(enteredAtMs: number) {
  return {
    circadianState: "sleeping" as LifeOpsCircadianState,
    enteredAtMs,
  };
}

describe("circadian state machine", () => {
  it("refuses to flip awake -> sleeping until the sleep-onset window elapses", () => {
    const nowMs = Date.parse("2026-05-01T00:20:00.000Z");
    const windows: LifeOpsActivityWindow[] = [];
    const signals = [sleepingHealthSignal(nowMs - 60_000)];

    const insightBeforeWindow = inferLifeOpsScheduleInsight({
      nowMs,
      timezone: "UTC",
      windows,
      signals,
      // Awake for 5 minutes — below SLEEP_ONSET_WINDOW_MS (20 min).
      priorState: priorAwake(nowMs - 5 * 60_000),
    });
    expect(insightBeforeWindow.circadianState).toBe("awake");
    expect(insightBeforeWindow.uncertaintyReason).toBe("stale_state");

    const insightAfterWindow = inferLifeOpsScheduleInsight({
      nowMs,
      timezone: "UTC",
      windows,
      signals,
      // Awake for 25 minutes — above SLEEP_ONSET_WINDOW_MS.
      priorState: priorAwake(nowMs - 25 * 60_000),
    });
    expect(insightAfterWindow.circadianState).toBe("sleeping");
  });

  it("lets a manual override bypass the stability window immediately", () => {
    const nowMs = Date.parse("2026-05-01T01:00:00.000Z");
    const insight = inferLifeOpsScheduleInsight({
      nowMs,
      timezone: "UTC",
      windows: [],
      signals: [
        manualOverrideSignal({ observedAtMs: nowMs, kind: "going_to_bed" }),
      ],
      // Just became awake 30 seconds ago. Under normal rules the scorer
      // could not flip to sleeping, but the manual override bypasses.
      priorState: priorAwake(nowMs - 30_000),
    });
    expect(insight.circadianState).toBe("sleeping");
  });

  it("allows sleeping -> waking with no dwell (wake must not be delayed)", () => {
    // Bypass-gate for this specific transition is verified at the policy
    // layer rather than going through full insight inference, which is
    // gated upstream by the sleep-cycle detector (tested separately).
    const nowMs = Date.parse("2026-05-01T07:30:00.000Z");
    const stabilized = enforceStabilityWindow({
      incoming: {
        circadianState: "waking",
        stateConfidence: 0.92,
        uncertaintyReason: null,
      },
      prior: priorSleeping(nowMs - 2 * 60_000),
      hasManualOverride: false,
      nowMs,
    });
    expect(stabilized.circadianState).toBe("waking");
  });

  it("refuses waking -> awake before WAKE_CONFIRM_WINDOW elapses", () => {
    const nowMs = Date.parse("2026-05-01T07:40:00.000Z");
    const stabilized = enforceStabilityWindow({
      incoming: {
        circadianState: "awake",
        stateConfidence: 0.9,
        uncertaintyReason: null,
      },
      prior: {
        circadianState: "waking",
        enteredAtMs: nowMs - 5 * 60_000,
      },
      hasManualOverride: false,
      nowMs,
    });
    expect(stabilized.circadianState).toBe("waking");
    expect(stabilized.uncertaintyReason).toBe("stale_state");
  });

  it("allows waking -> awake once WAKE_CONFIRM_WINDOW elapses", () => {
    const nowMs = Date.parse("2026-05-01T07:40:00.000Z");
    const stabilized = enforceStabilityWindow({
      incoming: {
        circadianState: "awake",
        stateConfidence: 0.9,
        uncertaintyReason: null,
      },
      prior: {
        circadianState: "waking",
        enteredAtMs: nowMs - 12 * 60_000,
      },
      hasManualOverride: false,
      nowMs,
    });
    expect(stabilized.circadianState).toBe("awake");
  });

  it("treats a stale state row as null via resolvePriorStateForDerivation", () => {
    const nowMs = Date.parse("2026-05-01T10:00:00.000Z");
    const staleEnteredAt = new Date(
      nowMs - STALE_CIRCADIAN_STATE_MS - 60_000,
    ).toISOString();
    const row: LifeOpsCircadianStateRow = {
      agentId: "agent-1",
      circadianState: "sleeping",
      stateConfidence: 0.9,
      uncertaintyReason: null,
      enteredAt: staleEnteredAt,
      sinceSleepDetectedAt: staleEnteredAt,
      sinceWakeObservedAt: null,
      sinceWakeConfirmedAt: null,
      evidenceRefs: [],
      createdAt: staleEnteredAt,
      updatedAt: staleEnteredAt,
    };
    expect(resolvePriorStateForDerivation(row, nowMs)).toBeNull();
  });

  it("treats an unclear state row as null (never pin the state machine to unclear)", () => {
    const nowMs = Date.parse("2026-05-01T10:00:00.000Z");
    const enteredAt = new Date(nowMs - 60_000).toISOString();
    const row: LifeOpsCircadianStateRow = {
      agentId: "agent-1",
      circadianState: "unclear",
      stateConfidence: 0.1,
      uncertaintyReason: "no_signals",
      enteredAt,
      sinceSleepDetectedAt: null,
      sinceWakeObservedAt: null,
      sinceWakeConfirmedAt: null,
      evidenceRefs: [],
      createdAt: enteredAt,
      updatedAt: enteredAt,
    };
    expect(resolvePriorStateForDerivation(row, nowMs)).toBeNull();
  });

  it("returns the prior state when fresh and non-unclear", () => {
    const nowMs = Date.parse("2026-05-01T10:00:00.000Z");
    const enteredAt = new Date(nowMs - 10 * 60_000).toISOString();
    const row: LifeOpsCircadianStateRow = {
      agentId: "agent-1",
      circadianState: "awake",
      stateConfidence: 0.8,
      uncertaintyReason: null,
      enteredAt,
      sinceSleepDetectedAt: null,
      sinceWakeObservedAt: enteredAt,
      sinceWakeConfirmedAt: enteredAt,
      evidenceRefs: [],
      createdAt: enteredAt,
      updatedAt: enteredAt,
    };
    const resolved = resolvePriorStateForDerivation(row, nowMs);
    expect(resolved).not.toBeNull();
    expect(resolved?.circadianState).toBe("awake");
  });
});
