import type { IAgentRuntime } from "@elizaos/core";
import {
  type CircadianScorerResult,
  computeAwakeProbability,
  computePersonalBaseline,
  computeSleepRegularity,
  type LifeOpsActivityWindow,
  type LifeOpsSleepEpisode,
  listHistoricalSleepEpisodes,
  MIN_STABILITY_WINDOW_MS,
  persistSleepEpisodes,
  resolveLifeOpsDayBoundary,
  resolveLifeOpsSleepCycle,
  SLEEP_ONSET_WINDOW_MS,
  type SleepRegularityEpisodeLike,
  scoreCircadianRules,
  WAKE_CONFIRM_WINDOW_MS,
} from "@elizaos/plugin-health";
import {
  LIFEOPS_CIRCADIAN_STATES,
  type LifeOpsActivitySignal,
  type LifeOpsCircadianState,
  type LifeOpsDayBoundary,
  type LifeOpsScheduleInsight,
  type LifeOpsScheduleMealInsight,
  type LifeOpsScheduleMealLabel,
  type LifeOpsSleepCycle,
  type LifeOpsUnclearReason,
} from "@elizaos/shared";
import { listActivityEvents } from "../activity-profile/activity-tracker-repo.js";
import { isSystemInactivityApp } from "../activity-profile/system-inactivity-apps.js";
import { probeContinuityDevices } from "./continuity-probe.js";
import { probeIMessageOutboundActivity } from "./imessage-outbound-probe.js";
import { resolveLifeOpsRelativeTime } from "./relative-time.js";
import type {
  LifeOpsCircadianStateRow,
  LifeOpsRepository,
  LifeOpsScheduleInsightRecord,
} from "./repository.js";
import { getZonedDateParts } from "./time.js";
import { roundConfidence } from "./time-util.js";

const LOOKBACK_MS = 72 * 60 * 60 * 1_000;
const SIGNAL_ACTIVITY_PAD_MS = 3 * 60 * 1_000;
const MERGE_ACTIVITY_GAP_MS = 5 * 60 * 1_000;
const MEAL_GAP_MIN_MS = 15 * 60 * 1_000;
const MEAL_GAP_MAX_MS = 90 * 60 * 1_000;
// An activate event with no follow-up event within this window is treated as
// an implicit deactivate. This stops a single lingering frontmost app from
// masking hours of system sleep — macOS does not fire NSWorkspace deactivate
// on sleep, lock, or screen off, so we bound the window explicitly.
const ACTIVITY_EVENT_MAX_WINDOW_MS = 20 * 60 * 1_000;

type MealCandidate = {
  label: LifeOpsScheduleMealLabel;
  detectedAtMs: number;
  confidence: number;
  source: "activity_gap" | "expected_window" | "health";
};

export type LifeOpsScheduleActivityWindowInspection = {
  startAt: string;
  endAt: string;
  durationMinutes: number;
  source: LifeOpsActivityWindow["source"];
};

export type LifeOpsScheduleSleepEpisodeInspection = {
  startAt: string;
  endAt: string | null;
  durationMinutes: number;
  current: boolean;
  confidence: number;
  source: LifeOpsSleepEpisode["source"];
};

export type LifeOpsScheduleInspection = {
  insight: LifeOpsScheduleInsightRecord;
  windows: LifeOpsScheduleActivityWindowInspection[];
  sleepEpisodes: LifeOpsScheduleSleepEpisodeInspection[];
  sleepCycle: LifeOpsSleepCycle;
  dayBoundary: LifeOpsDayBoundary;
  mealCandidates: LifeOpsScheduleMealInsight[];
  counts: {
    mergedWindowCount: number;
    activitySignalCount: number;
    screenTimeSessionCount: number;
    activityEventCount: number;
  };
};

/**
 * Lightweight read-only summary for UI consumers. Reads cached `life_*`
 * tables; never re-runs inspection probes. The scheduler tick is the sole
 * writer of fresh analyses.
 */
export type LifeOpsScheduleSummary = {
  insight: LifeOpsScheduleInsightRecord | null;
  sleepEpisodes: LifeOpsScheduleSleepEpisodeInspection[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toIso(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) {
    return null;
  }
  return new Date(ms).toISOString();
}

function toDurationMinutes(
  startMs: number,
  endMs: number | null,
  nowMs: number,
): number {
  return Math.round(intervalDurationMs(startMs, endMs, nowMs) / 60_000);
}

function localHour(ms: number, timezone: string): number {
  const parts = getZonedDateParts(new Date(ms), timezone);
  return parts.hour + parts.minute / 60;
}

function normalizeSleepHour(hour: number): number {
  return hour < 12 ? hour + 24 : hour;
}

function intervalDurationMs(
  startMs: number,
  endMs: number | null,
  nowMs: number,
): number {
  const safeEndMs = endMs ?? nowMs;
  return Math.max(0, safeEndMs - startMs);
}

function firstActiveAfterWake(
  windows: LifeOpsActivityWindow[],
  wakeAtMs: number | null,
): number | null {
  if (windows.length === 0) {
    return null;
  }
  if (wakeAtMs === null) {
    return windows[0]?.startMs ?? null;
  }
  const startedAfterWake = windows.find((window) => window.startMs >= wakeAtMs);
  if (startedAfterWake) {
    return startedAfterWake.startMs;
  }
  // A window spanning the wake time should report the wake itself as the first
  // active moment — the window's startMs may fall inside the preceding sleep
  // (e.g. a frontmost app that was never deactivated).
  const spansWake = windows.find(
    (window) => window.startMs < wakeAtMs && window.endMs > wakeAtMs,
  );
  return spansWake ? wakeAtMs : null;
}

function windowsFromActivityEvents(
  events: Awaited<ReturnType<typeof listActivityEvents>>,
  nowMs: number,
): LifeOpsActivityWindow[] {
  if (events.length === 0) {
    return [];
  }
  const timestamps = events.map((event) => Date.parse(event.observedAt));
  const windows: LifeOpsActivityWindow[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const current = events[index];
    if (!current || current.eventKind !== "activate") {
      continue;
    }
    if (isSystemInactivityApp(current)) {
      continue;
    }
    const startMs = timestamps[index] ?? Number.NaN;
    if (!Number.isFinite(startMs)) {
      continue;
    }
    const nextTimestamp = timestamps[index + 1];
    const hasNext =
      index + 1 < timestamps.length &&
      typeof nextTimestamp === "number" &&
      Number.isFinite(nextTimestamp);
    const rawNextMs = hasNext ? (nextTimestamp as number) : nowMs;
    const cap = startMs + ACTIVITY_EVENT_MAX_WINDOW_MS;
    const nextMs = rawNextMs > cap ? cap : rawNextMs;
    if (nextMs <= startMs) {
      continue;
    }
    windows.push({
      startMs,
      endMs: nextMs,
      source: "app",
    });
  }
  return windows;
}

function windowsFromScreenTimeSessions(
  sessions: Awaited<
    ReturnType<LifeOpsRepository["listScreenTimeSessionsOverlapping"]>
  >,
  nowMs: number,
): LifeOpsActivityWindow[] {
  const windows: LifeOpsActivityWindow[] = [];
  for (const session of sessions) {
    const startMs = Date.parse(session.startAt);
    const endMs =
      session.endAt && Number.isFinite(Date.parse(session.endAt))
        ? Date.parse(session.endAt)
        : nowMs;
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      endMs <= startMs
    ) {
      continue;
    }
    windows.push({
      startMs,
      endMs,
      source: session.source,
    });
  }
  return windows;
}

function windowsFromSignals(
  signals: LifeOpsActivitySignal[],
  nowMs: number,
): LifeOpsActivityWindow[] {
  const windows: LifeOpsActivityWindow[] = [];
  for (const signal of signals) {
    if (signal.state !== "active") {
      continue;
    }
    const observedAt = Date.parse(signal.observedAt);
    if (!Number.isFinite(observedAt)) {
      continue;
    }
    const startMs = Math.max(0, observedAt - SIGNAL_ACTIVITY_PAD_MS);
    const endMs = Math.min(nowMs, observedAt + SIGNAL_ACTIVITY_PAD_MS);
    if (endMs <= startMs) {
      continue;
    }
    windows.push({
      startMs,
      endMs,
      source: "signal",
    });
  }
  return windows;
}

function mergeActivityWindows(
  windows: LifeOpsActivityWindow[],
): LifeOpsActivityWindow[] {
  if (windows.length === 0) {
    return [];
  }
  const sorted = [...windows].sort(
    (left, right) => left.startMs - right.startMs,
  );
  const merged: LifeOpsActivityWindow[] = [];
  for (const window of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous) {
      merged.push({ ...window });
      continue;
    }
    if (window.startMs <= previous.endMs + MERGE_ACTIVITY_GAP_MS) {
      previous.endMs = Math.max(previous.endMs, window.endMs);
      if (previous.source !== window.source) {
        previous.source = "signal";
      }
      continue;
    }
    merged.push({ ...window });
  }
  return merged;
}

function inferMealCandidates(args: {
  windows: LifeOpsActivityWindow[];
  wakeAtMs: number | null;
  timezone: string;
}): LifeOpsScheduleMealInsight[] {
  const bestByLabel = new Map<LifeOpsScheduleMealLabel, MealCandidate>();

  for (let index = 0; index < args.windows.length - 1; index += 1) {
    const current = args.windows[index];
    const next = args.windows[index + 1];
    if (!current || !next) {
      continue;
    }
    const gapStartMs = current.endMs;
    const gapEndMs = next.startMs;
    const gapMs = gapEndMs - gapStartMs;
    if (gapMs < MEAL_GAP_MIN_MS || gapMs > MEAL_GAP_MAX_MS) {
      continue;
    }
    if (args.wakeAtMs !== null && gapEndMs <= args.wakeAtMs) {
      continue;
    }

    const midpointMs = gapStartMs + Math.floor(gapMs / 2);
    const durationMinutes = gapMs / 60_000;
    const hour = localHour(midpointMs, args.timezone);
    const minutesSinceWake =
      args.wakeAtMs !== null ? (midpointMs - args.wakeAtMs) / 60_000 : null;
    const continuityBonus =
      current.endMs - current.startMs >= 10 * 60 * 1_000 &&
      next.endMs - next.startMs >= 10 * 60 * 1_000
        ? 0.15
        : 0;
    const durationScore =
      0.2 + clamp(1 - Math.abs(durationMinutes - 35) / 45, 0, 1) * 0.25;

    const scores: Record<LifeOpsScheduleMealLabel, number> = {
      breakfast: durationScore + continuityBonus,
      lunch: durationScore + continuityBonus,
      dinner: durationScore + continuityBonus,
    };

    if (hour >= 5 && hour < 11) {
      scores.breakfast += 0.28;
    }
    if (hour >= 11 && hour < 15) {
      scores.lunch += 0.32;
    }
    if (hour >= 17 && hour < 22) {
      scores.dinner += 0.32;
    }
    if (minutesSinceWake !== null) {
      if (minutesSinceWake >= 30 && minutesSinceWake <= 240) {
        scores.breakfast += 0.22;
      }
      if (minutesSinceWake >= 240 && minutesSinceWake <= 540) {
        scores.lunch += 0.2;
      }
      if (minutesSinceWake >= 540 && minutesSinceWake <= 960) {
        scores.dinner += 0.2;
      }
    }

    const winner = (
      Object.entries(scores) as Array<[LifeOpsScheduleMealLabel, number]>
    )
      .map(([label, score]) => ({
        label,
        score: roundConfidence(score),
      }))
      .sort((left, right) => right.score - left.score)[0];
    if (!winner || winner.score < 0.45) {
      continue;
    }
    const previous = bestByLabel.get(winner.label);
    if (!previous || winner.score > previous.confidence) {
      bestByLabel.set(winner.label, {
        label: winner.label,
        detectedAtMs: midpointMs,
        confidence: winner.score,
        source: "activity_gap",
      });
    }
  }

  return [...bestByLabel.values()]
    .sort((left, right) => left.detectedAtMs - right.detectedAtMs)
    .map((candidate) => ({
      label: candidate.label,
      detectedAt: new Date(candidate.detectedAtMs).toISOString(),
      confidence: candidate.confidence,
      source: candidate.source,
    }));
}

function predictNextMeal(args: {
  meals: LifeOpsScheduleMealInsight[];
  wakeAtMs: number | null;
  nowMs: number;
  timezone: string;
}): {
  nextMealLabel: LifeOpsScheduleMealLabel | null;
  nextMealWindowStartAt: string | null;
  nextMealWindowEndAt: string | null;
  nextMealConfidence: number;
} {
  const mealSet = new Set(args.meals.map((meal) => meal.label));
  const nowHour = localHour(args.nowMs, args.timezone);
  const latestMeal = args.meals.at(-1);
  const latestMealMs =
    latestMeal !== undefined ? Date.parse(latestMeal.detectedAt) : Number.NaN;
  const minutesSinceWake =
    args.wakeAtMs !== null ? (args.nowMs - args.wakeAtMs) / 60_000 : null;
  const minutesSinceMeal = Number.isFinite(latestMealMs)
    ? (args.nowMs - latestMealMs) / 60_000
    : null;

  const buildWindow = (
    label: LifeOpsScheduleMealLabel,
    startMs: number,
    endMs: number,
    confidence: number,
  ) => ({
    nextMealLabel: label,
    nextMealWindowStartAt: new Date(startMs).toISOString(),
    nextMealWindowEndAt: new Date(endMs).toISOString(),
    nextMealConfidence: roundConfidence(confidence),
  });

  if (
    !mealSet.has("breakfast") &&
    args.wakeAtMs !== null &&
    minutesSinceWake !== null &&
    minutesSinceWake >= 20 &&
    minutesSinceWake <= 240
  ) {
    return buildWindow(
      "breakfast",
      Math.max(args.nowMs, args.wakeAtMs + 20 * 60_000),
      args.wakeAtMs + 4 * 60 * 60 * 1_000,
      0.6,
    );
  }
  if (
    !mealSet.has("lunch") &&
    ((nowHour >= 11 && nowHour < 15) ||
      (minutesSinceMeal !== null && minutesSinceMeal >= 180))
  ) {
    return buildWindow(
      "lunch",
      args.nowMs,
      args.nowMs + 2 * 60 * 60 * 1_000,
      0.55,
    );
  }
  if (
    !mealSet.has("dinner") &&
    ((nowHour >= 17 && nowHour < 22) ||
      (minutesSinceMeal !== null && minutesSinceMeal >= 240))
  ) {
    return buildWindow(
      "dinner",
      args.nowMs,
      args.nowMs + 3 * 60 * 60 * 1_000,
      0.52,
    );
  }
  return {
    nextMealLabel: null,
    nextMealWindowStartAt: null,
    nextMealWindowEndAt: null,
    nextMealConfidence: 0,
  };
}

const RULE_STATE_MIN_WEIGHT = 0.7;

function deriveRuleState(
  scorer: CircadianScorerResult,
): { circadianState: LifeOpsCircadianState; stateConfidence: number } | null {
  let bestState: LifeOpsCircadianState | null = null;
  let bestWeight = 0;
  for (const state of LIFEOPS_CIRCADIAN_STATES) {
    if (state === "unclear") continue;
    const weight = scorer.totals[state];
    if (weight > bestWeight) {
      bestState = state;
      bestWeight = weight;
    }
  }
  if (bestState === null || bestWeight < RULE_STATE_MIN_WEIGHT) {
    return null;
  }
  return {
    circadianState: bestState,
    stateConfidence: roundConfidence(Math.min(bestWeight, 0.95)),
  };
}

/**
 * Enforces the stability-window policy from `sleep-wake-spec.md` section 4:
 *
 *   - Manual override: bypass (instant).
 *   - (sleeping|napping) -> waking: bypass (wake must never be delayed).
 *   - waking -> awake: requires WAKE_CONFIRM_WINDOW_MS dwell.
 *   - (awake|winding_down) -> (sleeping|napping): requires SLEEP_ONSET_WINDOW_MS dwell.
 *   - Any other transition: requires MIN_STABILITY_WINDOW_MS dwell.
 *
 * Returns the incoming state when the transition is allowed, or the prior
 * state (with uncertaintyReason="stale_state") when the dwell requirement
 * isn't met yet.
 */
export function enforceStabilityWindow(args: {
  incoming: {
    circadianState: LifeOpsCircadianState;
    stateConfidence: number;
    uncertaintyReason: LifeOpsUnclearReason | null;
  };
  prior: { circadianState: LifeOpsCircadianState; enteredAtMs: number } | null;
  hasManualOverride: boolean;
  nowMs: number;
}): {
  circadianState: LifeOpsCircadianState;
  stateConfidence: number;
  uncertaintyReason: LifeOpsUnclearReason | null;
} {
  if (args.hasManualOverride || !args.prior) return args.incoming;
  if (args.prior.circadianState === args.incoming.circadianState)
    return args.incoming;

  const dwellMs = args.nowMs - args.prior.enteredAtMs;
  const from = args.prior.circadianState;
  const to = args.incoming.circadianState;

  if ((from === "sleeping" || from === "napping") && to === "waking") {
    return args.incoming;
  }

  let required = MIN_STABILITY_WINDOW_MS;
  if (from === "waking" && to === "awake") required = WAKE_CONFIRM_WINDOW_MS;
  if (
    (from === "awake" || from === "winding_down") &&
    (to === "sleeping" || to === "napping")
  ) {
    required = SLEEP_ONSET_WINDOW_MS;
  }
  if (dwellMs >= required) return args.incoming;

  return {
    circadianState: from,
    stateConfidence: Math.min(args.incoming.stateConfidence, 0.6),
    uncertaintyReason: "stale_state",
  };
}

interface CircadianDecision {
  circadianState: LifeOpsCircadianState;
  stateConfidence: number;
  uncertaintyReason: LifeOpsUnclearReason | null;
}

interface CircadianDecisionInputs {
  nowMs: number;
  timezone: string;
  wakeAtMs: number | null;
  lastActiveAtMs: number | null;
  sleepCycle: LifeOpsSleepCycle;
  awakeProbability: LifeOpsScheduleInsight["awakeProbability"];
  regularity: LifeOpsScheduleInsight["regularity"];
  baseline: LifeOpsScheduleInsight["baseline"];
  signalCount: number;
  windowCount: number;
  scorer: CircadianScorerResult;
}

/**
 * Ordered decision table. Returns the first matching state plus a flag that
 * tells the stability-window layer whether to bypass the dwell check (only
 * true for explicit manual overrides).
 */
function decideCircadianState(args: CircadianDecisionInputs): {
  decision: CircadianDecision;
  hasManualOverride: boolean;
} {
  const manual = args.scorer.firings.find((f) => f.name === "manual.override");
  if (manual) {
    return {
      decision: {
        circadianState: manual.contributes,
        stateConfidence: 0.99,
        uncertaintyReason: null,
      },
      hasManualOverride: true,
    };
  }

  const ruleState = deriveRuleState(args.scorer);
  const { sleepCycle, awakeProbability: ap } = args;

  if (sleepCycle.isProbablySleeping || ap.pAsleep >= 0.65) {
    return {
      decision: {
        circadianState:
          ruleState?.circadianState === "sleeping"
            ? "sleeping"
            : sleepCycle.cycleType === "nap"
              ? "napping"
              : "sleeping",
        stateConfidence: roundConfidence(
          Math.max(sleepCycle.sleepConfidence, ap.pAsleep),
        ),
        uncertaintyReason: null,
      },
      hasManualOverride: false,
    };
  }

  if (args.wakeAtMs !== null && args.nowMs - args.wakeAtMs <= 90 * 60 * 1_000) {
    return {
      decision: {
        circadianState: "waking",
        stateConfidence: roundConfidence(Math.max(ap.pAwake, 0.62)),
        uncertaintyReason: null,
      },
      hasManualOverride: false,
    };
  }

  const nowHour = normalizeSleepHour(localHour(args.nowMs, args.timezone));
  const bedtimeHour = args.baseline?.medianBedtimeLocalHour ?? null;
  if (
    bedtimeHour !== null &&
    nowHour >= bedtimeHour - 2 &&
    nowHour <= bedtimeHour + 4
  ) {
    return {
      decision: {
        circadianState: "winding_down",
        stateConfidence: roundConfidence(Math.max(ap.pAwake, 0.5)),
        uncertaintyReason: null,
      },
      hasManualOverride: false,
    };
  }

  const recentlyActive =
    args.lastActiveAtMs !== null &&
    args.nowMs - args.lastActiveAtMs <= 2 * 60 * 60 * 1_000;
  if (ap.pAwake >= 0.65 || recentlyActive) {
    return {
      decision: {
        circadianState: "awake",
        stateConfidence: roundConfidence(Math.max(ap.pAwake, 0.55)),
        uncertaintyReason: null,
      },
      hasManualOverride: false,
    };
  }

  if (ruleState) {
    return {
      decision: { ...ruleState, uncertaintyReason: null },
      hasManualOverride: false,
    };
  }

  const uncertaintyReason: LifeOpsUnclearReason =
    args.signalCount === 0 && args.windowCount === 0
      ? "no_signals"
      : args.regularity.regularityClass === "insufficient_data"
        ? "insufficient_history"
        : "contradictory_signals";
  return {
    decision: {
      circadianState: "unclear",
      stateConfidence: roundConfidence(ap.pUnknown),
      uncertaintyReason,
    },
    hasManualOverride: false,
  };
}

/**
 * Pick the decision-table result then run it through the stability-window
 * hysteresis against the persisted prior state row.
 */
function deriveCircadianState(
  args: CircadianDecisionInputs & {
    priorState: {
      circadianState: LifeOpsCircadianState;
      enteredAtMs: number;
    } | null;
  },
): CircadianDecision {
  const { decision, hasManualOverride } = decideCircadianState(args);
  return enforceStabilityWindow({
    incoming: decision,
    prior: args.priorState,
    hasManualOverride,
    nowMs: args.nowMs,
  });
}

function toHistoricalSleepEpisodes(
  episodes: readonly LifeOpsSleepEpisode[],
): SleepRegularityEpisodeLike[] {
  return episodes.map((episode) => ({
    startAt: new Date(episode.startMs).toISOString(),
    endAt: toIso(episode.endMs),
    cycleType:
      episode.endMs !== null &&
      intervalDurationMs(episode.startMs, episode.endMs, episode.endMs) <
        4 * 60 * 60 * 1_000
        ? "nap"
        : "unknown",
  }));
}

/**
 * Translate a persisted `life_circadian_states` row into the
 * `deriveCircadianState` prior-state shape, applying the stale-state downgrade
 * from `sleep-wake-spec.md` section 5: if the row is older than
 * {@link STALE_CIRCADIAN_STATE_MS} (default 6h) or already `unclear`, skip the
 * stability-window check entirely so a stale process doesn't pin the state.
 */
export const STALE_CIRCADIAN_STATE_MS = 6 * 60 * 60 * 1_000;

export function resolvePriorStateForDerivation(
  row: LifeOpsCircadianStateRow | null,
  nowMs: number,
): {
  circadianState: LifeOpsCircadianState;
  enteredAtMs: number;
} | null {
  if (!row) return null;
  if (row.circadianState === "unclear") return null;
  const enteredAtMs = Date.parse(row.enteredAt);
  if (!Number.isFinite(enteredAtMs)) return null;
  const updatedAtMs = Date.parse(row.updatedAt);
  const ageMs =
    Number.isFinite(updatedAtMs) && updatedAtMs > enteredAtMs
      ? nowMs - updatedAtMs
      : nowMs - enteredAtMs;
  if (ageMs >= STALE_CIRCADIAN_STATE_MS) return null;
  return { circadianState: row.circadianState, enteredAtMs };
}

export function inferLifeOpsScheduleInsight(args: {
  nowMs: number;
  timezone: string;
  windows: LifeOpsActivityWindow[];
  signals: LifeOpsActivitySignal[];
  priorState?: {
    circadianState: LifeOpsCircadianState;
    enteredAtMs: number;
  } | null;
}): LifeOpsScheduleInsight {
  return analyzeLifeOpsScheduleInsight(args).insight;
}

function analyzeLifeOpsScheduleInsight(args: {
  nowMs: number;
  timezone: string;
  windows: LifeOpsActivityWindow[];
  signals: LifeOpsActivitySignal[];
  historicalSleepEpisodes?: readonly SleepRegularityEpisodeLike[];
  priorState?: {
    circadianState: LifeOpsCircadianState;
    enteredAtMs: number;
  } | null;
}): {
  insight: LifeOpsScheduleInsight;
  mergedWindows: LifeOpsActivityWindow[];
  sleepCycle: LifeOpsSleepCycle;
  dayBoundary: LifeOpsDayBoundary;
  sleepEpisodes: LifeOpsSleepEpisode[];
  meals: LifeOpsScheduleMealInsight[];
} {
  const mergedWindows = mergeActivityWindows(args.windows);
  const sleepResolution = resolveLifeOpsSleepCycle({
    nowMs: args.nowMs,
    timezone: args.timezone,
    windows: mergedWindows,
    signals: args.signals,
  });
  const sleepCycle = sleepResolution.sleepCycle;
  const dayBoundary = resolveLifeOpsDayBoundary({
    nowMs: args.nowMs,
    timezone: args.timezone,
    sleepCycle,
  });
  const wakeAtMs =
    sleepCycle.lastSleepEndedAt !== null
      ? Date.parse(sleepCycle.lastSleepEndedAt)
      : null;
  const firstActiveAtMs = firstActiveAfterWake(mergedWindows, wakeAtMs);
  const lastActiveAtMs = mergedWindows.at(-1)?.endMs ?? null;
  const meals = inferMealCandidates({
    windows: mergedWindows,
    wakeAtMs,
    timezone: args.timezone,
  });
  const nextMeal = predictNextMeal({
    meals,
    wakeAtMs,
    nowMs: args.nowMs,
    timezone: args.timezone,
  });

  const historicalEpisodes =
    args.historicalSleepEpisodes ??
    toHistoricalSleepEpisodes(sleepResolution.sleepEpisodes);
  const regularity = computeSleepRegularity({
    episodes: historicalEpisodes,
    timezone: args.timezone,
    nowMs: args.nowMs,
  });
  const baseline = computePersonalBaseline({
    episodes: historicalEpisodes,
    timezone: args.timezone,
    nowMs: args.nowMs,
  });
  const awakeProbability = computeAwakeProbability({
    nowMs: args.nowMs,
    timezone: args.timezone,
    signals: args.signals,
    windows: mergedWindows,
    sleepCycle,
    regularity,
  });
  const scorerResult = scoreCircadianRules({
    nowMs: args.nowMs,
    timezone: args.timezone,
    signals: args.signals,
    windows: mergedWindows,
    baseline,
    regularityClass: regularity.regularityClass,
    hasCurrentSleepEpisode: sleepCycle.isProbablySleeping,
    currentSleepStartedAtMs:
      sleepCycle.currentSleepStartedAt !== null
        ? Date.parse(sleepCycle.currentSleepStartedAt)
        : null,
    lastSleepEndedAtMs: wakeAtMs,
    currentEpisodeLikelyNap: sleepCycle.cycleType === "nap",
  });
  const { circadianState, stateConfidence, uncertaintyReason } =
    deriveCircadianState({
      nowMs: args.nowMs,
      timezone: args.timezone,
      wakeAtMs,
      lastActiveAtMs,
      sleepCycle,
      awakeProbability,
      regularity,
      baseline,
      signalCount: args.signals.length,
      windowCount: mergedWindows.length,
      scorer: scorerResult,
      priorState: args.priorState ?? null,
    });

  const sleepStatus = sleepCycle.sleepStatus;
  const effectiveDayKey = dayBoundary.effectiveDayKey;
  const wakeAt = sleepCycle.lastSleepEndedAt;
  const relativeTime = resolveLifeOpsRelativeTime({
    nowMs: args.nowMs,
    timezone: args.timezone,
    dayBoundary,
    schedule: {
      circadianState,
      stateConfidence,
      uncertaintyReason,
      awakeProbability,
      regularity,
      baseline,
      sleepConfidence: sleepCycle.sleepConfidence,
      currentSleepStartedAt: sleepCycle.currentSleepStartedAt,
      lastSleepStartedAt: sleepCycle.lastSleepStartedAt,
      lastSleepEndedAt: sleepCycle.lastSleepEndedAt,
      wakeAt,
      firstActiveAt: toIso(firstActiveAtMs),
    },
  });

  const circadianRuleFirings = [...scorerResult.firings].sort(
    (left, right) => right.weight - left.weight,
  );
  return {
    insight: {
      effectiveDayKey,
      localDate: dayBoundary.localDate,
      timezone: args.timezone,
      inferredAt: new Date(args.nowMs).toISOString(),
      circadianState,
      stateConfidence,
      uncertaintyReason,
      relativeTime,
      awakeProbability,
      regularity,
      baseline,
      circadianRuleFirings,
      sleepStatus,
      sleepConfidence: Math.max(
        sleepCycle.sleepConfidence,
        awakeProbability.pAsleep,
      ),
      currentSleepStartedAt: sleepCycle.currentSleepStartedAt,
      lastSleepStartedAt: sleepCycle.lastSleepStartedAt,
      lastSleepEndedAt: sleepCycle.lastSleepEndedAt,
      lastSleepDurationMinutes: sleepCycle.lastSleepDurationMinutes,
      wakeAt,
      firstActiveAt: toIso(firstActiveAtMs),
      lastActiveAt: toIso(lastActiveAtMs),
      meals,
      lastMealAt: meals.at(-1)?.detectedAt ?? null,
      nextMealLabel: nextMeal.nextMealLabel,
      nextMealWindowStartAt: nextMeal.nextMealWindowStartAt,
      nextMealWindowEndAt: nextMeal.nextMealWindowEndAt,
      nextMealConfidence: nextMeal.nextMealConfidence,
    },
    mergedWindows,
    sleepCycle,
    dayBoundary,
    sleepEpisodes: sleepResolution.sleepEpisodes,
    meals,
  };
}

export async function inspectLifeOpsSchedule(args: {
  runtime: IAgentRuntime;
  repository: LifeOpsRepository;
  agentId: string;
  timezone: string;
  now?: Date;
}): Promise<LifeOpsScheduleInspection> {
  const now = args.now ?? new Date();
  const nowMs = now.getTime();
  const sinceAt = new Date(nowMs - LOOKBACK_MS).toISOString();
  const untilAt = now.toISOString();
  await probeIMessageOutboundActivity({
    repository: args.repository,
    agentId: args.agentId,
  });
  await probeContinuityDevices({
    repository: args.repository,
    agentId: args.agentId,
    now,
  });
  const priorStateRow = await args.repository.readCircadianState(args.agentId);
  const priorState = resolvePriorStateForDerivation(priorStateRow, nowMs);
  const [signals, sessions, activityEvents] = await Promise.all([
    args.repository.listActivitySignals(args.agentId, {
      sinceAt,
      limit: 1024,
    }),
    args.repository.listScreenTimeSessionsOverlapping(
      args.agentId,
      sinceAt,
      untilAt,
    ),
    listActivityEvents(args.runtime, args.agentId, sinceAt),
  ]);

  const windows = [
    ...windowsFromActivityEvents(activityEvents, nowMs),
    ...windowsFromScreenTimeSessions(sessions, nowMs),
    ...windowsFromSignals(signals, nowMs),
  ];
  // Load the 60-day historical episode roll before inference so baseline and
  // regularity land in a single analysis pass. Freshly-detected episodes are
  // persisted after analysis completes.
  const historicalSleepEpisodes = await listHistoricalSleepEpisodes({
    repository: args.repository,
    agentId: args.agentId,
    nowMs,
    windowDays: 60,
  });
  const analysis = analyzeLifeOpsScheduleInsight({
    nowMs,
    timezone: args.timezone,
    windows,
    signals,
    historicalSleepEpisodes,
    priorState,
  });
  await persistSleepEpisodes({
    repository: args.repository,
    agentId: args.agentId,
    episodes: analysis.sleepEpisodes,
    nowMs,
    timezone: args.timezone,
  });
  const record: LifeOpsScheduleInsightRecord = {
    ...analysis.insight,
    id: `lifeops-schedule:${args.agentId}:${analysis.insight.effectiveDayKey}`,
    agentId: args.agentId,
    metadata: {
      mergedWindowCount: analysis.mergedWindows.length,
      activitySignalCount: signals.length,
      screenTimeSessionCount: sessions.length,
      activityEventCount: activityEvents.length,
      sleepCycle: analysis.sleepCycle,
      dayBoundary: analysis.dayBoundary,
      relativeTime: analysis.insight.relativeTime,
    },
    createdAt: untilAt,
    updatedAt: untilAt,
  };
  await args.repository.upsertScheduleInsight(record);

  return {
    insight: record,
    windows: analysis.mergedWindows.map((window) => ({
      startAt: new Date(window.startMs).toISOString(),
      endAt: new Date(window.endMs).toISOString(),
      durationMinutes: toDurationMinutes(window.startMs, window.endMs, nowMs),
      source: window.source,
    })),
    sleepEpisodes: analysis.sleepEpisodes.map((episode) => ({
      startAt: new Date(episode.startMs).toISOString(),
      endAt: toIso(episode.endMs),
      durationMinutes: toDurationMinutes(episode.startMs, episode.endMs, nowMs),
      current: episode.current,
      confidence: episode.confidence,
      source: episode.source,
    })),
    sleepCycle: analysis.sleepCycle,
    dayBoundary: analysis.dayBoundary,
    mealCandidates: analysis.meals,
    counts: {
      mergedWindowCount: analysis.mergedWindows.length,
      activitySignalCount: signals.length,
      screenTimeSessionCount: sessions.length,
      activityEventCount: activityEvents.length,
    },
  };
}

export const __internal = {
  windowsFromActivityEvents,
  firstActiveAfterWake,
  ACTIVITY_EVENT_MAX_WINDOW_MS,
};

/**
 * Lightweight read that only touches cached tables. Safe to call at UI
 * cadence (every minute or on panel mount) without re-running probes.
 * The scheduler tick is the sole writer of fresh analyses via
 * {@link inspectLifeOpsSchedule}.
 *
 * Returns the last 7 days of persisted sleep episodes alongside the
 * current merged state so the UI can render the episode browser without
 * triggering I/O for iMessage / Continuity / NSWorkspace probes.
 */
export async function readScheduleSummary(args: {
  repository: LifeOpsRepository;
  agentId: string;
  timezone: string;
  now?: Date;
}): Promise<LifeOpsScheduleSummary> {
  const now = args.now ?? new Date();
  const nowMs = now.getTime();
  const sevenDaysAgoIso = new Date(
    nowMs - 7 * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const [mergedState, episodes] = await Promise.all([
    args.repository.getScheduleMergedState(
      args.agentId,
      "local",
      args.timezone,
    ),
    args.repository.listSleepEpisodesBetween(
      args.agentId,
      sevenDaysAgoIso,
      now.toISOString(),
      { includeOpen: true, limit: 200 },
    ),
  ]);
  const insight: LifeOpsScheduleInsightRecord | null = mergedState
    ? {
        ...mergedState,
        id: `lifeops-schedule:${args.agentId}:${mergedState.effectiveDayKey}`,
        agentId: args.agentId,
        metadata: {},
      }
    : null;
  return {
    insight,
    sleepEpisodes: episodes.map((episode) => {
      const startMs = Date.parse(episode.startAt);
      const endMs = episode.endAt ? Date.parse(episode.endAt) : null;
      return {
        startAt: episode.startAt,
        endAt: episode.endAt,
        durationMinutes: toDurationMinutes(startMs, endMs, nowMs),
        current: episode.endAt === null,
        confidence: episode.confidence,
        source: episode.source === "manual" ? "activity_gap" : episode.source,
      };
    }),
  };
}

export async function refreshLifeOpsScheduleInsight(args: {
  runtime: IAgentRuntime;
  repository: LifeOpsRepository;
  agentId: string;
  timezone: string;
  now?: Date;
}): Promise<LifeOpsScheduleInsightRecord> {
  const inspection = await inspectLifeOpsSchedule(args);
  return inspection.insight;
}
