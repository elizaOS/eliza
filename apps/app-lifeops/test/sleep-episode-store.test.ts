import { describe, expect, it } from "vitest";
import type { LifeOpsRepository, LifeOpsSleepEpisodeRecord } from "../src/lifeops/repository.js";
import { persistSleepEpisodes } from "../src/lifeops/sleep-episode-store.js";

function repositoryRecorder(records: LifeOpsSleepEpisodeRecord[]): LifeOpsRepository {
  return {
    upsertSleepEpisode: async (episode: LifeOpsSleepEpisodeRecord) => {
      records.push(episode);
    },
  } as unknown as LifeOpsRepository;
}

describe("persistSleepEpisodes", () => {
  it("persists long nighttime episodes as overnight instead of unknown", async () => {
    const records: LifeOpsSleepEpisodeRecord[] = [];

    await persistSleepEpisodes({
      repository: repositoryRecorder(records),
      agentId: "agent-1",
      nowMs: Date.parse("2026-04-19T12:00:00.000Z"),
      timezone: "UTC",
      episodes: [
        {
          startMs: Date.parse("2026-04-18T23:30:00.000Z"),
          endMs: Date.parse("2026-04-19T07:30:00.000Z"),
          current: false,
          confidence: 0.93,
          source: "health",
        },
      ],
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.cycleType).toBe("overnight");
  });

  it("continues persisting short completed episodes as naps", async () => {
    const records: LifeOpsSleepEpisodeRecord[] = [];

    await persistSleepEpisodes({
      repository: repositoryRecorder(records),
      agentId: "agent-1",
      nowMs: Date.parse("2026-04-19T18:00:00.000Z"),
      timezone: "UTC",
      episodes: [
        {
          startMs: Date.parse("2026-04-19T14:00:00.000Z"),
          endMs: Date.parse("2026-04-19T15:15:00.000Z"),
          current: false,
          confidence: 0.88,
          source: "health",
        },
      ],
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.cycleType).toBe("nap");
  });
});
