/**
 * Unit tests for `sleep-episode-store`: tests sleep episode record creation,
 * classification, confidence rounding, sealing delay transitions, and
 * historical sleep episode window querying.
 */
import { describe, expect, it, vi } from "vitest";
import {
  listHistoricalSleepEpisodes,
  persistSleepEpisodes,
} from "./sleep-episode-store.ts";
import {
  createLifeOpsSleepEpisode,
  type LifeOpsSleepEpisodeRecord,
  type SleepEpisodeRepository,
} from "./sleep-episode-types.ts";

function createMockRepository(): SleepEpisodeRepository & {
  upsertSleepEpisode: ReturnType<typeof vi.fn>;
  listSleepEpisodesBetween: ReturnType<typeof vi.fn>;
} {
  return {
    upsertSleepEpisode: vi.fn().mockResolvedValue(undefined),
    listSleepEpisodesBetween: vi.fn().mockResolvedValue([]),
  };
}

describe("sleep-episode-types", () => {
  describe("createLifeOpsSleepEpisode", () => {
    it("creates record with generated uuid and ISO timestamps", () => {
      const record = createLifeOpsSleepEpisode({
        agentId: "agent-123",
        startAt: "2026-08-20T22:00:00.000Z",
        endAt: "2026-08-21T06:00:00.000Z",
        source: "health",
        confidence: 0.95,
        cycleType: "overnight",
        sealed: true,
        evidence: [],
      });

      expect(record.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(record.agentId).toBe("agent-123");
      expect(record.startAt).toBe("2026-08-20T22:00:00.000Z");
      expect(record.endAt).toBe("2026-08-21T06:00:00.000Z");
      expect(record.source).toBe("health");
      expect(record.confidence).toBe(0.95);
      expect(record.cycleType).toBe("overnight");
      expect(record.sealed).toBe(true);
      expect(Date.parse(record.createdAt)).toBeGreaterThan(0);
      expect(record.createdAt).toBe(record.updatedAt);
    });
  });
});

describe("sleep-episode-store", () => {
  const BASE_NOW = Date.parse("2026-08-25T12:00:00.000Z");
  const TIMEZONE = "UTC";

  describe("persistSleepEpisodes", () => {
    it("persists ongoing episode with null endMs as unsealed", async () => {
      const repository = createMockRepository();
      const startMs = BASE_NOW - 4 * 3600 * 1000;

      await persistSleepEpisodes({
        repository,
        agentId: "agent-1",
        episodes: [
          {
            startMs,
            endMs: null,
            source: "health",
            confidence: 0.85432,
            current: true,
          },
        ],
        nowMs: BASE_NOW,
        timezone: TIMEZONE,
      });

      expect(repository.upsertSleepEpisode).toHaveBeenCalledTimes(1);
      const saved = repository.upsertSleepEpisode.mock
        .calls[0][0] as LifeOpsSleepEpisodeRecord;

      expect(saved.agentId).toBe("agent-1");
      expect(saved.startAt).toBe(new Date(startMs).toISOString());
      expect(saved.endAt).toBeNull();
      expect(saved.confidence).toBe(0.85);
      expect(saved.sealed).toBe(false);
      expect(saved.evidence).toEqual([
        {
          startAt: new Date(startMs).toISOString(),
          endAt: null,
          source: "health",
          confidence: 0.85,
        },
      ]);
    });

    it("leaves recently ended episode unsealed when within 2-hour delay", async () => {
      const repository = createMockRepository();
      const endMs = BASE_NOW - 1 * 3600 * 1000; // ended 1 hour ago (< 2h)
      const startMs = endMs - 7 * 3600 * 1000;

      await persistSleepEpisodes({
        repository,
        agentId: "agent-1",
        episodes: [
          {
            startMs,
            endMs,
            source: "activity_gap",
            confidence: 0.999,
            current: false,
          },
        ],
        nowMs: BASE_NOW,
        timezone: TIMEZONE,
      });

      const saved = repository.upsertSleepEpisode.mock
        .calls[0][0] as LifeOpsSleepEpisodeRecord;
      expect(saved.endAt).toBe(new Date(endMs).toISOString());
      expect(saved.sealed).toBe(false);
      expect(saved.confidence).toBe(1);
    });

    it("seals episode when endMs is older than 2-hour seal delay", async () => {
      const repository = createMockRepository();
      const endMs = BASE_NOW - 3 * 3600 * 1000; // ended 3 hours ago (>= 2h)
      const startMs = endMs - 8 * 3600 * 1000;

      await persistSleepEpisodes({
        repository,
        agentId: "agent-1",
        episodes: [
          {
            startMs,
            endMs,
            source: "health",
            confidence: 0.9,
            current: false,
          },
        ],
        nowMs: BASE_NOW,
        timezone: TIMEZONE,
      });

      const saved = repository.upsertSleepEpisode.mock
        .calls[0][0] as LifeOpsSleepEpisodeRecord;
      expect(saved.sealed).toBe(true);
      expect(saved.endAt).toBe(new Date(endMs).toISOString());
    });
  });

  describe("listHistoricalSleepEpisodes", () => {
    it("queries repository with default 60-day window and maps records", async () => {
      const repository = createMockRepository();
      const dummyRecord: LifeOpsSleepEpisodeRecord = {
        id: "rec-1",
        agentId: "agent-1",
        startAt: "2026-08-20T23:00:00.000Z",
        endAt: "2026-08-21T07:00:00.000Z",
        source: "health",
        confidence: 0.92,
        cycleType: "overnight",
        sealed: true,
        evidence: [],
        createdAt: "2026-08-21T07:00:00.000Z",
        updatedAt: "2026-08-21T07:00:00.000Z",
      };
      repository.listSleepEpisodesBetween.mockResolvedValue([dummyRecord]);

      const results = await listHistoricalSleepEpisodes({
        repository,
        agentId: "agent-1",
        nowMs: BASE_NOW,
      });

      const expectedStartAt = new Date(
        BASE_NOW - 60 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const expectedEndAt = new Date(BASE_NOW).toISOString();

      expect(repository.listSleepEpisodesBetween).toHaveBeenCalledWith(
        "agent-1",
        expectedStartAt,
        expectedEndAt,
        { includeOpen: true },
      );

      expect(results).toEqual([
        {
          startAt: "2026-08-20T23:00:00.000Z",
          endAt: "2026-08-21T07:00:00.000Z",
          source: "health",
          confidence: 0.92,
          cycleType: "overnight",
        },
      ]);
    });

    it("honors custom windowDays parameter", async () => {
      const repository = createMockRepository();

      await listHistoricalSleepEpisodes({
        repository,
        agentId: "agent-2",
        nowMs: BASE_NOW,
        windowDays: 14,
      });

      const expectedStartAt = new Date(
        BASE_NOW - 14 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const expectedEndAt = new Date(BASE_NOW).toISOString();

      expect(repository.listSleepEpisodesBetween).toHaveBeenCalledWith(
        "agent-2",
        expectedStartAt,
        expectedEndAt,
        { includeOpen: true },
      );
    });
  });
});
