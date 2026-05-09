/**
 * Named-rules evidence scorer for the circadian state machine.
 *
 * Rules are declared as a flat table so each rule is trivial to audit and
 * easy to extend. Every rule is a pure predicate over the scorer inputs
 * that may return one `CircadianRuleFiring` (or `null` when the rule
 * doesn't apply this tick). The runner accumulates firings into a per-state
 * totals map that the state machine layer then ranks.
 *
 * Weights, thresholds, and stability windows are the canonical ones from
 * `docs/sleep-wake-spec.md` §3. Anything tunable lives at the top of this
 * file so spec and code never drift.
 */

import type {
  LifeOpsActivitySignal,
  LifeOpsCircadianRuleFiring,
  LifeOpsCircadianState,
  LifeOpsPersonalBaseline,
  LifeOpsRegularityClass,
} from "@elizaos/shared";
import type { LifeOpsActivityWindow } from "./sleep-cycle.js";
import { getZonedDateParts } from "../util/time.js";
import { parseIsoMs } from "../util/time-util.js";

export const MIN_STABILITY_WINDOW_MS = 5 * 60_000;
export const WAKE_CONFIRM_WINDOW_MS = 10 * 60_000;
export const SLEEP_ONSET_WINDOW_MS = 20 * 60_000;
const AWAKE_EVIDENCE_MAX_AGE_MS = 20 * 60_000;
const NAP_MAX_DURATION_MS = 4 * 60 * 60_000;

export type CircadianRuleFiring = LifeOpsCircadianRuleFiring;

export interface CircadianScorerResult {
  firings: CircadianRuleFiring[];
  totals: Record<LifeOpsCircadianState, number>;
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

function localHour(nowMs: number, timezone: string): number {
  const parts = getZonedDateParts(new Date(nowMs), timezone);
  return parts.hour + parts.minute / 60;
}

function isOvernight(nowMs: number, timezone: string): boolean {
  const hour = localHour(nowMs, timezone);
  return hour >= 22 || hour < 6;
}

function signalAge(
  signal: LifeOpsActivitySignal,
  nowMs: number,
): number | null {
  const observedAt = parseIsoMs(signal.observedAt);
  return observedAt === null ? null : nowMs - observedAt;
}

type Rule = (inputs: ScorerInputs) => CircadianRuleFiring | null;

function findSignal(
  inputs: ScorerInputs,
  predicate: (signal: LifeOpsActivitySignal) => boolean,
): { signal: LifeOpsActivitySignal; ageMs: number } | null {
  for (const signal of inputs.signals) {
    if (!predicate(signal)) continue;
    const ageMs = signalAge(signal, inputs.nowMs);
    if (ageMs === null) continue;
    return { signal, ageMs };
  }
  return null;
}

/**
 * The canonical rule set. Ordered by runtime cost (cheap predicates first).
 * Each rule is a pure function with no shared state — tests can exercise
 * individual rules by calling them directly.
 */
const RULES: readonly Rule[] = [
  // manual.override — user attestation, 4h TTL.
  function manualOverride(inputs) {
    const hit = findSignal(
      inputs,
      (s) =>
        s.platform === "manual_override" && s.metadata.userAttested === true,
    );
    if (!hit || hit.ageMs > 4 * 60 * 60_000) return null;
    const kind = String(hit.signal.metadata.manualOverrideKind ?? "");
    return {
      name: "manual.override",
      contributes: kind === "going_to_bed" ? "sleeping" : "awake",
      weight: 1.0,
      observedAt: hit.signal.observedAt,
      reason: `user attested ${kind}`,
    };
  },

  // healthkit.isSleepingNow — any fresh sleep sample.
  function healthkitSleep(inputs) {
    const hit = findSignal(
      inputs,
      (s) =>
        s.source === "mobile_health" && s.health?.sleep.isSleeping === true,
    );
    if (!hit || hit.ageMs > 2 * 60 * 60_000) return null;
    return {
      name: "healthkit.isSleepingNow",
      contributes: "sleeping",
      weight: 0.95,
      observedAt: hit.signal.observedAt,
      reason: "HealthKit reports isSleeping=true",
    };
  },

  // hid.idleGt20m — HID idle past the awake-evidence timeout.
  function hidIdle(inputs) {
    const hit = findSignal(
      inputs,
      (s) =>
        s.source === "desktop_interaction" &&
        typeof s.idleTimeSeconds === "number" &&
        s.idleTimeSeconds >= 20 * 60,
    );
    if (!hit || hit.ageMs > AWAKE_EVIDENCE_MAX_AGE_MS) return null;
    return {
      name: "hid.idleGt20m",
      contributes: isOvernight(inputs.nowMs, inputs.timezone)
        ? "sleeping"
        : "winding_down",
      weight: 0.8,
      observedAt: hit.signal.observedAt,
      reason: `HID idle >=20 min (${hit.signal.idleTimeSeconds}s)`,
    };
  },

  // desktop.lockedGt30m — session lock sustained past 30 min.
  function desktopLocked(inputs) {
    const hit = findSignal(
      inputs,
      (s) => s.source === "desktop_power" && s.state === "locked",
    );
    if (!hit || hit.ageMs < 30 * 60_000) return null;
    return {
      name: "desktop.lockedGt30m",
      contributes: isOvernight(inputs.nowMs, inputs.timezone)
        ? "sleeping"
        : "winding_down",
      weight: 0.85,
      observedAt: hit.signal.observedAt,
      reason: "session locked >=30 min",
    };
  },

  // desktop.wakeNotification — recent system wake event.
  function desktopWake(inputs) {
    const hit = findSignal(
      inputs,
      (s) =>
        s.source === "desktop_power" &&
        (s.state === "active" ||
          s.metadata.event === "didWake" ||
          s.metadata.event === "screensDidWake"),
    );
    if (!hit || hit.ageMs > WAKE_CONFIRM_WINDOW_MS) return null;
    return {
      name: "desktop.wakeNotification",
      contributes: "waking",
      weight: 0.92,
      observedAt: hit.signal.observedAt,
      reason: "recent NSWorkspace wake notification",
    };
  },

  // message.outboundRecent — outbound owner message in the last 10 minutes.
  function messageOutbound(inputs) {
    const hit = findSignal(
      inputs,
      (s) =>
        s.source === "imessage_outbound" ||
        (s.source === "connector_activity" &&
          (s.metadata.eventType === "MESSAGE_RECEIVED" ||
            s.metadata.direction === "outbound_by_owner")),
    );
    if (!hit || hit.ageMs > 10 * 60_000) return null;
    return {
      name: "message.outboundRecent",
      contributes: "awake",
      weight: 0.88,
      observedAt: hit.signal.observedAt,
      reason: "outbound message within 10 min",
    };
  },

  // continuity.iphoneDisconnected — paired iPhone absent overnight.
  function continuityIPhone(inputs) {
    if (!isOvernight(inputs.nowMs, inputs.timezone)) return null;
    const hit = findSignal(
      inputs,
      (s) =>
        s.source === "mobile_device" &&
        typeof s.platform === "string" &&
        s.platform.startsWith("macos_continuity") &&
        s.state !== "active",
    );
    if (!hit || hit.ageMs > 60 * 60_000) return null;
    return {
      name: "continuity.iphoneDisconnected",
      contributes: "sleeping",
      weight: 0.5,
      observedAt: hit.signal.observedAt,
      reason: "paired iPhone disconnected overnight",
    };
  },

  // gap.noSignalsGt2hOvernight — no activity windows for 2h+ at night.
  function activityGap(inputs) {
    const latestWindow = inputs.windows[inputs.windows.length - 1];
    if (!latestWindow) return null;
    const gapMs = inputs.nowMs - latestWindow.endMs;
    if (gapMs < 2 * 60 * 60_000) return null;
    const hour = localHour(inputs.nowMs, inputs.timezone);
    if (!(hour >= 22 || hour < 10)) return null;
    return {
      name: "gap.noSignalsGt2hOvernight",
      contributes: "sleeping",
      weight: Math.min(0.9, 0.3 + gapMs / (8 * 60 * 60_000)),
      observedAt: new Date(latestWindow.endMs).toISOString(),
      reason: `no activity for ${Math.round(gapMs / 60_000)} min overnight`,
    };
  },

  // baseline.currentHourLikely[Asleep|Awake] — personal bedtime prior.
  function baselinePrior(inputs) {
    if (!inputs.baseline) return null;
    if (
      inputs.regularityClass !== "regular" &&
      inputs.regularityClass !== "very_regular"
    ) {
      return null;
    }
    const hour = localHour(inputs.nowMs, inputs.timezone);
    const { medianBedtimeLocalHour: bedtime, medianWakeLocalHour: wake } =
      inputs.baseline;
    const normalized = hour < 12 ? hour + 24 : hour;
    if (normalized >= bedtime || normalized < wake + 12) {
      return {
        name: "baseline.currentHourLikelyAsleep",
        contributes: "sleeping",
        weight: 0.35,
        observedAt: new Date(inputs.nowMs).toISOString(),
        reason: `within baseline bedtime window (${bedtime.toFixed(1)}h-${wake.toFixed(1)}h)`,
      };
    }
    if (normalized >= wake && normalized < wake + 4) {
      return {
        name: "baseline.currentHourLikelyAwake",
        contributes: "awake",
        weight: 0.3,
        observedAt: new Date(inputs.nowMs).toISOString(),
        reason: "within baseline morning window",
      };
    }
    return null;
  },

  // active.signalRecent — generic active presence within 5 min.
  function activeSignalRecent(inputs) {
    const latest = [...inputs.signals]
      .map((signal) => {
        const ageMs = signalAge(signal, inputs.nowMs);
        return ageMs === null ? null : { signal, ageMs };
      })
      .filter(
        (
          candidate,
        ): candidate is { signal: LifeOpsActivitySignal; ageMs: number } =>
          candidate !== null,
      )
      .sort((left, right) => left.ageMs - right.ageMs)[0];
    if (!latest) return null;
    if (latest.signal.state !== "active" || latest.ageMs > 5 * 60_000) {
      return null;
    }
    return {
      name: "active.signalRecent",
      contributes: "awake",
      weight: 0.7,
      observedAt: latest.signal.observedAt,
      reason: "active signal within 5 min",
    };
  },

  // episode.(sleep|nap)InProgress — current sleep episode.
  function currentEpisode(inputs) {
    if (
      !inputs.hasCurrentSleepEpisode ||
      inputs.currentSleepStartedAtMs === null
    ) {
      return null;
    }
    const duration = inputs.nowMs - inputs.currentSleepStartedAtMs;
    const isNap =
      inputs.currentEpisodeLikelyNap && duration < NAP_MAX_DURATION_MS;
    return {
      name: isNap ? "episode.napInProgress" : "episode.sleepInProgress",
      contributes: isNap ? "napping" : "sleeping",
      weight: 0.85,
      observedAt: new Date(inputs.currentSleepStartedAtMs).toISOString(),
      reason: isNap ? "nap episode in progress" : "sleep episode in progress",
    };
  },

  // episode.justWoke — wake anchor inside the confirm window.
  function justWoke(inputs) {
    if (inputs.lastSleepEndedAtMs === null) return null;
    const age = inputs.nowMs - inputs.lastSleepEndedAtMs;
    if (age < 0 || age > WAKE_CONFIRM_WINDOW_MS) return null;
    return {
      name: "episode.justWoke",
      contributes: "waking",
      weight: 0.7,
      observedAt: new Date(inputs.lastSleepEndedAtMs).toISOString(),
      reason: "wake anchor within stability window",
    };
  },
];

function emptyTotals(): Record<LifeOpsCircadianState, number> {
  return {
    awake: 0,
    winding_down: 0,
    sleeping: 0,
    waking: 0,
    napping: 0,
    unclear: 0,
  };
}

/**
 * Evaluate every rule in the table and aggregate firings by state.
 *
 * Pure; no I/O. The state machine layer is responsible for picking the
 * top bucket, applying stability-window hysteresis, and translating the
 * result into a calibrated confidence.
 */
export function scoreCircadianRules(
  inputs: ScorerInputs,
): CircadianScorerResult {
  const firings: CircadianRuleFiring[] = [];
  const totals = emptyTotals();
  for (const rule of RULES) {
    const firing = rule(inputs);
    if (!firing) continue;
    firings.push(firing);
    totals[firing.contributes] += firing.weight;
  }
  return { firings, totals };
}
