/**
 * Uplink re-framer: arbitrary client PCM chunking -> exact 3200-byte Ink
 * frames. Verifies the frames validate against the real adapter's chunk check.
 */

import { describe, expect, test } from "bun:test";

import { validateCartesiaInkAudioChunk } from "../../stt/providers/cartesia-ink";
import { UPLINK_FRAME_BYTES, UplinkReframer } from "../lib/uplink-reframer";

describe("uplink reframer", () => {
  test("frame size matches the Ink chunk recommendation", () => {
    expect(UPLINK_FRAME_BYTES).toBe(3200);
  });

  test("emits exact 3200-byte frames and holds the remainder", () => {
    const r = new UplinkReframer();
    expect(r.push(new Uint8Array(1000))).toEqual([]);
    expect(r.pending()).toBe(1000);
    const frames = r.push(new Uint8Array(2500));
    expect(frames.length).toBe(1);
    expect(frames[0].byteLength).toBe(3200);
    expect(r.pending()).toBe(300);
  });

  test("emitted frames validate against the real adapter chunk check", () => {
    const r = new UplinkReframer();
    const frames = r.push(new Uint8Array(3200 * 3));
    expect(frames.length).toBe(3);
    for (const f of frames) {
      expect(() => validateCartesiaInkAudioChunk(f)).not.toThrow();
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
    for (let i = 0; i < 4; i++) expect(r.push(new Uint8Array(640))).toEqual([]);
    expect(r.pending()).toBe(2560);
    const out = r.push(new Uint8Array(640));
    expect(out.length).toBe(1);
    expect(out[0].byteLength).toBe(3200);
    expect(r.pending()).toBe(0);
  });
});
