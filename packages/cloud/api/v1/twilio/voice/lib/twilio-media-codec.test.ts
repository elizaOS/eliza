/** Exercises the deterministic G.711 mu-law boundary used by Twilio streams. */

import { describe, expect, test } from "bun:test";
import { decodeTwilioMedia, encodeTwilioMedia } from "./twilio-media-codec";

describe("Twilio media codec", () => {
  test("decodes an 8 kHz frame into duration-preserving 16 kHz PCM16", () => {
    const decoded = decodeTwilioMedia(
      btoa(String.fromCharCode(0xff, 0x7f, 0x00)),
    );
    const view = new DataView(decoded.buffer);

    expect(decoded.byteLength).toBe(12);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(0);
    expect(view.getInt16(4, true)).toBe(0);
    expect(view.getInt16(6, true)).toBe(0);
    expect(view.getInt16(8, true)).toBe(-32_124);
    expect(view.getInt16(10, true)).toBe(-32_124);
  });

  test("round-trips representative telephone samples within mu-law tolerance", () => {
    const samples = [-30_000, -10_000, -1_000, 0, 1_000, 10_000, 30_000];
    const pcm = new Uint8Array(samples.length * 4);
    const view = new DataView(pcm.buffer);
    samples.forEach((sample, index) => {
      view.setInt16(index * 4, sample, true);
      view.setInt16(index * 4 + 2, sample, true);
    });

    const decoded = decodeTwilioMedia(encodeTwilioMedia(pcm));
    const decodedView = new DataView(decoded.buffer);
    samples.forEach((sample, index) => {
      expect(
        Math.abs(decodedView.getInt16(index * 4, true) - sample),
      ).toBeLessThan(1_100);
    });
  });

  test("encodes an unpaired final sample but refuses a partial PCM sample", () => {
    expect(encodeTwilioMedia(new Uint8Array(2))).toBe("/w==");
    expect(() => encodeTwilioMedia(new Uint8Array(1))).toThrow(
      "complete samples",
    );
  });
});
