import type {
  LifeOpsActivitySignal,
  LifeOpsDayBoundary,
  LifeOpsHealthSignal,
  LifeOpsSleepCycle,
  LifeOpsSleepCycleEvidence,
  LifeOpsSleepCycleType,
} from "@elizaos/shared/contracts/lifeops";
import {
  buildUtcDateFromLocalParts,
  getLocalDateKey,
  getZonedDateParts,
} from "./time.js";

const COMPLETED_SLEEP_GAP_MIN_MS = 3 * 60 * 60 * 1_000;
const CURRENT_SLEEP_GAP_MIN_MS = 2 * 60 * 60 * 1_000;
const MIN_SLEEP_CONFIDENCE = 0.45;

export type LifeOpsActivityWindow = {
  startMs: number;
  endMs: number;
  source: "app" | "website" | "signal";
};

export type LifeOpsSleepEpisode = {
  startMs: number;
  endMs: number | null;
  current: boolean;
  confidence: number;
  source: "health" | "activity_gap";
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

function intervalDurationMs(
  startMs: number,
  endMs: number | null,
  nowMs: number,
): number {
  const safeEndMs = endMs ?? nowMs;
  return Math.max(0, safeEndMs - startMs);
}

function toIso(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) {
    return null;
  }
  return new Date(ms).toISOString();
}

function localDateKey(ms: number, timezone: string): string {
  return getLocalDateKey(getZonedDateParts(new Date(ms), timezone));
}

function localHour(ms: number, timezone: string): number {
  return getZonedDateParts(new Date(ms), timezone).hour;
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

function resolveHealthSignal(signal: LifeOpsActivitySignal): LifeOpsHealthSignal | null {
  if (signal.health) {
    return signal.health;
  }
  const metadataHealth = isRecord(signal.metadata.health)
    ? (signal.metadata.health as LifeOpsHealthSignal)
    : null;
  return metadataHealth ?? null;
}

function normalizeSleepEndMs(args: {
  asleepAtMs: number;
  awakeAtMs: number;
  durationMinutes: number | null;
}): number | null {
  if (Number.isFinite(args.awakeAtMs) && args.awakeAtMs > args.asleepAtMs) {
    return args.awakeAtMs;
  }
  if (typeof args.durationMinutes === "number" && Number.isFinite(args.durationMinutes)) {
    const durationMs = args.durationMinutes * 60_000;
    if (durationMs > 0) {
      return args.asleepAtMs + durationMs;
    }
  }
  return null;
}

function parseHealthSleepEpisodes(signals: LifeOpsActivitySignal[]): LifeOpsSleepEpisode[] {
  const deduped = new Map<string, LifeOpsSleepEpisode>();
  for (const signal of signals) {
    const health = resolveHealthSignal(signal);
    const sleep = health && isRecord(health.sleep) ? health.sleep : null;
    if (!sleep) {
      continue;
    }
    const asleepAt =
      typeof sleep.asleepAt === "string" ? Date.parse(sleep.asleepAt) : Number.NaN;
    const awakeAt =
      typeof sleep.awakeAt === "string" ? Date.parse(sleep.awakeAt) : Number.NaN;
    const durationMinutes =
      typeof sleep.durationMinutes === "number" && Number.isFinite(sleep.durationMinutes)
        ? sleep.durationMinutes
        : null;
    const observedAt = Date.parse(signal.observedAt);

    if (sleep.isSleeping === true && Number.isFinite(asleepAt)) {
      deduped.set(`health-current:${asleepAt}`, {
        startMs: asleepAt,
        endMs: null,
        current: true,
        confidence: 0.96,
        source: "health",
      });
      continue;
    }

    if (Number.isFinite(asleepAt)) {
      const normalizedEndMs = normalizeSleepEndMs({
        asleepAtMs: asleepAt,
        awakeAtMs: awakeAt,
        durationMinutes,
      });
      if (normalizedEndMs !== null) {
        deduped.set(`health:${asleepAt}:${normalizedEndMs}`, {
          startMs: asleepAt,
          endMs: normalizedEndMs,
          current: false,
          confidence: 0.93,
          source: "health",
        });
        continue;
      }
    }

    if (sleep.isSleeping === true && Number.isFinite(observedAt)) {
      deduped.set(`health-observed:${observedAt}`, {
        startMs: observedAt,
        endMs: null,
        current: true,
        confidence: 0.88,
        source: "health",
      });
    }
  }
  return [...deduped.values()].sort((left, right) => left.startMs - right.startMs);
}

function hasSignalNear(
  signals: LifeOpsActivitySignal[],
  targetMs: number,
  windowMs: number,
  predicate: (signal: LifeOpsActivitySignal) => boolean,
): boolean {
  for (const signal of signals) {
    const observedAt = Date.parse(signal.observedAt);
    if (!Number.isFinite(observedAt)) {
      continue;
    }
    if (Math.abs(observedAt - targetMs) <= windowMs && predicate(signal)) {
      return true;
    }
  }
  return false;
}

function buildGapSleepEpisodes(args: {
  windows: LifeOpsActivityWindow[];
  signals: LifeOpsActivitySignal[];
  nowMs: number;
  timezone: string;
}): LifeOpsSleepEpisode[] {
  const episodes: LifeOpsSleepEpisode[] = [];
  if (args.windows.length === 0) {
    return episodes;
  }

  for (let index = 0; index < args.windows.length; index += 1) {
    const current = args.windows[index];
    if (!current) {
      continue;
    }
    const next = args.windows[index + 1] ?? null;
    const gapStartMs = current.endMs;
    const gapEndMs = next ? next.startMs : args.nowMs;
    const gapMs = Math.max(0, gapEndMs - gapStartMs);
    const currentGap = next === null;
    const minDurationMs = currentGap
      ? CURRENT_SLEEP_GAP_MIN_MS
      : COMPLETED_SLEEP_GAP_MIN_MS;
    if (gapMs < minDurationMs) {
      continue;
    }

    const startHour = localHour(gapStartMs, args.timezone);
    const endHour = localHour(gapEndMs, args.timezone);
    const durationFactor = clamp(gapMs / (8 * 60 * 60 * 1_000), 0, 1);
    let score = 0.3 + durationFactor * 0.35;

    if (startHour >= 20 || startHour < 4) {
      score += 0.15;
    }
    if (endHour >= 4 && endHour < 13) {
      score += 0.15;
    }
    if (
      hasSignalNear(args.signals, gapStartMs, 90 * 60 * 1_000, (signal) => signal.onBattery === false)
    ) {
      score += 0.1;
    }
    if (
      hasSignalNear(
        args.signals,
        gapStartMs,
        45 * 60 * 1_000,
        (signal) =>
          signal.state === "locked" ||
          signal.state === "background" ||
          signal.state === "idle" ||
          signal.state === "sleeping",
      )
    ) {
      score += 0.1;
    }
    if (gapMs < 4 * 60 * 60 * 1_000) {
      score -= 0.1;
    }
    score = roundConfidence(score);
    if (score < MIN_SLEEP_CONFIDENCE) {
      continue;
    }
    episodes.push({
      startMs: gapStartMs,
      endMs: currentGap ? null : gapEndMs,
      current: currentGap,
      confidence: score,
      source: "activity_gap",
    });
  }

  return episodes;
}

function selectLatestCompletedSleep(
  episodes: LifeOpsSleepEpisode[],
  nowMs: number,
): LifeOpsSleepEpisode | null {
  return (
    [...episodes]
      .filter((episode) => episode.endMs !== null && episode.endMs <= nowMs)
      .sort((left, right) => {
        const leftEnd = left.endMs ?? 0;
        const rightEnd = right.endMs ?? 0;
        if (rightEnd !== leftEnd) {
          return rightEnd - leftEnd;
        }
        return right.confidence - left.confidence;
      })[0] ?? null
  );
}

function selectCurrentSleep(episodes: LifeOpsSleepEpisode[]): LifeOpsSleepEpisode | null {
  return (
    [...episodes]
      .filter((episode) => episode.current)
      .sort((left, right) => right.confidence - left.confidence)[0] ?? null
  );
}

function classifySleepType(
  episode: LifeOpsSleepEpisode,
  nowMs: number,
  timezone: string,
): LifeOpsSleepCycleType {
  const endMs = episode.endMs ?? nowMs;
  const durationMs = intervalDurationMs(episode.startMs, episode.endMs, nowMs);
  const durationHours = durationMs / (60 * 60 * 1_000);
  const startHour = localHour(episode.startMs, timezone);
  const endHour = localHour(endMs, timezone);
  if (durationHours >= 4 && (startHour >= 18 || startHour < 6 || endHour <= 11)) {
    return "overnight";
  }
  if (durationHours > 0 && durationHours < 4) {
    return "nap";
  }
  return "unknown";
}

export interface LifeOpsSleepCycleResolution {
  sleepCycle: LifeOpsSleepCycle;
  sleepEpisodes: LifeOpsSleepEpisode[];
  typicalWakeHour: number | null;
  typicalSleepHour: number | null;
}

export function resolveLifeOpsSleepCycle(args: {
  nowMs: number;
  timezone: string;
  windows: LifeOpsActivityWindow[];
  signals: LifeOpsActivitySignal[];
}): LifeOpsSleepCycleResolution {
  const healthEpisodes = parseHealthSleepEpisodes(args.signals);
  const gapEpisodes = buildGapSleepEpisodes({
    windows: args.windows,
    signals: args.signals,
    nowMs: args.nowMs,
    timezone: args.timezone,
  });
  const episodes = [...healthEpisodes, ...gapEpisodes];
  const currentSleep = selectCurrentSleep(episodes);
  const lastCompletedSleep = selectLatestCompletedSleep(episodes, args.nowMs);
  const candidateSleepStarts = episodes
    .filter(
      (episode) =>
        intervalDurationMs(episode.startMs, episode.endMs, args.nowMs) >=
        COMPLETED_SLEEP_GAP_MIN_MS,
    )
    .map((episode) => normalizeSleepHour(localHour(episode.startMs, args.timezone)));
  const candidateWakeHours = episodes
    .filter(
      (episode): episode is LifeOpsSleepEpisode & { endMs: number } =>
        episode.endMs !== null,
    )
    .map((episode) => localHour(episode.endMs, args.timezone));
  const typicalSleepHour = median(candidateSleepStarts);
  const sleepCycle: LifeOpsSleepCycle = {
    cycleType: currentSleep
      ? classifySleepType(currentSleep, args.nowMs, args.timezone)
      : lastCompletedSleep
        ? classifySleepType(lastCompletedSleep, args.nowMs, args.timezone)
        : "unknown",
    sleepStatus:
      currentSleep?.confidence !== undefined && currentSleep.confidence >= 0.55
        ? "sleeping_now"
        : lastCompletedSleep?.endMs && args.nowMs - lastCompletedSleep.endMs <= 30 * 60 * 60 * 1_000
          ? "slept"
          : lastCompletedSleep?.endMs && args.nowMs - lastCompletedSleep.endMs >= 20 * 60 * 60 * 1_000
            ? "likely_missed"
            : "unknown",
    isProbablySleeping:
      currentSleep?.confidence !== undefined && currentSleep.confidence >= 0.55,
    sleepConfidence: roundConfidence(
      currentSleep?.confidence ?? lastCompletedSleep?.confidence ?? 0,
    ),
    currentSleepStartedAt: toIso(currentSleep?.startMs ?? null),
    lastSleepStartedAt: toIso((currentSleep ?? lastCompletedSleep)?.startMs ?? null),
    lastSleepEndedAt: toIso(lastCompletedSleep?.endMs ?? null),
    lastSleepDurationMinutes: (() => {
      const target = currentSleep ?? lastCompletedSleep;
      if (!target) {
        return null;
      }
      return Math.round(
        intervalDurationMs(target.startMs, target.endMs, args.nowMs) / 60_000,
      );
    })(),
    evidence: episodes
      .map(
        (episode): LifeOpsSleepCycleEvidence => ({
          startAt: new Date(episode.startMs).toISOString(),
          endAt: toIso(episode.endMs),
          source: episode.source,
          confidence: episode.confidence,
        }),
      )
      .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt)),
  };

  return {
    sleepCycle,
    sleepEpisodes: episodes,
    typicalWakeHour: median(candidateWakeHours),
    typicalSleepHour,
  };
}

export function resolveLifeOpsDayBoundary(args: {
  nowMs: number;
  timezone: string;
  sleepCycle: Pick<
    LifeOpsSleepCycle,
    "cycleType" | "sleepConfidence" | "currentSleepStartedAt" | "lastSleepStartedAt" | "lastSleepEndedAt"
  >;
}): LifeOpsDayBoundary {
  const nowDate = new Date(args.nowMs);
  const localDateParts = getZonedDateParts(nowDate, args.timezone);
  const startOfDay = buildUtcDateFromLocalParts(args.timezone, {
    year: localDateParts.year,
    month: localDateParts.month,
    day: localDateParts.day,
    hour: 0,
    minute: 0,
    second: 0,
  });
  const nextDateParts = getZonedDateParts(
    new Date(startOfDay.getTime() + 24 * 60 * 60 * 1_000),
    args.timezone,
  );
  const endOfDay = buildUtcDateFromLocalParts(args.timezone, {
    year: nextDateParts.year,
    month: nextDateParts.month,
    day: nextDateParts.day,
    hour: 0,
    minute: 0,
    second: 0,
  });
  const beforeSleepAt =
    args.sleepCycle.currentSleepStartedAt ??
    args.sleepCycle.lastSleepStartedAt ??
    null;
  const overnightAnchor = args.sleepCycle.cycleType === "overnight" && beforeSleepAt;
  const anchor: LifeOpsDayBoundary["anchor"] = overnightAnchor
    ? "before_sleep"
    : "start_of_day";
  const effectiveDaySourceMs =
    args.sleepCycle.cycleType === "overnight" && args.sleepCycle.lastSleepEndedAt
      ? Date.parse(args.sleepCycle.lastSleepEndedAt)
      : args.sleepCycle.currentSleepStartedAt
        ? Date.parse(args.sleepCycle.currentSleepStartedAt)
        : args.nowMs;
  return {
    effectiveDayKey: localDateKey(effectiveDaySourceMs, args.timezone),
    localDate: localDateKey(args.nowMs, args.timezone),
    timezone: args.timezone,
    anchor,
    startOfDayAt: startOfDay.toISOString(),
    endOfDayAt: endOfDay.toISOString(),
    beforeSleepAt,
    confidence: roundConfidence(args.sleepCycle.sleepConfidence),
  };
}
