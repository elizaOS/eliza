/** Pendant audio decoding coverage uses non-WASM codecs for deterministic tests. */

import { describe, expect, it } from "vitest";
import { OMI_CODEC } from "./omi-protocol";
import { createPendantAudioDecoder } from "./opus-frame-decoder";

describe("createPendantAudioDecoder (non-Opus paths, no wasm)", () => {
  it("decodes little-endian int16 PCM to normalized Float32", async () => {
    const dec = await createPendantAudioDecoder(OMI_CODEC.PCM_16K);
    // int16 samples: 0, 16384 (0.5), -16384 (-0.5), 32767 (~1)
    const bytes = new Uint8Array(8);
    const view = new DataView(bytes.buffer);
    view.setInt16(0, 0, true);
    view.setInt16(2, 16384, true);
    view.setInt16(4, -16384, true);
    view.setInt16(6, 32767, true);
    const pcm = dec.decodeFrame(bytes);
    expect(pcm).toHaveLength(4);
    expect(pcm[0]).toBeCloseTo(0, 5);
    expect(pcm[1]).toBeCloseTo(0.5, 3);
    expect(pcm[2]).toBeCloseTo(-0.5, 3);
    expect(pcm[3]).toBeCloseTo(1, 2);
    dec.free();
  });

  it("returns an empty array for an empty PCM frame", async () => {
    const dec = await createPendantAudioDecoder(OMI_CODEC.PCM_16K);
    expect(dec.decodeFrame(new Uint8Array(0))).toHaveLength(0);
    dec.free();
  });

  it("expands G.711 µ-law to Float32 in [-1, 1]", async () => {
    const dec = await createPendantAudioDecoder(OMI_CODEC.MU_LAW_8K);
    const frame = new Uint8Array([0x00, 0xff, 0x80, 0x7f]);
    const pcm = dec.decodeFrame(frame);
    expect(pcm).toHaveLength(4);
    for (const s of pcm) {
      expect(s).toBeGreaterThanOrEqual(-1);
      expect(s).toBeLessThanOrEqual(1);
    }
    // 0xff is the µ-law encoding of the smallest-magnitude positive sample (~0).
    expect(Math.abs(pcm[1])).toBeLessThan(0.01);
    dec.free();
  });
});
