/**
 * Cascade per-Scene grounding cache (#9105 M5 — predict/ground split).
 *
 * Grounding the same target on the same Scene is deterministic, so the cheap
 * GROUND step is memoized: a repeat ground on the same Scene reuses the coords
 * without re-running OCR/AX resolution or the (possibly model-backed) actor. A
 * new Scene (new timestamp) invalidates the cache.
 */

import { describe, expect, it } from "vitest";
import type { Actor } from "../actor/actor.js";
import { Brain } from "../actor/brain.js";
import { Cascade } from "../actor/cascade.js";
import type { DisplayCapture } from "../platform/capture.js";
import type { Scene } from "../scene/scene-types.js";

function scene(timestamp = 1): Scene {
  return {
    timestamp,
    displays: [
      {
        id: 0,
        bounds: [0, 0, 1920, 1080],
        scaleFactor: 1,
        primary: true,
        name: "f",
      },
    ],
    focused_window: null,
    apps: [],
    ocr: [
      {
        id: "t0-1",
        text: "Save",
        bbox: [100, 200, 80, 32],
        conf: 0.97,
        displayId: 0,
      },
    ],
    ax: [],
    vlm_scene: null,
    vlm_elements: null,
  };
}

function captures(): Map<number, DisplayCapture> {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const m = new Map<number, DisplayCapture>();
  m.set(0, {
    display: {
      id: 0,
      bounds: [0, 0, 1920, 1080],
      scaleFactor: 1,
      primary: true,
      name: "f",
    },
    frame: Buffer.concat([sig, Buffer.alloc(56, 1)]),
  });
  return m;
}

const BRAIN_OUT = {
  scene_summary: "s",
  target_display_id: 0,
  roi: [{ displayId: 0, bbox: [100, 200, 80, 32], reason: "r" }],
  proposed_action: { kind: "click", ref: "t0-1", rationale: "Save" },
};

function fakeBrain(): Brain {
  return new Brain(null, {
    invokeModel: async () => JSON.stringify(BRAIN_OUT),
  });
}

function countingActor(counter: { calls: number }): Actor {
  return {
    name: "counting",
    async ground() {
      counter.calls += 1;
      return { displayId: 0, x: 140, y: 216, confidence: 1, reason: "refined" };
    },
  };
}

describe("Cascade grounding cache (M5)", () => {
  it("reuses grounding for the same target on the same Scene", async () => {
    const counter = { calls: 0 };
    const cascade = new Cascade({
      brain: fakeBrain(),
      actor: countingActor(counter),
    });
    const s = scene(1);
    const r1 = await cascade.run({
      scene: s,
      goal: "save",
      captures: captures(),
    });
    const r2 = await cascade.run({
      scene: s,
      goal: "save",
      captures: captures(),
    });
    expect(counter.calls).toBe(1); // 2nd ground served from cache
    expect(r2.proposed.x).toBe(r1.proposed.x);
    expect(r2.proposed.y).toBe(r1.proposed.y);
    expect(cascade.getGroundStats()).toEqual({ hits: 1, misses: 1 });
  });

  it("re-grounds when the Scene changes (cache invalidated by timestamp)", async () => {
    const counter = { calls: 0 };
    const cascade = new Cascade({
      brain: fakeBrain(),
      actor: countingActor(counter),
    });
    await cascade.run({ scene: scene(1), goal: "save", captures: captures() });
    await cascade.run({ scene: scene(2), goal: "save", captures: captures() });
    expect(counter.calls).toBe(2);
    expect(cascade.getGroundStats()).toEqual({ hits: 0, misses: 2 });
  });
});
