import type {
  LifeOpsSleepCycleEvidenceSource,
  LifeOpsSleepCycleType,
} from "@elizaos/shared";
import {
  createLifeOpsSleepEpisode,
  type LifeOpsSleepEpisodeRecord,
  type SleepEpisodeRepository,
} from "./sleep-episode-types.js";
import {
  classifyLifeOpsSleepCycleType,
  type LifeOpsSleepEpisode,
} from "./sleep-cycle.js";

const EPISODE_SEAL_DELAY_MS = 2 * 60 * 60 * 1_000;

export interface PersistSleepEpisodesArgs {
  repository: SleepEpisodeRepository;
  agentId: string;
  episodes: readonly LifeOpsSleepEpisode[];
  nowMs: number;
  timezone: string;
}

export interface HistoricalSleepEpisode {
  startAt: string;
  endAt: string | null;
  source: LifeOpsSleepCycleEvidenceSource | "manual";
  confidence: number;
  cycleType: LifeOpsSleepCycleType;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function toIso(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  return new Date(value).toISOString();
}

export async function persistSleepEpisodes(
  args: PersistSleepEpisodesArgs,
): Promise<void> {
  for (const episode of args.episodes) {
    const endAt = toIso(episode.endMs);
    const record = createLifeOpsSleepEpisode({
      agentId: args.agentId,
      startAt: new Date(episode.startMs).toISOString(),
      endAt,
      source: episode.source,
      confidence: round(episode.confidence),
      cycleType: classifyLifeOpsSleepCycleType({
        startMs: episode.startMs,
        endMs: episode.endMs,
        nowMs: args.nowMs,
        timezone: args.timezone,
      }),
      sealed:
        episode.endMs !== null &&
        args.nowMs - episode.endMs >= EPISODE_SEAL_DELAY_MS,
      evidence: [
        {
          startAt: new Date(episode.startMs).toISOString(),
          endAt,
          source: episode.source,
          confidence: round(episode.confidence),
        },
      ],
    });
    await args.repository.upsertSleepEpisode(record);
  }
}

export async function listHistoricalSleepEpisodes(args: {
  repository: SleepEpisodeRepository;
  agentId: string;
  nowMs: number;
  windowDays?: number;
}): Promise<HistoricalSleepEpisode[]> {
  const windowDays = args.windowDays ?? 60;
  const startAt = new Date(
    args.nowMs - windowDays * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const endAt = new Date(args.nowMs).toISOString();
  const rows = await args.repository.listSleepEpisodesBetween(
    args.agentId,
    startAt,
    endAt,
    { includeOpen: true },
  );
  return rows.map((row: LifeOpsSleepEpisodeRecord) => ({
    startAt: row.startAt,
    endAt: row.endAt,
    source: row.source,
    confidence: row.confidence,
    cycleType: row.cycleType,
  }));
}
