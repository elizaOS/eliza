/**
 * WS7 — Cascade (ScreenSeekeR) tests.
 *
 * Validates the orchestrator that takes a stubbed `Brain` and turns its
 * BrainOutput into a concrete `ProposedAction`:
 *
 *   - Non-coordinate actions (`wait`, `finish`, `type`, `hotkey`, `key`)
 *     short-circuit grounding and don't invoke the Actor.
 *   - `click` with a `ref` resolves via OCR/AX deterministic grounding.
 *   - `click` with a ROI and a registered Actor passes the *cropped* PNG
 *     (native resolution, exact bbox slice) to the Actor, and uses its
 *     returned coords (rounded).
 *   - `click` with no ref / no actor falls back to ROI center.
 *   - `scroll` resolves an anchor (ROI center) and forwards dx/dy intact.
 *   - `drag` enforces both endpoints.
 *
 * Memory-arbiter pass-through:
 *   - Repeated identical inputs to `runtime.useModel(IMAGE_DESCRIPTION, ...)`
 *     produce identical `imageUrl` payloads (deterministic base64 of the
 *     same PNG bytes), which is what the WS2 MemoryArbiter content-hashes
 *     on. The cache hit on the arbiter side is its own job; here we just
 *     prove that two identical frames produce two identical model inputs.
 */

import { describe, expect, it } from "vitest";
import { Brain } from "../actor/brain.js";
import { Cascade } from "../actor/cascade.js";
import { OcrCoordinateGroundingActor, type Actor } from "../actor/actor.js";
import type { DisplayCapture } from "../platform/capture.js";
import type { Scene } from "../scene/scene-types.js";

function scene(): Scene {
  return {
    timestamp: 1,
    displays: [
      { id: 0, bounds: [0, 0, 1920, 1080], scaleFactor: 1, primary: true, name: "fake" },
    ],
    focused_window: {
      app: "Editor",
      pid: 1,
      bounds: [0, 0, 1920, 1080],
      title: "Untitled",
      displayId: 0,
    },
    apps: [],
    ocr: [
      { id: "t0-1", text: "Save", bbox: [100, 200, 80, 32], conf: 0.97, displayId: 0 },
      { id: "t0-2", text: "Cancel", bbox: [200, 200, 80, 32], conf: 0.95, displayId: 0 },
      { id: "t0-3", text: "File", bbox: [50, 10, 40, 20], conf: 0.99, displayId: 0 },
    ],
    ax: [
      {
        id: "a0-1",
        role: "button",
        label: "Open",
        bbox: [400, 500, 60, 30],
        actions: ["press"],
        displayId: 0,
      },
    ],
    vlm_scene: null,
    vlm_elements: null,
  };
}

function pngOf(seed: number, sizeBytes = 64): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const body = Buffer.alloc(sizeBytes - sig.length, seed & 0xff);
  return Buffer.concat([sig, body]);
}

function captures(seed = 1): Map<number, DisplayCapture> {
  const m = new Map<number, DisplayCapture>();
  m.set(0, {
    display: {
      id: 0,
      bounds: [0, 0, 1920, 1080],
      scaleFactor: 1,
      primary: true,
      name: "fake",
    },
    frame: pngOf(seed),
  });
  return m;
}

function stubBrain(out: unknown): Brain {
  return new Brain(null, { invokeModel: async () => JSON.stringify(out) });
}

describe("Cascade — non-coordinate actions short-circuit grounding", () => {
  it("wait", async () => {
    const cascade = new Cascade({
      brain: stubBrain({
        scene_summary: "S",
        target_display_id: 0,
        roi: [],
        proposed_action: { kind: "wait", rationale: "loading" },
      }),
    });
    const res = await cascade.run({ scene: scene(), goal: "g", captures: captures() });
    expect(res.proposed.kind).toBe("wait");
    expect(res.proposed.displayId).toBe(0);
    expect(res.proposed.x).toBeUndefined();
  });

  it("finish", async () => {
    const cascade = new Cascade({
      brain: stubBrain({
        scene_summary: "done",
        target_display_id: 0,
        roi: [],
        proposed_action: { kind: "finish", rationale: "" },
      }),
    });
    const res = await cascade.run({ scene: scene(), goal: "g", captures: captures() });
    expect(res.proposed.kind).toBe("finish");
  });

  it("type forwards args.text", async () => {
    const cascade = new Cascade({
      brain: stubBrain({
        scene_summary: "S",
        target_display_id: 0,
        roi: [],
        proposed_action: { kind: "type", args: { text: "hello" }, rationale: "" },
      }),
    });
    const res = await cascade.run({ scene: scene(), goal: "g", captures: captures() });
    expect(res.proposed.kind).toBe("type");
    expect(res.proposed.text).toBe("hello");
  });

  it("hotkey forwards args.keys", async () => {
    const cascade = new Cascade({
      brain: stubBrain({
        scene_summary: "S",
        target_display_id: 0,
        roi: [],
        proposed_action: {
          kind: "hotkey",
          args: { keys: ["ctrl", "s"] },
          rationale: "",
        },
      }),
    });
    const res = await cascade.run({ scene: scene(), goal: "g", captures: captures() });
    expect(res.proposed.kind).toBe("hotkey");
    expect(res.proposed.keys).toEqual(["ctrl", "s"]);
  });

  it("key forwards args.key", async () => {
    const cascade = new Cascade({
      brain: stubBrain({
        scene_summary: "S",
        target_display_id: 0,
        roi: [],
        proposed_action: { kind: "key", args: { key: "Enter" }, rationale: "" },
      }),
    });
    const res = await cascade.run({ scene: scene(), goal: "g", captures: captures() });
    expect(res.proposed.kind).toBe("key");
    expect(res.proposed.key).toBe("Enter");
  });

  it("type without args.text throws", async () => {
    const cascade = new Cascade({
      brain: stubBrain({
        scene_summary: "S",
        target_display_id: 0,
        roi: [],
        proposed_action: { kind: "type", rationale: "" },
      }),
    });
    await expect(
      cascade.run({ scene: scene(), goal: "g", captures: captures() }),
    ).rejects.toThrow(/args.text/);
  });
});

describe("Cascade — click grounding paths", () => {
  it("ref → OCR/AX deterministic grounding resolves to bbox center", async () => {
    const cascade = new Cascade({
      brain: stubBrain({
        scene_summary: "S",
        target_display_id: 0,
        roi: [],
        proposed_action: { kind: "click", ref: "t0-1", rationale: "save" },
      }),
    });
    const res = await cascade.run({ scene: scene(), goal: "g", captures: captures() });
    // Save bbox = [100, 200, 80, 32] -> center = (140, 216)
    expect(res.proposed.kind).toBe("click");
    expect(res.proposed.x).toBe(140);
    expect(res.proposed.y).toBe(216);
  });

  it("ROI + registered Actor: Actor receives the cropped native-resolution PNG", async () => {
    const seenCrops: Buffer[] = [];
    const fakeActor: Actor = {
      name: "fake",
      ground: async (args) => {
        seenCrops.push(args.croppedImage);
        return {
          displayId: args.displayId,
          x: 555.4,
          y: 666.6,
          confidence: 0.9,
          reason: "fake",
        };
      },
    };
    const fakeCrop = (frame: Buffer, bbox: [number, number, number, number]): Buffer => {
      // Concatenate a deterministic tag with bbox so we can assert the bbox
      // we cropped from is the one the Brain asked for.
      return Buffer.concat([
        Buffer.from(`crop:[${bbox.join(",")}]:`, "utf8"),
        frame,
      ]);
    };
    const cascade = new Cascade({
      brain: stubBrain({
        scene_summary: "S",
        target_display_id: 0,
        roi: [{ displayId: 0, bbox: [10, 20, 200, 300], reason: "btn-area" }],
        proposed_action: { kind: "click", rationale: "click btn" },
      }),
      actor: fakeActor,
      crop: fakeCrop,
    });
    const res = await cascade.run({ scene: scene(), goal: "g", captures: captures(42) });
    expect(seenCrops).toHaveLength(1);
    // Crop carries the exact bbox the Brain emitted.
    expect(seenCrops[0]!.toString("utf8", 0, 20)).toBe("crop:[10,20,200,300]");
    // Actor coords are rounded by the cascade.
    expect(res.proposed.x).toBe(555);
    expect(res.proposed.y).toBe(667);
    expect(res.proposed.displayId).toBe(0);
  });

  it("ROI without Actor falls back to ROI center", async () => {
    const cascade = new Cascade({
      brain: stubBrain({
        scene_summary: "S",
        target_display_id: 0,
        roi: [{ displayId: 0, bbox: [100, 200, 80, 40], reason: "r" }],
        proposed_action: { kind: "click", rationale: "click me" },
      }),
    });
    const res = await cascade.run({ scene: scene(), goal: "g", captures: captures() });
    expect(res.proposed.x).toBe(140);
    expect(res.proposed.y).toBe(220);
  });

  it("rois are truncated to the cascade cap in the result", async () => {
    const cascade = new Cascade({
      brain: stubBrain({
        scene_summary: "S",
        target_display_id: 0,
        roi: [
          { displayId: 0, bbox: [100, 200, 80, 40], reason: "r1" },
          { displayId: 0, bbox: [100, 300, 80, 40], reason: "r2" },
          { displayId: 0, bbox: [100, 400, 80, 40], reason: "r3" },
        ],
        proposed_action: { kind: "click", rationale: "x" },
      }),
    });
    const res = await cascade.run({ scene: scene(), goal: "g", captures: captures() });
    expect(res.rois.length).toBeLessThanOrEqual(2);
  });

  it("no ref and no roi → can't resolve a click", async () => {
    const cascade = new Cascade({
      brain: stubBrain({
        scene_summary: "S",
        target_display_id: 0,
        roi: [],
        proposed_action: { kind: "click", rationale: "where?" },
      }),
    });
    await expect(
      cascade.run({ scene: scene(), goal: "g", captures: captures() }),
    ).rejects.toThrow(/could not resolve coordinates/);
  });

  it("scroll forwards (dx, dy) and anchors on ROI center", async () => {
    const cascade = new Cascade({
      brain: stubBrain({
        scene_summary: "S",
        target_display_id: 0,
        roi: [{ displayId: 0, bbox: [100, 100, 200, 200], reason: "scroll-area" }],
        proposed_action: {
          kind: "scroll",
          args: { dx: 0, dy: 3 },
          rationale: "scroll",
        },
      }),
    });
    const res = await cascade.run({ scene: scene(), goal: "g", captures: captures() });
    expect(res.proposed.kind).toBe("scroll");
    expect(res.proposed.x).toBe(200);
    expect(res.proposed.y).toBe(200);
    expect(res.proposed.dx).toBe(0);
    expect(res.proposed.dy).toBe(3);
  });

  it("drag requires start+end endpoints", async () => {
    const cascade = new Cascade({
      brain: stubBrain({
        scene_summary: "S",
        target_display_id: 0,
        roi: [],
        proposed_action: {
          kind: "drag",
          args: { from: { x: 10, y: 20 }, to: { x: 100, y: 200 } },
          rationale: "drag",
        },
      }),
    });
    const res = await cascade.run({ scene: scene(), goal: "g", captures: captures() });
    expect(res.proposed.kind).toBe("drag");
    expect(res.proposed.startX).toBe(10);
    expect(res.proposed.startY).toBe(20);
    expect(res.proposed.x).toBe(100);
    expect(res.proposed.y).toBe(200);
  });
});

describe("Cascade — registered OCR actor end-to-end", () => {
  it("uses OcrCoordinateGroundingActor when the cascade receives one", async () => {
    const actor = new OcrCoordinateGroundingActor(() => scene());
    const cascade = new Cascade({
      brain: stubBrain({
        scene_summary: "S",
        target_display_id: 0,
        roi: [],
        proposed_action: { kind: "click", ref: "t0-2", rationale: "cancel" },
      }),
      actor,
    });
    const res = await cascade.run({ scene: scene(), goal: "g", captures: captures() });
    // Cancel bbox = [200, 200, 80, 32] -> center (240, 216)
    expect(res.proposed.x).toBe(240);
    expect(res.proposed.y).toBe(216);
  });
});

describe("Cascade — memory-arbiter pass-through", () => {
  it("sends the same imageUrl payload for two identical frames", async () => {
    // The cascade asks the Brain to call the model; we inspect the args.
    const seenImageUrls: string[] = [];
    const brain = new Brain(null, {
      invokeModel: async (args) => {
        seenImageUrls.push(args.imageUrl);
        return JSON.stringify({
          scene_summary: "S",
          target_display_id: 0,
          roi: [],
          proposed_action: { kind: "wait", rationale: "" },
        });
      },
    });
    const cascade = new Cascade({ brain });
    const caps = captures(7);
    await cascade.run({ scene: scene(), goal: "g", captures: caps });
    await cascade.run({ scene: scene(), goal: "g", captures: caps });
    expect(seenImageUrls).toHaveLength(2);
    // Same input bytes → identical base64. The WS2 MemoryArbiter content-
    // hashes on this exact payload, which is what enables its cache.
    expect(seenImageUrls[0]).toBe(seenImageUrls[1]);
    expect(seenImageUrls[0]?.startsWith("data:image/png;base64,")).toBe(true);
  });
});
