/**
 * EntityTracker matching tests: face identity versus position.
 */

import { describe, expect, it } from "vitest";
import { EntityTracker } from "./entity-tracker";
import type { PersonInfo } from "./types";

function person(id: string, x: number, y: number): PersonInfo {
  return {
    id,
    pose: "standing",
    facing: "camera",
    confidence: 0.9,
    boundingBox: { x, y, width: 80, height: 160 },
  };
}

describe("EntityTracker person matching", () => {
  it("creates a new entity for a different known face at the same box", async () => {
    const tracker = new EntityTracker("world");
    const [alice] = await tracker.updateEntities(
      [],
      [person("p1", 100, 100)],
      new Map([["p1", "face-alice"]]),
    );
    const [bob] = await tracker.updateEntities(
      [],
      [person("p1", 100, 100)],
      new Map([["p1", "face-bob"]]),
    );

    expect(bob.id).not.toBe(alice.id);
    expect(bob.attributes.faceId).toBe("face-bob");
    expect(alice.attributes.faceId).toBe("face-alice");
    expect(alice.appearances).toHaveLength(1);
    const state = tracker.getWorldState();
    expect(state.entities.size).toBe(2);
    expect(state.activeEntities).toEqual([bob.id]);
    expect(state.recentlyLeft.map((entry) => entry.entityId)).toEqual([
      alice.id,
    ]);
  });

  it("keeps two different known faces under 100px apart in one frame as two entities", async () => {
    const tracker = new EntityTracker("world");
    const frame = [person("p1", 100, 100), person("p2", 150, 100)];
    const faces = new Map([
      ["p1", "face-alice"],
      ["p2", "face-bob"],
    ]);
    const first = await tracker.updateEntities([], frame, faces);
    const second = await tracker.updateEntities([], frame, faces);

    expect(first[0].id).not.toBe(first[1].id);
    expect(first.map((entity) => entity.attributes.faceId)).toEqual([
      "face-alice",
      "face-bob",
    ]);
    expect(second.map((entity) => entity.id)).toEqual(
      first.map((entity) => entity.id),
    );
    expect(tracker.getWorldState().entities.size).toBe(2);
  });

  it("reuses the entity for the same face far away", async () => {
    const tracker = new EntityTracker("world");
    const faces = new Map([["p1", "face-alice"]]);
    const [near] = await tracker.updateEntities(
      [],
      [person("p1", 0, 0)],
      faces,
    );
    const [far] = await tracker.updateEntities(
      [],
      [person("p1", 1000, 1000)],
      faces,
    );

    expect(far.id).toBe(near.id);
    expect(far.appearances).toHaveLength(2);
    expect(tracker.getWorldState().entities.size).toBe(1);
  });

  it("matches a faceless detection to a known-face entity by position", async () => {
    const tracker = new EntityTracker("world");
    const [alice] = await tracker.updateEntities(
      [],
      [person("p1", 100, 100)],
      new Map([["p1", "face-alice"]]),
    );
    const [faceless] = await tracker.updateEntities(
      [],
      [person("p1", 110, 100)],
    );

    expect(faceless.id).toBe(alice.id);
    expect(faceless.attributes.faceId).toBe("face-alice");
  });

  it("lets a faceless entity adopt a face id on a position match", async () => {
    const tracker = new EntityTracker("world");
    const [faceless] = await tracker.updateEntities(
      [],
      [person("p1", 100, 100)],
    );
    const [carol] = await tracker.updateEntities(
      [],
      [person("p1", 110, 100)],
      new Map([["p1", "face-carol"]]),
    );

    expect(carol.id).toBe(faceless.id);
    expect(carol.attributes.faceId).toBe("face-carol");
    expect(tracker.getWorldState().entities.size).toBe(1);
  });
});
