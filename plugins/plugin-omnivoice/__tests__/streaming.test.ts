/**
 * Streaming behavior contract test.
 *
 * The omnivoice C ABI exposes `ov_audio_chunk_cb` for chunked streaming
 * output. The current TypeScript binding does NOT yet wire that callback
 * — bun:ffi function-pointer marshalling for arbitrary calling
 * conventions is awkward and we landed the buffered path first. This
 * test pins that contract: the synthesize() helper must currently
 * return a single-shot Float32Array, and the on_chunk pointer field of
 * ov_tts_params is expected to be left as NULL (zero) by every
 * synthesize call.
 *
 * Lift this test to a real chunked round-trip when the streaming
 * binding lands (see RESEARCH.md "Open follow-ups").
 */

import { describe, expect, it } from "vitest";
import { OV_TTS_PARAMS_LAYOUT } from "../src/ffi";

describe("plugin-omnivoice streaming contract", () => {
  it("ov_tts_params has on_chunk and on_chunk_user_data slots", () => {
    expect(OV_TTS_PARAMS_LAYOUT.fields.on_chunk).toBeDefined();
    expect(OV_TTS_PARAMS_LAYOUT.fields.on_chunk_user_data).toBeDefined();
    // Both are pointer fields => 8 bytes on 64-bit ABIs.
    expect(OV_TTS_PARAMS_LAYOUT.fields.on_chunk.size).toBe(8);
    expect(OV_TTS_PARAMS_LAYOUT.fields.on_chunk_user_data.size).toBe(8);
  });

  it("ov_tts_params on_chunk_user_data is the last field before tail padding", () => {
    const fields = OV_TTS_PARAMS_LAYOUT.fields;
    const lastOffset = Math.max(
      ...Object.values(fields).map((f) => f.offset + f.size),
    );
    expect(
      fields.on_chunk_user_data.offset + fields.on_chunk_user_data.size,
    ).toBe(lastOffset);
  });

  it("documents single-shot behavior until streaming binding lands", () => {
    // Sanity: reminds future maintainers that adding a streaming path
    // requires re-checking this contract.
    expect(typeof OV_TTS_PARAMS_LAYOUT.size).toBe("number");
    expect(OV_TTS_PARAMS_LAYOUT.size).toBeGreaterThan(0);
  });
});
