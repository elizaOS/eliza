/**
 * WS7 — OCR/AX deterministic grounding tests.
 *
 * The `OcrCoordinateGroundingActor` resolves `ref: "t<displayId>-<seq>"` or
 * `ref: "a<displayId>-<seq>"` strings into concrete coordinates from the
 * latest Scene — fully reproducible, no model call.
 *
 * Asserted:
 *   - ref="t0-3" → coordinates that are exactly the bbox center of `t0-3`.
 *   - ref="a0-1" → matches the AX node, not the OCR list.
 *   - missing ref + hint label match → falls back to label search.
 *   - cross-display preference: when a label appears on two displays, prefer
 *     the requested `preferredDisplay`.
 *   - `resolveReference` returns null on absolute miss.
 */

import { describe, expect, it } from "vitest";
import {
  OcrCoordinateGroundingActor,
  resolveReference,
} from "../actor/actor.js";
import type { Scene } from "../scene/scene-types.js";

function multiDisplayScene(): Scene {
  return {
    timestamp: 1,
    displays: [
      { id: 0, bounds: [0, 0, 1920, 1080], scaleFactor: 1, primary: true, name: "p" },
      { id: 1, bounds: [1920, 0, 2560, 1440], scaleFactor: 1, primary: false, name: "s" },
    ],
    focused_window: null,
    apps: [],
    ocr: [
      { id: "t0-1", text: "Save", bbox: [100, 100, 60, 24], conf: 0.95, displayId: 0 },
      { id: "t0-2", text: "Cancel", bbox: [200, 100, 80, 24], conf: 0.95, displayId: 0 },
      { id: "t0-3", text: "Open File", bbox: [300, 200, 100, 30], conf: 0.99, displayId: 0 },
      { id: "t1-1", text: "Save", bbox: [50, 50, 60, 24], conf: 0.85, displayId: 1 },
    ],
    ax: [
      {
        id: "a0-1",
        role: "button",
        label: "Submit",
        bbox: [500, 400, 80, 40],
        actions: ["press"],
        displayId: 0,
      },
    ],
    vlm_scene: null,
    vlm_elements: null,
  };
}

describe("OcrCoordinateGroundingActor", () => {
  it("resolves OCR ref `t0-3` to bbox center", async () => {
    const scene = multiDisplayScene();
    const actor = new OcrCoordinateGroundingActor(() => scene);
    const result = await actor.ground({
      displayId: 0,
      croppedImage: Buffer.alloc(0),
      hint: "the open-file button",
      ref: "t0-3",
    });
    // bbox [300, 200, 100, 30] → center (350, 215)
    expect(result.x).toBe(350);
    expect(result.y).toBe(215);
    expect(result.displayId).toBe(0);
    expect(result.confidence).toBe(1);
    expect(result.reason).toContain("ocr");
    expect(result.reason).toContain("t0-3");
  });

  it("resolves AX ref `a0-1` to AX bbox center", async () => {
    const scene = multiDisplayScene();
    const actor = new OcrCoordinateGroundingActor(() => scene);
    const result = await actor.ground({
      displayId: 0,
      croppedImage: Buffer.alloc(0),
      hint: "submit",
      ref: "a0-1",
    });
    // bbox [500, 400, 80, 40] → center (540, 420)
    expect(result.x).toBe(540);
    expect(result.y).toBe(420);
    expect(result.reason).toContain("ax");
  });

  it("falls back to hint-based label search when no ref is given", async () => {
    const scene = multiDisplayScene();
    const actor = new OcrCoordinateGroundingActor(() => scene);
    const result = await actor.ground({
      displayId: 0,
      croppedImage: Buffer.alloc(0),
      hint: "Open File",
    });
    expect(result.x).toBe(350);
    expect(result.y).toBe(215);
  });

  it("throws when the ref and hint match nothing", async () => {
    const scene = multiDisplayScene();
    const actor = new OcrCoordinateGroundingActor(() => scene);
    await expect(
      actor.ground({
        displayId: 0,
        croppedImage: Buffer.alloc(0),
        hint: "definitely-not-on-screen",
        ref: "t0-99",
      }),
    ).rejects.toThrow(/no OCR\/AX target/);
  });

  it("throws when there's no scene at all", async () => {
    const actor = new OcrCoordinateGroundingActor(() => null);
    await expect(
      actor.ground({
        displayId: 0,
        croppedImage: Buffer.alloc(0),
        hint: "save",
      }),
    ).rejects.toThrow(/cannot ground without a current scene/);
  });
});

describe("resolveReference — preferred display tie-breaker", () => {
  it("prefers an OCR box on the requested display when both displays have 'Save'", () => {
    const scene = multiDisplayScene();
    // Preferring display 1 should give us t1-1, not t0-1.
    const target = resolveReference(scene, undefined, "Save", 1);
    expect(target?.displayId).toBe(1);
    expect(target?.kind).toBe("ocr");
  });

  it("prefers display 0 when requested", () => {
    const scene = multiDisplayScene();
    const target = resolveReference(scene, undefined, "Save", 0);
    expect(target?.displayId).toBe(0);
  });

  it("returns null when nothing matches at all", () => {
    const scene = multiDisplayScene();
    expect(resolveReference(scene, undefined, "Klingon", 0)).toBeNull();
  });

  it("ref takes precedence over hint", () => {
    const scene = multiDisplayScene();
    // ref `t0-1` is "Save" — even though we say hint "Cancel", the ref wins.
    const target = resolveReference(scene, "t0-1", "Cancel", 0);
    expect(target?.label).toBe("Save");
  });
});
