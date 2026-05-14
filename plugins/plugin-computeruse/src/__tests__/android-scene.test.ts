/**
 * WS8 — Android AX tree normalization tests.
 *
 * Verifies the JSON emitted by `MiladyAccessibilityService.getAccessibilityTreeJson()`
 * (Kotlin) round-trips through `parseAndroidAxTree` into the WS6 `Scene.ax`
 * shape that WS7's `OcrCoordinateGroundingActor.resolveReference` expects.
 *
 * The Kotlin shape (from MiladyAccessibilityService.kt walkNode):
 *
 *   {
 *     "id": "0",
 *     "role": "android.widget.Button",
 *     "label": "OK"        // or null
 *     "bbox": { "x": 100, "y": 200, "w": 80, "h": 40 },
 *     "actions": ["click", "focus"]
 *   }
 *
 * The TS-side scene shape (SceneAxNode):
 *
 *   { id: "a0-0", role, label, bbox: [100, 200, 80, 40], actions, displayId }
 */

import { describe, expect, it } from "vitest";
import {
  androidAxIdToSceneId,
  normalizeAndroidAxNode,
  parseAndroidAxTree,
  sceneAxToAndroidAxNode,
} from "../mobile/android-scene.js";
import { resolveReference } from "../actor/actor.js";
import { ANDROID_LOGICAL_DISPLAY_ID } from "../mobile/mobile-screen-capture.js";
import type { Scene } from "../scene/scene-types.js";

/**
 * Fixture mirroring exactly what MiladyAccessibilityService.kt would emit.
 * We verify the parser handles every documented quirk:
 *   - integer ids stringified
 *   - label nullable
 *   - bbox object → tuple
 *   - unknown actions filtered out is not the contract — we keep them verbatim
 *     as the Kotlin side enumerates only the documented set.
 */
const KOTLIN_AX_JSON = JSON.stringify([
  {
    id: "0",
    role: "android.widget.FrameLayout",
    label: null,
    bbox: { x: 0, y: 0, w: 1080, h: 1920 },
    actions: ["focus"],
  },
  {
    id: "1",
    role: "android.widget.Button",
    label: "Save",
    bbox: { x: 100, y: 200, w: 80, h: 40 },
    actions: ["click", "focus"],
  },
  {
    id: "2",
    role: "android.widget.EditText",
    label: "Title",
    bbox: { x: 100, y: 400, w: 880, h: 120 },
    actions: ["click", "type", "focus"],
  },
]);

describe("parseAndroidAxTree", () => {
  it("normalizes the Kotlin shape into the WS6 SceneAxNode shape", () => {
    const nodes = parseAndroidAxTree(KOTLIN_AX_JSON, ANDROID_LOGICAL_DISPLAY_ID);
    expect(nodes).toHaveLength(3);
    expect(nodes[0]).toMatchObject({
      id: "a0-0",
      role: "android.widget.FrameLayout",
      bbox: [0, 0, 1080, 1920],
      actions: ["focus"],
      displayId: 0,
    });
    expect(nodes[0]?.label).toBeUndefined();
    expect(nodes[1]).toMatchObject({
      id: "a0-1",
      role: "android.widget.Button",
      label: "Save",
      bbox: [100, 200, 80, 40],
      actions: ["click", "focus"],
    });
    expect(nodes[2]?.actions).toEqual(["click", "type", "focus"]);
  });

  it("uses the supplied displayId in the scene-ax id", () => {
    const nodes = parseAndroidAxTree(KOTLIN_AX_JSON, 7);
    expect(nodes[1]?.id).toBe("a7-1");
    expect(nodes[1]?.displayId).toBe(7);
  });

  it("returns an empty array for the Kotlin error sentinel `[]`", () => {
    expect(parseAndroidAxTree("[]", ANDROID_LOGICAL_DISPLAY_ID)).toEqual([]);
  });

  it("drops malformed entries instead of throwing", () => {
    const bad = JSON.stringify([
      { id: "1", role: "Button", bbox: { x: 0, y: 0, w: 10, h: 10 }, actions: [] },
      { id: 99, role: "no-string-id" }, // dropped
      { id: "2", role: "X", bbox: { x: 0, y: 0, w: "bad" as unknown as number, h: 10 } }, // dropped
      "not an object", // dropped
    ]);
    const nodes = parseAndroidAxTree(bad, 0);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.id).toBe("a0-1");
  });

  it("throws when the top-level payload is not JSON or not an array", () => {
    expect(() => parseAndroidAxTree("nope", 0)).toThrow(/parse failed/);
    expect(() => parseAndroidAxTree(JSON.stringify({ a: 1 }), 0)).toThrow(
      /must be an array/,
    );
  });
});

describe("androidAxIdToSceneId + sceneAxToAndroidAxNode round-trip", () => {
  it("round-trips through normalize + inverse", () => {
    const original = JSON.parse(KOTLIN_AX_JSON)[1];
    const normalized = normalizeAndroidAxNode(original, 0)!;
    const inverted = sceneAxToAndroidAxNode(normalized);
    expect(inverted.id).toBe(original.id);
    expect(inverted.role).toBe(original.role);
    expect(inverted.label).toBe(original.label);
    expect(inverted.bbox).toEqual(original.bbox);
    expect(inverted.actions).toEqual(original.actions);
  });

  it("scene-id prefix is `a<displayId>-`", () => {
    expect(androidAxIdToSceneId("42", 0)).toBe("a0-42");
    expect(androidAxIdToSceneId("42", 3)).toBe("a3-42");
  });
});

describe("Android AX nodes feed WS7 resolveReference", () => {
  it("Brain `ref:a0-1` from a parsed Android tree resolves to the Save button bbox center", () => {
    const ax = parseAndroidAxTree(KOTLIN_AX_JSON, ANDROID_LOGICAL_DISPLAY_ID);
    const scene: Scene = {
      timestamp: 1,
      displays: [
        {
          id: 0,
          bounds: [0, 0, 1080, 1920],
          scaleFactor: 1,
          primary: true,
          name: "android-screen",
        },
      ],
      focused_window: null,
      apps: [],
      ocr: [],
      ax,
      vlm_scene: null,
      vlm_elements: null,
    };
    const target = resolveReference(scene, "a0-1", "save", 0);
    expect(target).not.toBeNull();
    expect(target?.kind).toBe("ax");
    expect(target?.bbox).toEqual([100, 200, 80, 40]);
    expect(target?.displayId).toBe(0);
  });

  it("hint-based label match works without an explicit ref", () => {
    const ax = parseAndroidAxTree(KOTLIN_AX_JSON, ANDROID_LOGICAL_DISPLAY_ID);
    const scene: Scene = {
      timestamp: 1,
      displays: [
        {
          id: 0,
          bounds: [0, 0, 1080, 1920],
          scaleFactor: 1,
          primary: true,
          name: "android-screen",
        },
      ],
      focused_window: null,
      apps: [],
      ocr: [],
      ax,
      vlm_scene: null,
      vlm_elements: null,
    };
    const target = resolveReference(scene, undefined, "Title", 0);
    expect(target?.label).toBe("Title");
  });
});
