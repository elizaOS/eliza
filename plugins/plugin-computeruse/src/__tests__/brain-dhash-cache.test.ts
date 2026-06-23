/**
 * Brain frame-dHash describe-cache (#9105 M3).
 *
 * The WS2 MemoryArbiter only dedups IMAGE_DESCRIPTION for local backends; the
 * remote path re-burns tokens on an identical screen every step. The Brain's
 * call-site dHash cache skips the model entirely for the same frame + goal.
 * Uses real synthesized PNGs so frameDhash() is meaningful.
 */

import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { Brain } from "../actor/brain.js";
import type { DisplayCapture } from "../platform/capture.js";
import type { Scene } from "../scene/scene-types.js";

// ── minimal PNG synthesizer (16x16 RGB) ──────────────────────────────────────
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
function makeTinyPng(seed = 0): Buffer {
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

function dummyScene(): Scene {
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
    ocr: [],
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

const VALID = JSON.stringify({
  scene_summary: "OK",
  target_display_id: 0,
  roi: [],
  proposed_action: { kind: "click", ref: "t0-1", rationale: "Save" },
});

describe("Brain frame-dHash describe cache (M3)", () => {
  it("serves an identical frame+goal from cache without re-invoking the model", async () => {
    let calls = 0;
    const brain = new Brain(null, {
      invokeModel: async () => {
        calls += 1;
        return VALID;
      },
    });
    const frame = makeTinyPng(7);
    const first = await brain.observeAndPlan({
      scene: dummyScene(),
      goal: "click save",
      captures: captures(frame),
    });
    const second = await brain.observeAndPlan({
      scene: dummyScene(),
      goal: "click save",
      captures: captures(makeTinyPng(7)), // identical pixels → identical dHash
    });
    expect(calls).toBe(1);
    expect(second).toEqual(first);
    expect(brain.getStats()).toEqual({ invocations: 1, cacheHits: 1 });
  });

  it("re-invokes for a visually different frame", async () => {
    let calls = 0;
    const brain = new Brain(null, {
      invokeModel: async () => {
        calls += 1;
        return VALID;
      },
    });
    await brain.observeAndPlan({
      scene: dummyScene(),
      goal: "g",
      captures: captures(makeTinyPng(0)),
    });
    await brain.observeAndPlan({
      scene: dummyScene(),
      goal: "g",
      captures: captures(makeTinyPng(60)),
    });
    expect(calls).toBe(2);
    expect(brain.getStats().cacheHits).toBe(0);
  });

  it("re-invokes when the goal changes even for the same frame", async () => {
    let calls = 0;
    const brain = new Brain(null, {
      invokeModel: async () => {
        calls += 1;
        return VALID;
      },
    });
    const frame = makeTinyPng(3);
    await brain.observeAndPlan({
      scene: dummyScene(),
      goal: "goal A",
      captures: captures(frame),
    });
    await brain.observeAndPlan({
      scene: dummyScene(),
      goal: "goal B",
      captures: captures(makeTinyPng(3)),
    });
    expect(calls).toBe(2);
  });
});
