import { describe, expect, it } from "vitest";
import { type OmnivoiceContext, OV_TTS_PARAMS_LAYOUT } from "../src/ffi";
import { _internal, pcmFloatToWavBuffer, runSynthesis } from "../src/synth";

describe("plugin-omnivoice synth option mapping", () => {
  it("buildInstruct prefers explicit instruct over design", () => {
    expect(
      _internal.buildInstruct(
        { gender: "female", emotion: "happy" },
        "male elderly low",
      ),
    ).toBe("male elderly low");
  });

  it("buildInstruct concatenates design fields in the documented order", () => {
    expect(
      _internal.buildInstruct(
        {
          gender: "female",
          age: "young",
          pitch: "moderate",
          style: "narration",
          volume: "loud",
          emotion: "happy",
        },
        undefined,
      ),
    ).toBe("female young moderate narration loud happy");
  });

  it("buildInstruct skips neutral emotion", () => {
    expect(
      _internal.buildInstruct(
        { gender: "female", emotion: "neutral" },
        undefined,
      ),
    ).toBe("female");
  });

  it("buildInstruct returns undefined when neither input is set", () => {
    expect(_internal.buildInstruct(undefined, undefined)).toBeUndefined();
    expect(_internal.buildInstruct({}, undefined)).toBeUndefined();
  });

  it("pcmFloatToWavBuffer produces a valid 44-byte RIFF header", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const wav = pcmFloatToWavBuffer(samples, 24000, 1);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    // PCM format
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(24000);
    // bits per sample
    expect(wav.readUInt16LE(34)).toBe(16);
    // data length = samples * 2 bytes
    expect(wav.readUInt32LE(40)).toBe(samples.length * 2);
    // sample 0 should be 0
    expect(wav.readInt16LE(44)).toBe(0);
    // sample 3 (1.0) should clip to 32767
    expect(wav.readInt16LE(44 + 3 * 2)).toBe(32767);
    // sample 4 (-1.0) should clip to -32767
    expect(wav.readInt16LE(44 + 4 * 2)).toBe(-32767);
  });

  it("normalizes numeric Bun FFI pointers when writing TTS params", async () => {
    const ctx = {
      synthesize: async (
        prepare: Parameters<OmnivoiceContext["synthesize"]>[0],
      ) => {
        const params = new Uint8Array(OV_TTS_PARAMS_LAYOUT.size);
        const view = new DataView(
          params.buffer,
          params.byteOffset,
          params.byteLength,
        );
        prepare(
          view,
          OV_TTS_PARAMS_LAYOUT,
          {
            ptr: () => 123,
          } as never,
          () => {},
        );
        expect(
          view.getBigUint64(OV_TTS_PARAMS_LAYOUT.fields.text.offset, true),
        ).toBe(123n);
        return {
          samples: new Float32Array(0),
          sampleRate: 24000,
          channels: 1,
        };
      },
    };

    await expect(
      runSynthesis(ctx as unknown as OmnivoiceContext, { text: "hello" }),
    ).resolves.toEqual({
      samples: new Float32Array(0),
      sampleRate: 24000,
      channels: 1,
    });
  });
});
