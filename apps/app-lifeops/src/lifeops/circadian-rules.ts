/**
 * Named-rules evidence scorer for the circadian state machine.
 *
 * This module composes typed rules on top of `computeAwakeProbability`
 * (LLR math) and the existing sleep-cycle episode output. The LLR numbers
 * remain the underlying quantitative signal; this layer exposes each rule's
 * firing + weight as structured data the UI can render ("rule X fired with
 * weight Y because evidence Z") and the state machine can gate on stability
 * windows per `sleep-wake-spec.md`.
 *
 * The rules here are the canonical set documented in section 3 of the spec:
 *   - healthkit.isSleepingNow
 *   - hid.idleGt20m
 *   - desktop.lockedGt30m
 *   - desktop.wakeNotification
 *   - message.outboundRecent
 *   - continuity.iphoneDisconnected
 *   - gap.noSignalsGt2hOvernight
 *   - baseline.currentHourLikelyAsleep
 *   - manual.override
 */

import type {
  LifeOpsActivitySignal,
  LifeOpsCircadianState,
  LifeOpsPersonalBaseline,
  LifeOpsRegularityClass,
} from "@elizaos/shared/contracts/lifeops";
import type { LifeOpsActivityWindow } from "./sleep-cycle.js";
import { getZonedDateParts } from "./time.js";

export const MIN_STABILITY_WINDOW_MS = 5 * 60_000;
export const WAKE_CONFIRM_WINDOW_MS = 10 * 60_000;
export const SLEEP_ONSET_WINDOW_MS = 20 * 60_000;
export const WINDING_DOWN_LOOKAHEAD_MS = 90 * 60_000;
export const AWAKE_EVIDENCE_MAX_AGE_MS = 20 * 60_000;
export const SLEEP_EVIDENCE_MAX_AGE_MS = 12 * 60 * 60_000;
export const NAP_MAX_DURATION_MS = 4 * 60 * 60_000;

export type CircadianRuleVote = LifeOpsCircadianState;

export interface CircadianRuleFiring {
  /** Stable rule identifier, e.g. "hid.idleGt20m". */
  name: string;
  /** The canonical state the rule votes for. */
  contributes: CircadianRuleVote;
  /** Weight in [0, 1] combining rule importance and source reliability. */
  weight: number;
  /** ISO timestamp of the underlying evidence observation. */
  observedAt: string;
  /** Short human-readable summary for the inspection UI. */
  reason: string;
}

export interface CircadianScorerResult {
  firings: CircadianRuleFiring[];
  /** Per-state total weight, for quick ranking. */
  totals: Record<CircadianRuleVote, number>;
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function localHour(nowMs: number, timezone: string): number {
  const parts = getZonedDateParts(new Date(nowMs), timezone);
  return parts.hour + parts.minute / 60;
}

interface ScorerInputs {
  nowMs: number;
  timezone: string;
  signals: readonly LifeOpsActivitySignal[];
  windows: readonly LifeOpsActivityWindow[];
  baseline: LifeOpsPersonalBaseline | null;
  regularityClass: LifeOpsRegularityClass;
  hasCurrentSleepEpisode: boolean;
  currentSleepStartedAtMs: number | null;
  lastSleepEndedAtMs: number | null;
  currentEpisodeLikelyNap: boolean;
}

function signalAgeMs(
  signal: LifeOpsActivitySignal,
  nowMs: number,
): number | null {
  const observedAt = parseIsoMs(signal.observedAt);
  return observedAt === null ? null : nowMs - observedAt;
}

function emptyTotals(): Record<CircadianRuleVote, number> {
  return {
    awake: 0,
    winding_down: 0,
    sleeping: 0,
    waking: 0,
    napping: 0,
    unclear: 0,
  };
}

function pushFiring(
  firings: CircadianRuleFiring[],
  totals: Record<CircadianRuleVote, number>,
  firing: CircadianRuleFiring,
): void {
  firings.push(firing);
  totals[firing.contributes] += firing.weight;
}

/**
 * Evaluates every rule against the provided evidence. Pure; no I/O.
 *
 * The scorer is deliberately additive: rules are independent and each
 * contributes its weight to a single vote bucket. The state machine layer
 * is responsible for (a) picking the top bucket, (b) enforcing stability
 * windows between transitions, and (c) mapping totals to a calibrated
 * confidence via `awake-probability.ts`.
 */
export function scoreCircadianRules(
  inputs: ScorerInputs,
): CircadianScorerResult {
  const firings: CircadianRuleFiring[] = [];
  const totals = emptyTotals();
  const latestSignal = [...inputs.signals]
    .map((signal) => ({ signal, ageMs: signalAgeMs(signal, inputs.nowMs) }))
    .filter(
      (
        candidate,
      ): candidate is { signal: LifeOpsActivitySignal; ageMs: number } =>
        candidate.ageMs !== null,
    )
    .sort((left, right) => left.ageMs - right.ageMs)[0];

  // Rule: manual.override: user-attested override wins.
  const manualOverride = inputs.signals.find(
    (signal) =>
      signal.platform === "manual_override" &&
      typeof signal.metadata.userAttested === "boolean" &&
      signal.metadata.userAttested === true,
  );
  if (manualOverride) {
    const age = signalAgeMs(manualOverride, inputs.nowMs);
    if (age !== null && age <= 4 * 60 * 60_000) {
      const kind = String(manualOverride.metadata.manualOverrideKind ?? "");
      pushFiring(firings, totals, {
        name: "manual.override",
        contributes: kind === "going_to_bed" ? "sleeping" : "awake",
        weight: 1.0,
        observedAt: manualOverride.observedAt,
        reason: `user attested ${kind}`,
      });
    }
  }

  // Rule: healthkit.isSleepingNow: any fresh HealthKit sleep sample.
  const healthSleep = inputs.signals.find(
    (signal) =>
      signal.source === "mobile_health" &&
      signal.health?.sleep.isSleeping === true,
  );
  if (healthSleep) {
    const age = signalAgeMs(healthSleep, inputs.nowMs);
    if (age !== null && age <= 2 * 60 * 60_000) {
      pushFiring(firings, totals, {
        name: "healthkit.isSleepingNow",
        contributes: "sleeping",
        weight: 0.95,
        observedAt: healthSleep.observedAt,
        reason: "HealthKit reports isSleeping=true",
      });
    }
  }

  // Rule: hid.idleGt20m: HID idle past the awake-evidence timeout.
  const idleSignal = inputs.signals.find(
    (signal) =>
      signal.source === "desktop_interaction" &&
      typeof signal.idleTimeSeconds === "number" &&
      signal.idleTimeSeconds >= 20 * 60,
  );
  if (idleSignal) {
    const age = signalAgeMs(idleSignal, inputs.nowMs);
    if (age !== null && age <= AWAKE_EVIDENCE_MAX_AGE_MS) {
      const hour = localHour(inputs.nowMs, inputs.timezone);
      const overnight = hour >= 22 || hour < 6;
      pushFiring(firings, totals, {
        name: "hid.idleGt20m",
        contributes: overnight ? "sleeping" : "winding_down",
        weight: 0.8,
        observedAt: idleSignal.observedAt,
        reason: `HID idle >=20 min (${idleSignal.idleTimeSeconds}s)`,
      });
    }
  }

  // Rule: desktop.lockedGt30m: session lock sustained past 30 min.
  const lockSignal = inputs.signals.find(
    (signal) => signal.source === "desktop_power" && signal.state === "locked",
  );
  if (lockSignal) {
    const age = signalAgeMs(lockSignal, inputs.nowMs);
    if (age !== null && age >= 30 * 60_000) {
      const hour = localHour(inputs.nowMs, inputs.timezone);
      const overnight = hour >= 22 || hour < 6;
      pushFiring(firings, totals, {
        name: "desktop.lockedGt30m",
        contributes: overnight ? "sleeping" : "winding_down",
        weight: 0.85,
        observedAt: lockSignal.observedAt,
        reason: "session locked >=30 min",
      });
    }
  }

  // Rule: desktop.wakeNotification: recent system wake event.
  const wakeSignal = inputs.signals.find(
    (signal) =>
      signal.source === "desktop_power" &&
      (signal.state === "active" ||
        signal.metadata.event === "didWake" ||
        signal.metadata.event === "screensDidWake"),
  );
  if (wakeSignal) {
    const age = signalAgeMs(wakeSignal, inputs.nowMs);
    if (age !== null && age <= WAKE_CONFIRM_WINDOW_MS) {
      pushFiring(firings, totals, {
        name: "desktop.wakeNotification",
        contributes: "waking",
        weight: 0.92,
        observedAt: wakeSignal.observedAt,
        reason: "recent NSWorkspace wake notification",
      });
    }
  }

  // Rule: message.outboundRecent: outbound message within 10 min = awake.
  const outboundSignal = inputs.signals.find(
    (signal) =>
      signal.source === "imessage_outbound" ||
      (signal.source === "connector_activity" &&
        (signal.metadata.eventType === "MESSAGE_RECEIVED" ||
          signal.metadata.direction === "outbound_by_owner")),
  );
  if (outboundSignal) {
    const age = signalAgeMs(outboundSignal, inputs.nowMs);
    if (age !== null && age <= 10 * 60_000) {
      pushFiring(firings, totals, {
        name: "message.outboundRecent",
        contributes: "awake",
        weight: 0.88,
        observedAt: outboundSignal.observedAt,
        reason: "outbound message within 10 min",
      });
    }
  }

  // Rule: continuity.iphoneDisconnected: paired iPhone absent during overnight.
  const continuitySignal = inputs.signals.find(
    (signal) =>
      signal.source === "mobile_device" &&
      typeof signal.platform === "string" &&
      signal.platform.startsWith("macos_continuity") &&
      signal.state !== "active",
  );
  if (continuitySignal) {
    const age = signalAgeMs(continuitySignal, inputs.nowMs);
    const hour = localHour(inputs.nowMs, inputs.timezone);
    const overnight = hour >= 22 || hour < 6;
    if (age !== null && age <= 60 * 60_000 && overnight) {
      pushFiring(firings, totals, {
        name: "continuity.iphoneDisconnected",
        contributes: "sleeping",
        weight: 0.5,
        observedAt: continuitySignal.observedAt,
        reason: "paired iPhone disconnected overnight",
      });
    }
  }

  // Rule: gap.noSignalsGt2hOvernight: no activity windows for 2h+ at night.
  const latestWindow = inputs.windows[inputs.windows.length - 1];
  if (latestWindow) {
    const gapMs = inputs.nowMs - latestWindow.endMs;
    const hour = localHour(inputs.nowMs, inputs.timezone);
    if (gapMs >= 2 * 60 * 60_000 && (hour >= 22 || hour < 10)) {
      pushFiring(firings, totals, {
        name: "gap.noSignalsGt2hOvernight",
        contributes: "sleeping",
        weight: Math.min(0.9, 0.3 + gapMs / (8 * 60 * 60_000)),
        observedAt: new Date(latestWindow.endMs).toISOString(),
        reason: `no activity for ${Math.round(gapMs / 60_000)} min overnight`,
      });
    }
  }

  // Rule: baseline.currentHourLikelyAsleep: personal bedtime prior.
  if (
    inputs.baseline !== null &&
    (inputs.regularityClass === "regular" ||
      inputs.regularityClass === "very_regular")
  ) {
    const hour = localHour(inputs.nowMs, inputs.timezone);
    const bedtime = inputs.baseline.medianBedtimeLocalHour;
    const wake = inputs.baseline.medianWakeLocalHour;
    const hourNormalized = hour < 12 ? hour + 24 : hour;
    const inSleepWindow =
      hourNormalized >= bedtime || hourNormalized < wake + 12;
    if (inSleepWindow) {
      pushFiring(firings, totals, {
        name: "baseline.currentHourLikelyAsleep",
        contributes: "sleeping",
        weight: 0.35,
        observedAt: new Date(inputs.nowMs).toISOString(),
        reason: `within baseline bedtime window (${bedtime.toFixed(1)}h-${wake.toFixed(1)}h)`,
      });
    } else if (hourNormalized >= wake && hourNormalized < wake + 4) {
      pushFiring(firings, totals, {
        name: "baseline.currentHourLikelyAwake",
        contributes: "awake",
        weight: 0.3,
        observedAt: new Date(inputs.nowMs).toISOString(),
        reason: `within baseline morning window`,
      });
    }
  }

  // Rule: activeSignalRecent: generic active presence within 5 min.
  if (
    latestSignal &&
    latestSignal.signal.state === "active" &&
    latestSignal.ageMs <= 5 * 60_000
  ) {
    pushFiring(firings, totals, {
      name: "active.signalRecent",
      contributes: "awake",
      weight: 0.7,
      observedAt: latestSignal.signal.observedAt,
      reason: "active signal within 5 min",
    });
  }

  // Current sleep episode tracked by sleep-cycle maps to sleeping or napping.
  if (
    inputs.hasCurrentSleepEpisode &&
    inputs.currentSleepStartedAtMs !== null
  ) {
    const duration = inputs.nowMs - inputs.currentSleepStartedAtMs;
    const isNap =
      inputs.currentEpisodeLikelyNap && duration < NAP_MAX_DURATION_MS;
    pushFiring(firings, totals, {
      name: isNap ? "episode.napInProgress" : "episode.sleepInProgress",
      contributes: isNap ? "napping" : "sleeping",
      weight: 0.85,
      observedAt: new Date(inputs.currentSleepStartedAtMs).toISOString(),
      reason: isNap ? "nap episode in progress" : "sleep episode in progress",
    });
  }

  // Recent wake anchor feeds the waking bucket briefly.
  if (inputs.lastSleepEndedAtMs !== null) {
    const age = inputs.nowMs - inputs.lastSleepEndedAtMs;
    if (age >= 0 && age <= WAKE_CONFIRM_WINDOW_MS) {
      pushFiring(firings, totals, {
        name: "episode.justWoke",
        contributes: "waking",
        weight: 0.7,
        observedAt: new Date(inputs.lastSleepEndedAtMs).toISOString(),
        reason: "wake anchor within stability window",
      });
    }
  }

  return { firings, totals };
}

export type { ScorerInputs };
