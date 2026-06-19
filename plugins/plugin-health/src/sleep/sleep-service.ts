import type {
  LifeOpsPersonalBaselineResponse,
  LifeOpsSleepHistoryEpisode,
  LifeOpsSleepHistoryResponse,
  LifeOpsSleepHistorySummary,
  LifeOpsSleepRegularityResponse,
} from "../contracts/health.js";
import type {
  LifeOpsSleepEpisodeRecord,
  SleepEpisodeRepository,
} from "./sleep-episode-types.js";
import {
  computePersonalBaseline,
  computeSleepRegularity,
} from "./sleep-regularity.js";

const DEFAULT_HISTORY_WINDOW_DAYS = 365;
const DEFAULT_REGULARITY_WINDOW_DAYS = 30;
const DEFAULT_BASELINE_WINDOW_DAYS = 28;
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 365;

export interface HealthSleepServiceMethods {
  getSleepHistory(opts?: {
    windowDays?: number;
    includeNaps?: boolean;
  }): Promise<LifeOpsSleepHistoryResponse>;
  getSleepRegularity(opts?: {
    windowDays?: number;
    includeNaps?: boolean;
  }): Promise<LifeOpsSleepRegularityResponse>;
  getPersonalBaseline(opts?: {
    windowDays?: number;
  }): Promise<LifeOpsPersonalBaselineResponse>;
}

export interface CreateHealthSleepServiceMethodsOptions {
  repository: Pick<SleepEpisodeRepository, "listSleepEpisodesBetween">;
  agentId: string;
  resolveTimeZone: () => string;
  nowMs?: () => number;
}

function clampWindowDays(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const integral = Math.floor(value);
  return Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, integral));
}

function durationMinutesFor(
  startAt: string,
  endAt: string | null,
): number | null {
  if (!endAt) {
    return null;
  }
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs
  ) {
    return null;
  }
  return Math.round((endMs - startMs) / 60_000);
}

function summarizeSleepHistory(
  episodes: readonly LifeOpsSleepHistoryEpisode[],
): LifeOpsSleepHistorySummary {
  let totalDuration = 0;
  let durationCount = 0;
  let overnightCount = 0;
  let napCount = 0;
  let openCount = 0;
  for (const episode of episodes) {
    if (episode.cycleType === "overnight") overnightCount += 1;
    if (episode.cycleType === "nap") napCount += 1;
    if (episode.endedAt === null) openCount += 1;
    if (
      typeof episode.durationMin === "number" &&
      Number.isFinite(episode.durationMin)
    ) {
      totalDuration += episode.durationMin;
      durationCount += 1;
    }
  }
  return {
    cycleCount: episodes.length,
    averageDurationMin:
      durationCount > 0 ? Math.round(totalDuration / durationCount) : null,
    overnightCount,
    napCount,
    openCount,
  };
}

function regularityEpisode(row: LifeOpsSleepEpisodeRecord) {
  return {
    startAt: row.startAt,
    endAt: row.endAt,
    cycleType: row.cycleType,
  };
}

export function createHealthSleepServiceMethods(
  options: CreateHealthSleepServiceMethodsOptions,
): HealthSleepServiceMethods {
  const nowMs = options.nowMs ?? (() => Date.now());

  async function listWindowRows(args: {
    windowDays: number;
    includeNaps: boolean;
  }): Promise<LifeOpsSleepEpisodeRecord[]> {
    const now = nowMs();
    const startAt = new Date(
      now - args.windowDays * 24 * 60 * 60 * 1_000,
    ).toISOString();
    const endAt = new Date(now).toISOString();
    const rows = await options.repository.listSleepEpisodesBetween(
      options.agentId,
      startAt,
      endAt,
      { includeOpen: true },
    );
    return args.includeNaps
      ? rows
      : rows.filter((row) => row.cycleType !== "nap");
  }

  return {
    async getSleepHistory(opts) {
      const windowDays = clampWindowDays(
        opts?.windowDays,
        DEFAULT_HISTORY_WINDOW_DAYS,
      );
      const includeNaps = opts?.includeNaps === true;
      const rows = await listWindowRows({ windowDays, includeNaps });
      const episodes: LifeOpsSleepHistoryEpisode[] = rows.map((row) => ({
        id: row.id,
        startedAt: row.startAt,
        endedAt: row.endAt,
        durationMin: durationMinutesFor(row.startAt, row.endAt),
        cycleType: row.cycleType,
        source: row.source,
        confidence: row.confidence,
      }));
      return {
        episodes,
        summary: summarizeSleepHistory(episodes),
        windowDays,
        includeNaps,
      };
    },

    async getSleepRegularity(opts) {
      const windowDays = clampWindowDays(
        opts?.windowDays,
        DEFAULT_REGULARITY_WINDOW_DAYS,
      );
      const includeNaps = opts?.includeNaps === true;
      const episodes = (await listWindowRows({ windowDays, includeNaps })).map(
        regularityEpisode,
      );
      const regularity = computeSleepRegularity({
        episodes,
        timezone: options.resolveTimeZone(),
        nowMs: nowMs(),
        windowDays,
      });
      return {
        sri: regularity.sri,
        classification: regularity.regularityClass,
        bedtimeStddevMin: regularity.bedtimeStddevMin,
        wakeStddevMin: regularity.wakeStddevMin,
        midSleepStddevMin: regularity.midSleepStddevMin,
        sampleSize: regularity.sampleCount,
        windowDays: regularity.windowDays,
      };
    },

    async getPersonalBaseline(opts) {
      const windowDays = clampWindowDays(
        opts?.windowDays,
        DEFAULT_BASELINE_WINDOW_DAYS,
      );
      const episodes = (
        await listWindowRows({ windowDays, includeNaps: false })
      ).map(regularityEpisode);
      const baseline = computePersonalBaseline({
        episodes,
        timezone: options.resolveTimeZone(),
        nowMs: nowMs(),
        windowDays,
      });
      if (!baseline) {
        return {
          medianBedtimeLocalHour: null,
          medianWakeLocalHour: null,
          medianSleepDurationMin: null,
          bedtimeStddevMin: null,
          wakeStddevMin: null,
          sampleSize: episodes.length,
          windowDays,
        };
      }
      return {
        medianBedtimeLocalHour: baseline.medianBedtimeLocalHour,
        medianWakeLocalHour: baseline.medianWakeLocalHour,
        medianSleepDurationMin: baseline.medianSleepDurationMin,
        bedtimeStddevMin: baseline.bedtimeStddevMin,
        wakeStddevMin: baseline.wakeStddevMin,
        sampleSize: baseline.sampleCount,
        windowDays: baseline.windowDays,
      };
    },
  };
}
