import type { IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsActivitySignal,
  LifeOpsDayBoundary,
  LifeOpsScheduleInsight,
  LifeOpsScheduleMealInsight,
  LifeOpsScheduleMealLabel,
  LifeOpsSleepCycle,
} from "@elizaos/shared/contracts/lifeops";
import { listActivityEvents } from "../activity-profile/activity-tracker-repo.js";
import type {
  LifeOpsRepository,
  LifeOpsScheduleInsightRecord,
} from "./repository.js";
import { computeAwakeProbability } from "./awake-probability.js";
import { computeSleepRegularity, type SleepRegularityEpisodeLike } from "./sleep-regularity.js";
import {
  listHistoricalSleepEpisodes,
  persistSleepEpisodes,
} from "./sleep-episode-store.js";
import {
  resolveLifeOpsDayBoundary,
  resolveLifeOpsSleepCycle,
  type LifeOpsActivityWindow,
  type LifeOpsSleepEpisode,
} from "./sleep-cycle.js";
import { resolveLifeOpsRelativeTime } from "./relative-time.js";
import { getZonedDateParts } from "./time.js";

const LOOKBACK_MS = 72 * 60 * 60 * 1_000;
const SIGNAL_ACTIVITY_PAD_MS = 3 * 60 * 1_000;
const MERGE_ACTIVITY_GAP_MS = 5 * 60 * 1_000;
const COMPLETED_SLEEP_GAP_MIN_MS = 3 * 60 * 60 * 1_000;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundConfidence(value: number): number {
  return Math.round(clamp(value, 0, 1) * 100) / 100;
}

function toIso(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) {
    return null;
  }
  return new Date(ms).toISOString();
}

function toDurationMinutes(startMs: number, endMs: number | null, nowMs: number): number {
  return Math.round(intervalDurationMs(startMs, endMs, nowMs) / 60_000);
}

function localHour(ms: number, timezone: string): number {
  const parts = getZonedDateParts(new Date(ms), timezone);
  return parts.hour + parts.minute / 60;
}

function normalizeSleepHour(hour: number): number {
  return hour < 12 ? hour + 24 : hour;
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? null;
  }
  const left = sorted[middle - 1];
  const right = sorted[middle];
  if (left === undefined || right === undefined) {
    return null;
  }
  return Math.round(((left + right) / 2) * 100) / 100;
}

function intervalDurationMs(startMs: number, endMs: number | null, nowMs: number): number {
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
  sessions: Awaited<ReturnType<LifeOpsRepository["listScreenTimeSessionsOverlapping"]>>,
  nowMs: number,
): LifeOpsActivityWindow[] {
  const windows: LifeOpsActivityWindow[] = [];
  for (const session of sessions) {
    const startMs = Date.parse(session.startAt);
    const endMs =
      session.endAt && Number.isFinite(Date.parse(session.endAt))
        ? Date.parse(session.endAt)
        : nowMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
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

function mergeActivityWindows(windows: LifeOpsActivityWindow[]): LifeOpsActivityWindow[] {
  if (windows.length === 0) {
    return [];
  }
  const sorted = [...windows].sort((left, right) => left.startMs - right.startMs);
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

    const winner = (Object.entries(scores) as Array<[LifeOpsScheduleMealLabel, number]>)
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
  const latestMealMs =
    args.meals.length > 0
      ? Date.parse(args.meals[args.meals.length - 1]!.detectedAt)
      : Number.NaN;
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
    return buildWindow("lunch", args.nowMs, args.nowMs + 2 * 60 * 60 * 1_000, 0.55);
  }
  if (
    !mealSet.has("dinner") &&
    ((nowHour >= 17 && nowHour < 22) ||
      (minutesSinceMeal !== null && minutesSinceMeal >= 240))
  ) {
    return buildWindow("dinner", args.nowMs, args.nowMs + 3 * 60 * 60 * 1_000, 0.52);
  }
  return {
    nextMealLabel: null,
    nextMealWindowStartAt: null,
    nextMealWindowEndAt: null,
    nextMealConfidence: 0,
  };
}

function toHistoricalSleepEpisodes(
  episodes: readonly LifeOpsSleepEpisode[],
): SleepRegularityEpisodeLike[] {
  return episodes.map((episode) => ({
    startAt: new Date(episode.startMs).toISOString(),
    endAt: toIso(episode.endMs),
    cycleType:
      episode.endMs !== null &&
      intervalDurationMs(episode.startMs, episode.endMs, episode.endMs) < 4 * 60 * 60 * 1_000
        ? "nap"
        : "unknown",
  }));
}

export function inferLifeOpsScheduleInsight(args: {
  nowMs: number;
  timezone: string;
  windows: LifeOpsActivityWindow[];
  signals: LifeOpsActivitySignal[];
}): LifeOpsScheduleInsight {
  return analyzeLifeOpsScheduleInsight(args).insight;
}

function analyzeLifeOpsScheduleInsight(args: {
  nowMs: number;
  timezone: string;
  windows: LifeOpsActivityWindow[];
  signals: LifeOpsActivitySignal[];
  historicalSleepEpisodes?: readonly SleepRegularityEpisodeLike[];
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
  const lastActiveAtMs =
    mergedWindows.length > 0 ? mergedWindows[mergedWindows.length - 1]!.endMs : null;
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

  const candidateSleepStarts = sleepResolution.sleepEpisodes
    .filter((episode) => intervalDurationMs(episode.startMs, episode.endMs, args.nowMs) >= COMPLETED_SLEEP_GAP_MIN_MS)
    .map((episode) => normalizeSleepHour(localHour(episode.startMs, args.timezone)));
  const candidateWakeHours = sleepResolution.sleepEpisodes
    .filter((episode): episode is LifeOpsSleepEpisode & { endMs: number } => episode.endMs !== null)
    .map((episode) => localHour(episode.endMs, args.timezone));
  const typicalSleepHour = median(candidateSleepStarts);
  const historicalEpisodes =
    args.historicalSleepEpisodes ?? toHistoricalSleepEpisodes(sleepResolution.sleepEpisodes);
  const regularity = computeSleepRegularity({
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

  const phase = (() => {
    if (awakeProbability.pAsleep >= 0.65) {
      return "sleeping" as const;
    }
    if (wakeAtMs !== null && args.nowMs - wakeAtMs <= 90 * 60 * 1_000) {
      return "waking" as const;
    }
    if (
      (regularity.regularityClass === "irregular" ||
        regularity.regularityClass === "very_irregular") &&
      awakeProbability.pUnknown >= 0.4
    ) {
      return "irregular_unknown" as const;
    }
    if (lastActiveAtMs !== null && args.nowMs - lastActiveAtMs >= 2 * 60 * 60 * 1_000) {
      return "offline" as const;
    }
    const nowHour = normalizeSleepHour(localHour(args.nowMs, args.timezone));
    if (typicalSleepHour !== null && nowHour >= typicalSleepHour - 2) {
      return "winding_down" as const;
    }
    if (wakeAtMs !== null && args.nowMs - wakeAtMs < 5 * 60 * 60 * 1_000) {
      return "morning" as const;
    }
    if (localHour(args.nowMs, args.timezone) < 17) {
      return "afternoon" as const;
    }
    return "evening" as const;
  })();

  const sleepStatus = sleepCycle.sleepStatus;
  const effectiveDayKey = dayBoundary.effectiveDayKey;
  const wakeAt = sleepCycle.lastSleepEndedAt;
  const relativeTime = resolveLifeOpsRelativeTime({
    nowMs: args.nowMs,
    timezone: args.timezone,
    dayBoundary,
    schedule: {
      phase,
      awakeProbability,
      regularity,
      isProbablySleeping: sleepCycle.isProbablySleeping,
      sleepConfidence: sleepCycle.sleepConfidence,
      currentSleepStartedAt: sleepCycle.currentSleepStartedAt,
      lastSleepStartedAt: sleepCycle.lastSleepStartedAt,
      lastSleepEndedAt: sleepCycle.lastSleepEndedAt,
      typicalSleepHour,
      wakeAt,
      firstActiveAt: toIso(firstActiveAtMs),
    },
  });

  return {
    insight: {
      effectiveDayKey,
      localDate: dayBoundary.localDate,
      timezone: args.timezone,
      inferredAt: new Date(args.nowMs).toISOString(),
      phase,
      relativeTime,
      awakeProbability,
      regularity,
      sleepStatus,
      isProbablySleeping: awakeProbability.pAsleep >= 0.65,
      sleepConfidence: Math.max(sleepCycle.sleepConfidence, awakeProbability.pAsleep),
      currentSleepStartedAt: sleepCycle.currentSleepStartedAt,
      lastSleepStartedAt: sleepCycle.lastSleepStartedAt,
      lastSleepEndedAt: sleepCycle.lastSleepEndedAt,
      lastSleepDurationMinutes: sleepCycle.lastSleepDurationMinutes,
      typicalWakeHour: median(candidateWakeHours),
      typicalSleepHour,
      wakeAt,
      firstActiveAt: toIso(firstActiveAtMs),
      lastActiveAt: toIso(lastActiveAtMs),
      meals,
      lastMealAt: meals.length > 0 ? meals[meals.length - 1]!.detectedAt : null,
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
  const initialAnalysis = analyzeLifeOpsScheduleInsight({
    nowMs,
    timezone: args.timezone,
    windows,
    signals,
  });
  await persistSleepEpisodes({
    repository: args.repository,
    agentId: args.agentId,
    episodes: initialAnalysis.sleepEpisodes,
    nowMs,
  });
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
