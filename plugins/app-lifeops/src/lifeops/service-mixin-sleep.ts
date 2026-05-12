import type {
  LifeOpsPersonalBaselineResponse,
  LifeOpsSleepHistoryEpisode,
  LifeOpsSleepHistoryResponse,
  LifeOpsSleepHistorySummary,
  LifeOpsSleepRegularityResponse,
} from "@elizaos/shared";
import { resolveDefaultTimeZone } from "./defaults.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import {
  computePersonalBaseline,
  computeSleepRegularity,
  type SleepRegularityEpisodeLike,
} from "@elizaos/plugin-health";

const DEFAULT_HISTORY_WINDOW_DAYS = 365;
const DEFAULT_REGULARITY_WINDOW_DAYS = 30;
const DEFAULT_BASELINE_WINDOW_DAYS = 28;
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 365;

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

/** @internal */
export function withSleep<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsSleepServiceMixin extends Base {
    /**
     * Returns the persisted historical sleep episode log for the requested
     * window. By default overnight episodes only; pass `includeNaps: true`
     * to include short nap episodes as well.
     */
    async getSleepHistory(opts?: {
      windowDays?: number;
      includeNaps?: boolean;
    }): Promise<LifeOpsSleepHistoryResponse> {
      const windowDays = clampWindowDays(
        opts?.windowDays,
        DEFAULT_HISTORY_WINDOW_DAYS,
      );
      const includeNaps = opts?.includeNaps === true;
      const nowMs = Date.now();
      const startAt = new Date(
        nowMs - windowDays * 24 * 60 * 60 * 1_000,
      ).toISOString();
      const endAt = new Date(nowMs).toISOString();
      const rows = await this.repository.listSleepEpisodesBetween(
        this.agentId(),
        startAt,
        endAt,
        { includeOpen: true },
      );
      const filtered = includeNaps
        ? rows
        : rows.filter((row) => row.cycleType !== "nap");
      const episodes: LifeOpsSleepHistoryEpisode[] = filtered.map((row) => ({
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
    }

    /**
     * Returns the Sleep Regularity Index plus circular standard deviations
     * over the requested window. Defaults to overnight episodes only.
     */
    async getSleepRegularity(opts?: {
      windowDays?: number;
      includeNaps?: boolean;
    }): Promise<LifeOpsSleepRegularityResponse> {
      const windowDays = clampWindowDays(
        opts?.windowDays,
        DEFAULT_REGULARITY_WINDOW_DAYS,
      );
      const includeNaps = opts?.includeNaps === true;
      const episodes = await this.collectRegularityEpisodes({
        windowDays,
        includeNaps,
      });
      const timezone = resolveDefaultTimeZone();
      const regularity = computeSleepRegularity({
        episodes,
        timezone,
        nowMs: Date.now(),
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
    }

    /**
     * Returns the personal baseline (median bedtime, wake, duration) over the
     * requested window. Returns null medians when the underlying baseline has
     * fewer than the required number of episodes.
     */
    async getPersonalBaseline(opts?: {
      windowDays?: number;
    }): Promise<LifeOpsPersonalBaselineResponse> {
      const windowDays = clampWindowDays(
        opts?.windowDays,
        DEFAULT_BASELINE_WINDOW_DAYS,
      );
      const episodes = await this.collectRegularityEpisodes({
        windowDays,
        includeNaps: false,
      });
      const timezone = resolveDefaultTimeZone();
      const baseline = computePersonalBaseline({
        episodes,
        timezone,
        nowMs: Date.now(),
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
    }

    // Cannot be `private` — TS4094 fires when the mixin's anonymous class
    // is re-exported through the composed LifeOpsService.
    async collectRegularityEpisodes(args: {
      windowDays: number;
      includeNaps: boolean;
    }): Promise<SleepRegularityEpisodeLike[]> {
      const nowMs = Date.now();
      const startAt = new Date(
        nowMs - args.windowDays * 24 * 60 * 60 * 1_000,
      ).toISOString();
      const endAt = new Date(nowMs).toISOString();
      const rows = await this.repository.listSleepEpisodesBetween(
        this.agentId(),
        startAt,
        endAt,
        { includeOpen: true },
      );
      const filtered = args.includeNaps
        ? rows
        : rows.filter((row) => row.cycleType !== "nap");
      return filtered.map((row) => ({
        startAt: row.startAt,
        endAt: row.endAt,
        cycleType: row.cycleType,
      }));
    }
  }
  return LifeOpsSleepServiceMixin;
}
