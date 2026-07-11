/**
 * Uplink re-framer: arbitrary client PCM chunking -> exact 2560-byte Flux
 * frames. Verifies the frames validate against the REAL adapter's chunk check.
 */

import { describe, expect, test } from "bun:test";

import { validateDeepgramFluxAudioChunk } from "../../stt/providers/deepgram-flux";
import { UPLINK_FRAME_BYTES, UplinkReframer } from "../lib/uplink-reframer";

describe("uplink reframer", () => {
  test("frame size matches the Flux chunk requirement", () => {
    expect(UPLINK_FRAME_BYTES).toBe(2560);
  });

  test("emits exact 2560-byte frames and holds the remainder", () => {
    const r = new UplinkReframer();
    expect(r.push(new Uint8Array(1000))).toEqual([]);
    expect(r.pending()).toBe(1000);
    const frames = r.push(new Uint8Array(2000)); // total 3000 -> one 2560 frame.
    expect(frames.length).toBe(1);
    expect(frames[0].byteLength).toBe(2560);
    expect(r.pending()).toBe(440);
  });

  test("emitted frames validate against the real adapter chunk check", () => {
    const r = new UplinkReframer();
    const frames = r.push(new Uint8Array(2560 * 3));
    expect(frames.length).toBe(3);
    for (const f of frames) {
      // The real merged adapter accepts ONLY exact 2560-byte chunks.
      expect(() => validateDeepgramFluxAudioChunk(f)).not.toThrow();
    }
  });

  test("flush drops the sub-frame remainder without padding", () => {
    const r = new UplinkReframer();
    r.push(new Uint8Array(500));
    r.flush();
    expect(r.pending()).toBe(0);
  });

  test("multiple small chunks accumulate into a whole frame", () => {
    const r = new UplinkReframer();
    // 4*512 = 2048 (< 2560): no frame yet.
    for (let i = 0; i < 4; i++) expect(r.push(new Uint8Array(512))).toEqual([]);
    expect(r.pending()).toBe(2048);
    // The 5th 512 reaches 2560 exactly -> emits one frame, remainder 0.
    const out = r.push(new Uint8Array(512));
    expect(out.length).toBe(1);
    expect(out[0].byteLength).toBe(2560);
    expect(r.pending()).toBe(0);
  });
});
