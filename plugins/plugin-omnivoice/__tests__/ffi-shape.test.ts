import { describe, expect, it } from "vitest";
import {
  _internal,
  OV_ABI_VERSION,
  OV_AUDIO_LAYOUT,
  OV_INIT_PARAMS_LAYOUT,
  OV_TTS_PARAMS_LAYOUT,
} from "../src/ffi";

describe("plugin-omnivoice FFI shape", () => {
  it("ABI version matches omnivoice.h OV_ABI_VERSION", () => {
    expect(OV_ABI_VERSION).toBe(2);
  });

  it("ov_init_params layout matches the C struct order", () => {
    const f = OV_INIT_PARAMS_LAYOUT.fields;
    expect(f.abi_version.offset).toBe(0);
    // 4-byte int + 4 bytes pad to 8-byte ptr alignment.
    expect(f.model_path.offset).toBe(8);
    expect(f.codec_path.offset).toBe(16);
    expect(f.use_fa.offset).toBe(24);
    expect(f.clamp_fp16.offset).toBe(25);
    // tail-aligned to max field alignment (8).
    expect(OV_INIT_PARAMS_LAYOUT.size).toBeGreaterThanOrEqual(26);
    expect(OV_INIT_PARAMS_LAYOUT.size % 8).toBe(0);
  });

  it("ov_audio layout matches the C struct order", () => {
    const f = OV_AUDIO_LAYOUT.fields;
    expect(f.samples.offset).toBe(0);
    expect(f.n_samples.offset).toBe(8);
    expect(f.sample_rate.offset).toBe(12);
    expect(f.channels.offset).toBe(16);
    expect(OV_AUDIO_LAYOUT.size).toBeGreaterThanOrEqual(20);
  });

  it("ov_tts_params layout starts with abi_version then text", () => {
    const f = OV_TTS_PARAMS_LAYOUT.fields;
    expect(f.abi_version.offset).toBe(0);
    // first pointer field aligned to 8.
    expect(f.text.offset).toBe(8);
    // mg_seed must be aligned to 8.
    expect(f.mg_seed.offset % 8).toBe(0);
    // total size aligned.
    expect(OV_TTS_PARAMS_LAYOUT.size % 8).toBe(0);
  });

  it("encodeCString NUL-terminates and matches UTF-8 length", () => {
    const buf = _internal.encodeCString("hi");
    expect(buf.length).toBe(3);
    expect(buf[2]).toBe(0);
    expect(buf[0]).toBe(104); // 'h'
    expect(buf[1]).toBe(105); // 'i'
  });

  it("default lib name is platform-correct", () => {
    const name = _internal.expectedDefaultLibName();
    if (process.platform === "darwin") expect(name).toBe("libomnivoice.dylib");
    else if (process.platform === "win32") expect(name).toBe("omnivoice.dll");
    else expect(name).toBe("libomnivoice.so");
  });

  it("alignment helper is correct", () => {
    expect(_internal.align(0, 8)).toBe(0);
    expect(_internal.align(1, 8)).toBe(8);
    expect(_internal.align(8, 8)).toBe(8);
    expect(_internal.align(9, 8)).toBe(16);
  });
});
