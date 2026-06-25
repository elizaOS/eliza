/**
 * Brain model-routing regression (#9105 / #9574 follow-up).
 *
 * These tests exercise the REAL `Brain.invoke` path (no `invokeModel`
 * override), driving a runtime whose `useModel` mirrors the production model
 * handlers — crucially, the IMAGE_DESCRIPTION handler hard-rejects an empty
 * `imageUrl`, exactly as plugin-local-inference and plugin-anthropic do.
 *
 * The original #9574 imageless path sent `imageUrl: ""` to
 * `ModelType.IMAGE_DESCRIPTION`, which every real provider rejects, so the
 * default `"on-escalation"` policy crashed on the first planning step. The
 * mock-`invokeModel` tests never caught it because they bypass `invoke`. This
 * suite pins the fix: imageless plans route to a TEXT model, the default policy
 * is the safe `"always"`, and escalation still attaches real pixels.
 */

import { deflateSync } from "node:zlib";
import { type IAgentRuntime, ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { DisplayCapture } from "../platform/capture.js";
import type { Scene, SceneOcrBox } from "../scene/scene-types.js";
import { Brain, resolveBrainImagePolicy } from "./brain.js";

// ── minimal real PNG synthesizer (16x16 RGB) — mirrors brain.imageless.test ──
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function makePng(seed = 0): Buffer {
  const w = 16;
  const h = 16;
  const rows: number[] = [];
  for (let y = 0; y < h; y += 1) {
    rows.push(0);
    for (let x = 0; x < w; x += 1) {
      const v = ((x + seed) * 16) % 255;
      rows.push(v, v, v);
    }
  }
  const idat = deflateSync(Buffer.from(rows));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const SAVE_BOX: SceneOcrBox = {
  id: "t0-1",
  text: "Save",
  bbox: [100, 100, 80, 32],
  conf: 0.97,
  displayId: 0,
};

function scene(ocr: SceneOcrBox[]): Scene {
  return {
    timestamp: 1,
    displays: [
      {
        id: 0,
        bounds: [0, 0, 16, 16],
        scaleFactor: 1,
        primary: true,
        name: "f",
      },
    ],
    focused_window: null,
    apps: [],
    ocr,
    ax: [],
    vlm_scene: null,
    vlm_elements: null,
  };
}

function captures(frame: Buffer): Map<number, DisplayCapture> {
  const m = new Map<number, DisplayCapture>();
  m.set(0, {
    display: {
      id: 0,
      bounds: [0, 0, 16, 16],
      scaleFactor: 1,
      primary: true,
      name: "f",
    },
    frame,
  });
  return m;
}

interface ModelCall {
  modelType: string;
  imageUrl: string | undefined;
}

/**
 * Runtime whose `useModel` mirrors the production handlers: IMAGE_DESCRIPTION
 * throws on an empty imageUrl (as local-inference / anthropic do), TEXT_LARGE
 * is a plain text completion.
 */
function makeRuntime(opts: {
  textJson?: string;
  imageJson?: string;
  setting?: string;
}): { runtime: IAgentRuntime; calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  const runtime = {
    getSetting: (key: string) =>
      key === "COMPUTERUSE_BRAIN_IMAGE_POLICY" ? opts.setting : undefined,
    useModel: async (
      modelType: string,
      params: { imageUrl?: string; prompt?: string },
    ) => {
      calls.push({ modelType, imageUrl: params?.imageUrl });
      if (modelType === ModelType.IMAGE_DESCRIPTION) {
        if (!params?.imageUrl || params.imageUrl.length === 0) {
          // The exact failure mode that broke production CUA before the fix.
          throw new Error("IMAGE_DESCRIPTION requires a non-empty imageUrl");
        }
        return opts.imageJson ?? "{}";
      }
      if (modelType === ModelType.TEXT_LARGE) {
        return opts.textJson ?? "{}";
      }
      throw new Error(`unexpected modelType ${modelType}`);
    },
  } as unknown as IAgentRuntime;
  return { runtime, calls };
}

const groundedClick = JSON.stringify({
  scene_summary: "save dialog",
  target_display_id: 0,
  roi: [],
  proposed_action: { kind: "click", ref: "t0-1", rationale: "Save" },
});

describe("Brain.invoke model routing (#9574 imageUrl:'' regression)", () => {
  it("on-escalation: routes the imageless first pass to TEXT_LARGE and does NOT throw", async () => {
    const { runtime, calls } = makeRuntime({ textJson: groundedClick });
    const brain = new Brain(runtime, { imagePolicy: "on-escalation" });

    // The pre-fix code sent imageUrl:"" to IMAGE_DESCRIPTION here → the runtime
    // mock would throw → this await would reject. The fix routes to TEXT_LARGE.
    const out = await brain.observeAndPlan({
      scene: scene([SAVE_BOX]),
      goal: "save the file",
      captures: captures(makePng()),
    });

    expect(out.proposed_action.kind).toBe("click");
    expect(calls[0]).toEqual({
      modelType: ModelType.TEXT_LARGE,
      imageUrl: undefined,
    });
    expect(calls.some((c) => c.modelType === ModelType.IMAGE_DESCRIPTION)).toBe(
      false,
    );
    expect(brain.getStats().imagelessCalls).toBe(1);
  });

  it("on-escalation: escalates to IMAGE_DESCRIPTION with real pixels when the imageless ref cannot be grounded", async () => {
    const { runtime, calls } = makeRuntime({
      textJson: JSON.stringify({
        scene_summary: "unsure",
        target_display_id: 0,
        roi: [],
        // ref not in scene OCR and rationale matches no box text → ungrounded.
        proposed_action: {
          kind: "click",
          ref: "t9-9",
          rationale: "open the unknown control",
        },
      }),
      imageJson: groundedClick,
    });
    const brain = new Brain(runtime, { imagePolicy: "on-escalation" });

    const out = await brain.observeAndPlan({
      scene: scene([SAVE_BOX]),
      goal: "save the file",
      captures: captures(makePng()),
    });

    expect(out.proposed_action.ref).toBe("t0-1");
    expect(calls[0].modelType).toBe(ModelType.TEXT_LARGE);
    expect(calls[0].imageUrl).toBeUndefined();
    const img = calls.find((c) => c.modelType === ModelType.IMAGE_DESCRIPTION);
    expect(img).toBeDefined();
    expect(img?.imageUrl ?? "").toContain("data:image/png");
    expect(brain.getStats().imagelessCalls).toBe(0);
  });

  it("default (no imagePolicy) is the safe 'always' path — every call carries pixels, never an empty imageUrl", async () => {
    const { runtime, calls } = makeRuntime({
      imageJson: JSON.stringify({
        scene_summary: "x",
        target_display_id: 0,
        roi: [],
        proposed_action: { kind: "finish", rationale: "done" },
      }),
    });
    const brain = new Brain(runtime); // production default

    const out = await brain.observeAndPlan({
      scene: scene([SAVE_BOX]),
      goal: "g",
      captures: captures(makePng()),
    });

    expect(out.proposed_action.kind).toBe("finish");
    expect(calls.length).toBeGreaterThan(0);
    expect(
      calls.every((c) => c.modelType === ModelType.IMAGE_DESCRIPTION),
    ).toBe(true);
    expect(
      calls.every((c) => (c.imageUrl ?? "").includes("data:image/png")),
    ).toBe(true);
    expect(brain.getStats().imagelessCalls).toBe(0);
  });
});

describe("resolveBrainImagePolicy (#9105 operator escape hatch)", () => {
  it("defaults to the safe 'always' when unset or runtime is null", () => {
    expect(resolveBrainImagePolicy(makeRuntime({}).runtime)).toBe("always");
    expect(resolveBrainImagePolicy(null)).toBe("always");
  });

  it("honors a valid COMPUTERUSE_BRAIN_IMAGE_POLICY setting (trim + case-insensitive)", () => {
    expect(
      resolveBrainImagePolicy(
        makeRuntime({ setting: "on-escalation" }).runtime,
      ),
    ).toBe("on-escalation");
    expect(
      resolveBrainImagePolicy(makeRuntime({ setting: " NEVER " }).runtime),
    ).toBe("never");
  });

  it("ignores an invalid setting and falls back to the default", () => {
    expect(
      resolveBrainImagePolicy(makeRuntime({ setting: "sometimes" }).runtime),
    ).toBe("always");
  });
});
