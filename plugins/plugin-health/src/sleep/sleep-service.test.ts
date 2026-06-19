import { describe, expect, it, vi } from "vitest";
import type { LifeOpsSleepEpisodeRecord } from "./sleep-episode-types.js";
import { createHealthSleepServiceMethods } from "./sleep-service.js";

const nowMs = Date.parse("2026-06-02T12:00:00.000Z");

function episode(
  params: Partial<LifeOpsSleepEpisodeRecord>,
): LifeOpsSleepEpisodeRecord {
  return {
    id: params.id ?? "sleep-1",
    agentId: "agent-1",
    startAt: params.startAt ?? "2026-06-01T22:00:00.000Z",
    endAt:
      params.endAt === undefined ? "2026-06-02T06:00:00.000Z" : params.endAt,
    source: params.source ?? "activity_gap",
    confidence: params.confidence ?? 0.8,
    cycleType: params.cycleType ?? "overnight",
    sealed: true,
    evidence: [],
    createdAt: "2026-06-02T06:00:00.000Z",
    updatedAt: "2026-06-02T06:00:00.000Z",
  };
}

describe("createHealthSleepServiceMethods", () => {
  it("builds sleep history responses and filters naps by default", async () => {
    const listSleepEpisodesBetween = vi.fn().mockResolvedValue([
      episode({ id: "overnight" }),
      episode({
        id: "nap",
        startAt: "2026-06-01T20:00:00.000Z",
        endAt: "2026-06-01T20:30:00.000Z",
        cycleType: "nap",
      }),
      episode({
        id: "open",
        startAt: "2026-06-02T07:00:00.000Z",
        endAt: null,
      }),
    ]);
    const service = createHealthSleepServiceMethods({
      repository: { listSleepEpisodesBetween },
      agentId: "agent-1",
      resolveTimeZone: () => "UTC",
      nowMs: () => nowMs,
    });

    const response = await service.getSleepHistory({ windowDays: 7 });

    expect(listSleepEpisodesBetween).toHaveBeenCalledWith(
      "agent-1",
      "2026-05-26T12:00:00.000Z",
      "2026-06-02T12:00:00.000Z",
      { includeOpen: true },
    );
    expect(response.episodes.map((item) => item.id)).toEqual([
      "overnight",
      "open",
    ]);
    expect(response.summary).toEqual({
      cycleCount: 2,
      averageDurationMin: 480,
      overnightCount: 2,
      napCount: 0,
      openCount: 1,
    });
  });

  it("returns null personal baseline fields when there are too few samples", async () => {
    const service = createHealthSleepServiceMethods({
      repository: { listSleepEpisodesBetween: vi.fn().mockResolvedValue([]) },
      agentId: "agent-1",
      resolveTimeZone: () => "UTC",
      nowMs: () => nowMs,
    });

    await expect(
      service.getPersonalBaseline({ windowDays: 14 }),
    ).resolves.toEqual({
      medianBedtimeLocalHour: null,
      medianWakeLocalHour: null,
      medianSleepDurationMin: null,
      bedtimeStddevMin: null,
      wakeStddevMin: null,
      sampleSize: 0,
      windowDays: 14,
    });
  });
});
