/**
 * `SleepEpisodeRepository` domain helpers — pure sleep-episode construction and
 * classification with no SQL coupling; the host supplies the persistence adapter.
 */
import type {
  LifeOpsSleepCycleEvidenceSource,
  LifeOpsSleepCycleType,
} from "../contracts/health.js";
import {
  classifyLifeOpsSleepCycleType,
  type LifeOpsSleepEpisode,
} from "./sleep-cycle.js";
import {
  createLifeOpsSleepEpisode,
  type LifeOpsSleepEpisodeRecord,
  type SleepEpisodeRepository,
} from "./sleep-episode-types.js";

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
  const reportedStartMs = new Set<number>();
  for (const episode of args.episodes) {
    reportedStartMs.add(episode.startMs);
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
  // An open row is closed only by a later analysis that reports the same
  // start. When the analysis drops that sleep (a gap that ended short of a
  // completed sleep), nothing else closes the row and it reads as current
  // sleep forever, so remove it.
  const nowIso = new Date(args.nowMs).toISOString();
  const stored = await args.repository.listSleepEpisodesBetween(
    args.agentId,
    nowIso,
    nowIso,
    { includeOpen: true },
  );
  for (const row of stored) {
    if (
      row.endAt === null &&
      row.source !== "manual" &&
      !reportedStartMs.has(Date.parse(row.startAt))
    ) {
      await args.repository.deleteOpenSleepEpisode(args.agentId, row.id);
    }
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
