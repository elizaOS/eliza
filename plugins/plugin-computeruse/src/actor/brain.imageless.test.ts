/**
 * Brain image policy — imageless-first planning (#9105).
 *
 * The compact scene the Brain builds already carries OCR text + AX boxes, so
 * the default `"on-escalation"` policy plans the next action from that text-only
 * context with NO screenshot attached, and only attaches the ~1.3 MP frame when
 * the planned target cannot be grounded against the OCR/AX boxes. These tests
 * drive a stubbed `invokeModel` that records the `imageUrl` of every call and
 * assert exactly when the raw pixels are (and are not) sent — deterministic, no
 * real model.
 */

import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { DisplayCapture } from "../platform/capture.js";
import type { Scene, SceneOcrBox } from "../scene/scene-types.js";
import { Brain } from "./brain.js";

// ── minimal PNG synthesizer (16x16 RGB) — mirrors brain-dhash-cache.test.ts ──
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

/** A stub that records every `imageUrl` it is called with and returns `json`. */
function recordingStub(json: string): {
  calls: string[];
  invoke: (args: { imageUrl: string }) => Promise<string>;
} {
  const calls: string[] = [];
  return {
    calls,
    invoke: async (args) => {
      calls.push(args.imageUrl);
      return json;
    },
  };
}

const hasPng = (url: string): boolean => url.includes("data:image/png");

describe("Brain image policy — on-escalation (#9105)", () => {
  it("plans from OCR with NO image when the ref resolves against the boxes", async () => {
    const stub = recordingStub(
      JSON.stringify({
        scene_summary: "save dialog",
        target_display_id: 0,
        roi: [],
        // `t0-1` exists in the scene's OCR → grounds without pixels.
        proposed_action: { kind: "click", ref: "t0-1", rationale: "Save" },
      }),
    );
    const brain = new Brain(null, {
      imagePolicy: "on-escalation",
      invokeModel: stub.invoke,
    });

    const out = await brain.observeAndPlan({
      scene: scene([SAVE_BOX]),
      goal: "click save",
      captures: captures(makePng(1)),
    });

    // Exactly one model call, and it carried NO screenshot.
    expect(stub.calls).toHaveLength(1);
    expect(hasPng(stub.calls[0] ?? "")).toBe(false);
    expect(out.proposed_action.ref).toBe("t0-1");

    const stats = brain.getStats();
    expect(stats.invocations).toBe(1);
    expect(stats.imagelessCalls).toBe(1);
    // 16x16 frame → round(256 / 750) = 0 estimated image tokens saved.
    expect(stats.estImageTokensSaved).toBe(0);
  });

  it("escalates and ATTACHES the image when the ref cannot be grounded", async () => {
    const stub = recordingStub(
      JSON.stringify({
        scene_summary: "unknown screen",
        target_display_id: 0,
        // ref points at a box that does NOT exist in the scene, and the
        // rationale matches no OCR/AX text → ungroundable → escalate.
        proposed_action: {
          kind: "click",
          ref: "t0-99",
          rationale: "the mystery button",
        },
        roi: [],
      }),
    );
    const brain = new Brain(null, {
      imagePolicy: "on-escalation",
      invokeModel: stub.invoke,
    });

    await brain.observeAndPlan({
      scene: scene([SAVE_BOX]), // no `t0-99`, no "mystery" text
      goal: "click the button",
      captures: captures(makePng(2)),
    });

    // Two calls: imageless attempt (no pixels) then escalation (pixels).
    expect(stub.calls).toHaveLength(2);
    expect(hasPng(stub.calls[0] ?? "")).toBe(false);
    expect(hasPng(stub.calls[1] ?? "")).toBe(true);

    const stats = brain.getStats();
    expect(stats.invocations).toBe(2);
    // The escalation means this turn did NOT count as an imageless saving.
    expect(stats.imagelessCalls).toBe(0);
    expect(stats.estImageTokensSaved).toBe(0);
  });

  it("stays imageless for a non-coordinate action (finish needs no grounding)", async () => {
    const stub = recordingStub(
      JSON.stringify({
        scene_summary: "all done",
        target_display_id: 0,
        roi: [],
        proposed_action: { kind: "finish", rationale: "goal reached" },
      }),
    );
    const brain = new Brain(null, {
      imagePolicy: "on-escalation",
      invokeModel: stub.invoke,
    });

    await brain.observeAndPlan({
      scene: scene([]),
      goal: "finish",
      captures: captures(makePng(3)),
    });

    expect(stub.calls).toHaveLength(1);
    expect(hasPng(stub.calls[0] ?? "")).toBe(false);
    expect(brain.getStats().imagelessCalls).toBe(1);
  });

  it('policy "always" attaches the image on the first call (legacy behaviour)', async () => {
    const stub = recordingStub(
      JSON.stringify({
        scene_summary: "save dialog",
        target_display_id: 0,
        roi: [],
        proposed_action: { kind: "click", ref: "t0-1", rationale: "Save" },
      }),
    );
    const brain = new Brain(null, {
      imagePolicy: "always",
      invokeModel: stub.invoke,
    });

    await brain.observeAndPlan({
      scene: scene([SAVE_BOX]),
      goal: "click save",
      captures: captures(makePng(4)),
    });

    expect(stub.calls).toHaveLength(1);
    expect(hasPng(stub.calls[0] ?? "")).toBe(true);
    expect(brain.getStats().imagelessCalls).toBe(0);
  });

  it('policy "never" never attaches the image even when the ref is ungroundable', async () => {
    const stub = recordingStub(
      JSON.stringify({
        scene_summary: "unknown screen",
        target_display_id: 0,
        roi: [],
        proposed_action: { kind: "click", ref: "t0-99", rationale: "mystery" },
      }),
    );
    const brain = new Brain(null, {
      imagePolicy: "never",
      invokeModel: stub.invoke,
    });

    await brain.observeAndPlan({
      scene: scene([SAVE_BOX]),
      goal: "click the button",
      captures: captures(makePng(5)),
    });

    expect(stub.calls).toHaveLength(1);
    expect(hasPng(stub.calls[0] ?? "")).toBe(false);
    expect(brain.getStats().imagelessCalls).toBe(1);
  });
});
