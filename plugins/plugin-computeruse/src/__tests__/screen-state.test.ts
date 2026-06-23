/**
 * Unified ScreenState store (#9105 M3).
 *
 * One capture per turn, reused inside the freshness window; change events only
 * fire when the frame dHash actually moved. Uses real synthesized PNGs so
 * `frameDhash` / `blockGrid` are meaningful.
 */

import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { DisplayCapture } from "../platform/capture.js";
import { ScreenStateStore } from "../scene/screen-state.js";

// ── minimal PNG synthesizer (32x32 RGB, gradient seeded so dHash differs) ────
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i] ?? 0;
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
  const w = 32;
  const h = 32;
  const rows: number[] = [];
  for (let y = 0; y < h; y += 1) {
    rows.push(0);
    for (let x = 0; x < w; x += 1) {
      const v = ((x + seed) * 8) % 255;
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

function capture(frame: Buffer): DisplayCapture {
  return {
    display: {
      id: 0,
      bounds: [0, 0, 32, 32],
      scaleFactor: 1,
      primary: true,
      name: "f",
    },
    frame,
  };
}

describe("ScreenStateStore (M3)", () => {
  it("computes dHash + blockGrid + dimensions on first capture", async () => {
    const store = new ScreenStateStore({
      capture: async () => capture(makePng(3)),
    });
    const state = await store.get(0, true);
    expect(state.displayId).toBe(0);
    expect(state.width).toBe(32);
    expect(state.height).toBe(32);
    expect(state.dhash).not.toBeNull();
    expect(state.blockGrid).not.toBeNull();
    // First frame has no prior to diff against.
    expect(state.dirtyBlocks).toBeNull();
    // First capture counts as a change (distance Infinity ≥ threshold).
    expect(store.getStats()).toEqual({
      captures: 1,
      cacheHits: 0,
      changes: 1,
    });
  });

  it("serves a fresh capture from cache (one OS capture per turn)", async () => {
    let calls = 0;
    let clock = 1000;
    const store = new ScreenStateStore({
      capture: async () => {
        calls += 1;
        return capture(makePng(5));
      },
      freshnessMs: 400,
      now: () => clock,
    });
    await store.get(0); // fresh capture
    clock += 100; // still within freshness window
    await store.get(0); // served from cache
    clock += 100;
    await store.get(0); // served from cache
    expect(calls).toBe(1);
    expect(store.getStats().captures).toBe(1);
    expect(store.getStats().cacheHits).toBe(2);
  });

  it("re-captures once the freshness window elapses", async () => {
    let calls = 0;
    let clock = 0;
    const store = new ScreenStateStore({
      capture: async () => {
        calls += 1;
        return capture(makePng(5));
      },
      freshnessMs: 400,
      now: () => clock,
    });
    await store.get(0);
    clock += 500; // window elapsed
    await store.get(0);
    expect(calls).toBe(2);
  });

  it("fires a change event only when the frame dHash moves ≥ threshold", async () => {
    const frames = [makePng(0), makePng(0), makePng(80)];
    let i = 0;
    let clock = 0;
    const store = new ScreenStateStore({
      capture: async () => capture(frames[i++] ?? frames[frames.length - 1]!),
      now: () => clock,
    });
    const changes: number[] = [];
    store.onChange((c) => changes.push(c.distance));

    await store.refresh(0); // first frame: distance Infinity → change
    clock += 1;
    await store.refresh(0); // identical pixels → no change
    clock += 1;
    const third = await store.refresh(0); // visually different → change

    // First frame and the visually-different third frame fire; the identical
    // middle frame does not.
    expect(changes).toHaveLength(2);
    expect(changes[0]).toBe(Number.POSITIVE_INFINITY);
    expect(third.dirtyBlocks).not.toBeNull();
    expect(store.getStats().changes).toBe(2);
  });
});
