import { describe, expect, it } from "vitest";
import {
  createLifeOpsHealthMetricSample,
  createLifeOpsHealthSleepEpisode,
  createLifeOpsHealthSyncState,
  createLifeOpsHealthWorkout,
} from "./health-records";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isIso(value: string): boolean {
  return new Date(value).toISOString() === value;
}

describe("health record factories", () => {
  it("creates a metric sample with a stable id and ISO timestamps", () => {
    const sample = createLifeOpsHealthMetricSample({
      type: "heart_rate",
      value: 72,
      unit: "bpm",
    });
    expect(sample.id).toMatch(UUID_RE);
    expect(isIso(sample.createdAt)).toBe(true);
    expect(isIso(sample.updatedAt)).toBe(true);
    expect(sample.createdAt).toBe(sample.updatedAt);
    expect(sample.type).toBe("heart_rate");
    expect(sample.value).toBe(72);
    expect(sample.unit).toBe("bpm");
  });

  it("creates a workout record with id and timestamps", () => {
    const workout = createLifeOpsHealthWorkout({
      kind: "walking",
      durationMinutes: 30,
    });
    expect(workout.id).toMatch(UUID_RE);
    expect(isIso(workout.createdAt)).toBe(true);
    expect(workout.createdAt).toBe(workout.updatedAt);
    expect(workout.kind).toBe("walking");
    expect(workout.durationMinutes).toBe(30);
  });

  it("creates a sleep episode with id and timestamps", () => {
    const episode = createLifeOpsHealthSleepEpisode({
      startedAt: "2026-08-25T22:00:00.000Z",
      endedAt: "2026-08-26T06:00:00.000Z",
    });
    expect(episode.id).toMatch(UUID_RE);
    expect(isIso(episode.createdAt)).toBe(true);
    expect(episode.createdAt).toBe(episode.updatedAt);
    expect(episode.startedAt).toBe("2026-08-25T22:00:00.000Z");
    expect(episode.endedAt).toBe("2026-08-26T06:00:00.000Z");
  });

  it("creates a sync state with id and updatedAt only", () => {
    const state = createLifeOpsHealthSyncState({
      provider: "apple_health",
      lastSyncAt: "2026-08-25T06:30:00.000Z",
    });
    expect(state.id).toMatch(UUID_RE);
    expect(isIso(state.updatedAt)).toBe(true);
    expect(state.provider).toBe("apple_health");
    expect(state.lastSyncAt).toBe("2026-08-25T06:30:00.000Z");
  });

  it("generates a distinct id for every record", () => {
    const ids = new Set(
      Array.from(
        { length: 50 },
        () => createLifeOpsHealthMetricSample({ type: "steps", value: 100 }).id,
      ),
    );
    expect(ids.size).toBe(50);
  });

  it("uses fresh timestamps per call rather than a cached value", () => {
    const first = createLifeOpsHealthMetricSample({ type: "steps", value: 1 });
    const second = createLifeOpsHealthMetricSample({ type: "steps", value: 2 });
    expect(second.createdAt >= first.createdAt).toBe(true);
    expect(second.updatedAt >= first.updatedAt).toBe(true);
  });
});
