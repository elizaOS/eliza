/**
 * Deterministic in-memory tests for EntityTracker's presence state machine.
 * They pin the "recently left" transition: an entity active in one frame and
 * absent in the next must surface through getRecentlyLeft(), the signal both
 * the VISION_PERCEPTION provider and the describe action feed to the agent.
 * The harness fakes the clock so departure timestamps and cleanup windows are
 * exact; no runtime or native backend is involved.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EntityTracker } from "./entity-tracker";
import type { PersonInfo } from "./types";

function person(x = 100, y = 100): PersonInfo {
  return {
    id: "detection",
    pose: "standing",
    facing: "camera",
    confidence: 0.9,
    boundingBox: { x, y, width: 50, height: 100 },
  };
}

describe("EntityTracker recently-left transition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports an entity that was present then absent, with the departure time", async () => {
    const tracker = new EntityTracker("world-1");

    const [tracked] = await tracker.updateEntities([], [person()]);
    expect(tracker.getRecentlyLeft()).toHaveLength(0);
    expect(tracker.getActiveEntities().map((e) => e.id)).toEqual([tracked.id]);

    vi.advanceTimersByTime(1000);
    const departedAt = Date.now();
    await tracker.updateEntities([], []);

    const recentlyLeft = tracker.getRecentlyLeft();
    expect(recentlyLeft).toHaveLength(1);
    expect(recentlyLeft[0].entity.id).toBe(tracked.id);
    expect(recentlyLeft[0].leftAt).toBe(departedAt);
    expect(tracker.getActiveEntities()).toHaveLength(0);
    expect(tracker.getStatistics().recentlyLeft).toBe(1);
  });

  it("does not report an entity that stays present across frames", async () => {
    const tracker = new EntityTracker("world-1");

    await tracker.updateEntities([], [person()]);
    vi.advanceTimersByTime(500);
    await tracker.updateEntities([], [person()]);

    expect(tracker.getRecentlyLeft()).toHaveLength(0);
    expect(tracker.getActiveEntities()).toHaveLength(1);
  });

  it("clears the recently-left record when the entity reappears", async () => {
    const tracker = new EntityTracker("world-1");

    const [tracked] = await tracker.updateEntities([], [person()]);
    vi.advanceTimersByTime(500);
    await tracker.updateEntities([], []);
    expect(tracker.getRecentlyLeft()).toHaveLength(1);

    // Reappear within the missing threshold so it re-matches the same entity.
    vi.advanceTimersByTime(500);
    await tracker.updateEntities([], [person()]);

    expect(tracker.getRecentlyLeft()).toHaveLength(0);
    const active = tracker.getActiveEntities();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(tracked.id);
  });

  it("ages recently-left records out after the cleanup threshold", async () => {
    const tracker = new EntityTracker("world-1");

    await tracker.updateEntities([], [person()]);
    vi.advanceTimersByTime(1000);
    await tracker.updateEntities([], []);
    expect(tracker.getRecentlyLeft()).toHaveLength(1);

    // Past CLEANUP_THRESHOLD (60s); a subsequent empty frame prunes the record.
    vi.advanceTimersByTime(61_000);
    await tracker.updateEntities([], []);

    expect(tracker.getRecentlyLeft()).toHaveLength(0);
    expect(tracker.getStatistics().recentlyLeft).toBe(0);
  });
});
