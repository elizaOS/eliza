/**
 * WS7 — Brain unit tests.
 *
 * Validates:
 *   - `parseBrainOutput` accepts raw JSON, fenced JSON, and prose-then-JSON
 *     forms, while rejecting structurally invalid bodies.
 *   - `Brain.observeAndPlan` calls the injected model once when the first
 *     payload parses, and retries exactly once on a parse failure.
 *   - The retry uses the *strict* prompt variant; on a second failure a
 *     `BrainParseError` surfaces so the cascade can return a structured
 *     error result instead of crashing.
 *   - ROI extraction is preserved through enforcement of the cap.
 *   - The model receives a `data:image/png;base64,...` URL (no resizing
 *     happens client-side — adapters do that downstream).
 */

import { describe, expect, it } from "vitest";
import {
  BRAIN_MAX_ROIS,
  Brain,
  BrainParseError,
  brainPromptFor,
  parseBrainOutput,
} from "../actor/brain.js";
import type { Scene } from "../scene/scene-types.js";
import type { DisplayCapture } from "../platform/capture.js";

function dummyScene(): Scene {
  return {
    timestamp: 1,
    displays: [
      { id: 0, bounds: [0, 0, 1920, 1080], scaleFactor: 1, primary: true, name: "fake" },
    ],
    focused_window: {
      app: "Test",
      pid: 1,
      bounds: [0, 0, 1920, 1080],
      title: "T",
      displayId: 0,
    },
    apps: [],
    ocr: [
      { id: "t0-1", text: "Save", bbox: [100, 100, 80, 32], conf: 0.97, displayId: 0 },
    ],
    ax: [],
    vlm_scene: null,
    vlm_elements: null,
  };
}

function pngBuffer(seed: number): Buffer {
  // Anything starting with the PNG signature is fine — `encodeForBrain`
  // base64-encodes the bytes as-is.
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, Buffer.from([seed & 0xff])]);
}

function captures(): Map<number, DisplayCapture> {
  const m = new Map<number, DisplayCapture>();
  m.set(0, {
    display: {
      id: 0,
      bounds: [0, 0, 1920, 1080],
      scaleFactor: 1,
      primary: true,
      name: "fake",
    },
    frame: pngBuffer(1),
  });
  return m;
}

describe("parseBrainOutput", () => {
  it("accepts a raw JSON object", () => {
    const out = parseBrainOutput(
      JSON.stringify({
        scene_summary: "S",
        target_display_id: 0,
        roi: [{ displayId: 0, bbox: [10, 10, 20, 20], reason: "r" }],
        proposed_action: { kind: "click", ref: "t0-1", args: {}, rationale: "y" },
      }),
    );
    expect(out.scene_summary).toBe("S");
    expect(out.target_display_id).toBe(0);
    expect(out.roi).toHaveLength(1);
    expect(out.proposed_action.kind).toBe("click");
    expect(out.proposed_action.ref).toBe("t0-1");
  });

  it("strips ```json fences", () => {
    const fenced = "```json\n" +
      JSON.stringify({
        scene_summary: "fenced",
        target_display_id: 0,
        roi: [],
        proposed_action: { kind: "wait", rationale: "r" },
      }) +
      "\n```";
    const out = parseBrainOutput(fenced);
    expect(out.scene_summary).toBe("fenced");
    expect(out.proposed_action.kind).toBe("wait");
  });

  it("tolerates leading prose before the first brace", () => {
    const raw =
      "Sure! Here's the JSON: " +
      JSON.stringify({
        scene_summary: "with-prose",
        target_display_id: 0,
        roi: [],
        proposed_action: { kind: "finish", rationale: "done" },
      });
    const out = parseBrainOutput(raw);
    expect(out.scene_summary).toBe("with-prose");
    expect(out.proposed_action.kind).toBe("finish");
  });

  it("throws BrainParseError on non-JSON", () => {
    expect(() => parseBrainOutput("totally not json")).toThrow(BrainParseError);
  });

  it("throws BrainParseError when proposed_action is missing", () => {
    expect(() =>
      parseBrainOutput(
        JSON.stringify({ scene_summary: "x", target_display_id: 0, roi: [] }),
      ),
    ).toThrow(/proposed_action/);
  });

  it("drops malformed ROIs without failing the whole parse", () => {
    const out = parseBrainOutput(
      JSON.stringify({
        scene_summary: "x",
        target_display_id: 0,
        roi: [
          { displayId: 0, bbox: [1, 2, 3, 4], reason: "ok" },
          { displayId: 0, bbox: "not-an-array", reason: "bad" },
          { displayId: 0, bbox: [1, 2, 3], reason: "short" },
        ],
        proposed_action: { kind: "click", rationale: "r" },
      }),
    );
    expect(out.roi).toHaveLength(1);
    expect(out.roi[0]?.bbox).toEqual([1, 2, 3, 4]);
  });
});

describe("brainPromptFor", () => {
  it("includes the goal and switches header on strict mode", () => {
    const a = brainPromptFor("{}", "click save", false);
    const b = brainPromptFor("{}", "click save", true);
    expect(a).toContain("click save");
    expect(b).toContain("click save");
    expect(a).not.toContain("MUST emit ONLY a JSON");
    expect(b).toContain("MUST emit ONLY a JSON");
  });

  it("documents the ROI cap in the prompt", () => {
    const p = brainPromptFor("{}", "g", false);
    expect(p).toContain(`Cap ROIs to ${BRAIN_MAX_ROIS}`);
  });
});

describe("Brain.observeAndPlan", () => {
  it("invokes the model once and returns the parsed BrainOutput", async () => {
    let calls = 0;
    const lastArgs: Array<{ imageUrl: string; prompt: string }> = [];
    const brain = new Brain(null, {
      invokeModel: async (args) => {
        calls += 1;
        lastArgs.push({ imageUrl: args.imageUrl, prompt: args.prompt });
        return JSON.stringify({
          scene_summary: "OK",
          target_display_id: 0,
          roi: [{ displayId: 0, bbox: [0, 0, 10, 10], reason: "a" }],
          proposed_action: {
            kind: "click",
            ref: "t0-1",
            rationale: "Save button",
          },
        });
      },
    });
    const out = await brain.observeAndPlan({
      scene: dummyScene(),
      goal: "click save",
      captures: captures(),
    });
    expect(calls).toBe(1);
    expect(lastArgs[0]?.imageUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(out.scene_summary).toBe("OK");
    expect(out.target_display_id).toBe(0);
    expect(out.roi).toHaveLength(1);
    expect(out.proposed_action.ref).toBe("t0-1");
  });

  it("retries once with the strict prompt on parse failure", async () => {
    let calls = 0;
    const seenPrompts: string[] = [];
    const brain = new Brain(null, {
      invokeModel: async (args) => {
        calls += 1;
        seenPrompts.push(args.prompt);
        if (calls === 1) return "not json at all";
        return JSON.stringify({
          scene_summary: "retry-good",
          target_display_id: 0,
          roi: [],
          proposed_action: { kind: "finish", rationale: "done" },
        });
      },
    });
    const out = await brain.observeAndPlan({
      scene: dummyScene(),
      goal: "g",
      captures: captures(),
    });
    expect(calls).toBe(2);
    expect(seenPrompts[0]).not.toContain("MUST emit ONLY a JSON");
    expect(seenPrompts[1]).toContain("MUST emit ONLY a JSON");
    expect(out.proposed_action.kind).toBe("finish");
  });

  it("throws BrainParseError after the retry also fails", async () => {
    const brain = new Brain(null, {
      invokeModel: async () => "broken",
    });
    await expect(
      brain.observeAndPlan({
        scene: dummyScene(),
        goal: "g",
        captures: captures(),
      }),
    ).rejects.toBeInstanceOf(BrainParseError);
  });

  it("enforces the ROI cap", async () => {
    const tooMany = Array.from({ length: BRAIN_MAX_ROIS + 3 }, (_, i) => ({
      displayId: 0,
      bbox: [i, i, 1, 1] as [number, number, number, number],
      reason: `r${i}`,
    }));
    const brain = new Brain(null, {
      invokeModel: async () =>
        JSON.stringify({
          scene_summary: "S",
          target_display_id: 0,
          roi: tooMany,
          proposed_action: { kind: "wait", rationale: "" },
        }),
    });
    const out = await brain.observeAndPlan({
      scene: dummyScene(),
      goal: "g",
      captures: captures(),
    });
    expect(out.roi.length).toBe(BRAIN_MAX_ROIS);
  });

  it("accepts an ImageDescriptionResult with `description` payload", async () => {
    const brain = new Brain(null, {
      invokeModel: async () => ({
        title: "ignored",
        description: JSON.stringify({
          scene_summary: "from-desc",
          target_display_id: 0,
          roi: [],
          proposed_action: { kind: "wait", rationale: "" },
        }),
      }),
    });
    const out = await brain.observeAndPlan({
      scene: dummyScene(),
      goal: "g",
      captures: captures(),
    });
    expect(out.scene_summary).toBe("from-desc");
  });

  it("fails when no captures are supplied", async () => {
    const brain = new Brain(null, {
      invokeModel: async () => "{}",
    });
    await expect(
      brain.observeAndPlan({
        scene: dummyScene(),
        goal: "g",
        captures: new Map(),
      }),
    ).rejects.toThrow(/no captures/);
  });

  it("picks the focused display capture when present", async () => {
    let receivedDisplay = -1;
    const brain = new Brain(null, {
      invokeModel: async (args) => {
        receivedDisplay = args.displayId;
        return JSON.stringify({
          scene_summary: "S",
          target_display_id: args.displayId,
          roi: [],
          proposed_action: { kind: "wait", rationale: "" },
        });
      },
    });
    const scene = dummyScene();
    // Force the focused window onto a synthetic display id 0 — same as
    // captures map key.
    scene.focused_window!.displayId = 0;
    await brain.observeAndPlan({ scene, goal: "g", captures: captures() });
    expect(receivedDisplay).toBe(0);
  });
});
