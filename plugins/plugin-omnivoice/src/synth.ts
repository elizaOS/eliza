/**
 * High-level glue between elizaOS TTS handler params and the omnivoice
 * C ABI. Resolves voice-design knobs into the `instruct` string,
 * marshals reference audio, and wraps the resulting Float32 PCM in a
 * 44-byte WAV header so the existing plugin-elevenlabs consumer code
 * (which expects audio/wav or audio/mpeg Buffers) is drop-in compatible.
 */

import { logger } from "@elizaos/core";
import { coerceEmotion, emotionToOmnivoiceKeyword } from "./emotion-local";
import {
  OmnivoiceContext,
  OV_TTS_PARAMS_LAYOUT,
} from "./ffi";
import type {
  OmnivoiceSynthesisResult,
  OmnivoiceSynthesizeOptions,
  OmnivoiceVoiceDesign,
} from "./types";

function buildInstruct(
  design: OmnivoiceVoiceDesign | undefined,
  explicit: string | undefined,
): string | undefined {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  if (!design) return undefined;
  const parts: string[] = [];
  if (design.gender) parts.push(design.gender);
  if (design.age) parts.push(design.age);
  if (design.pitch) parts.push(design.pitch);
  if (design.style) parts.push(design.style);
  if (design.volume) parts.push(design.volume);
  if (design.emotion) {
    const keyword = emotionToOmnivoiceKeyword(coerceEmotion(design.emotion));
    if (keyword) parts.push(keyword);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function encodeCString(s: string): Uint8Array {
  const enc = new TextEncoder().encode(s);
  const buf = new Uint8Array(enc.length + 1);
  buf.set(enc, 0);
  buf[enc.length] = 0;
  return buf;
}

/** Run synthesis with elizaOS-shaped options and return raw PCM result. */
export async function runSynthesis(
  ctx: OmnivoiceContext,
  opts: OmnivoiceSynthesizeOptions,
): Promise<OmnivoiceSynthesisResult> {
  if (typeof opts.text !== "string" || opts.text.trim().length === 0) {
    throw new Error("omnivoice synthesis requires non-empty text");
  }
  const instruct = buildInstruct(opts.design, opts.instruct);
  logger.debug(
    `[plugin-omnivoice] synthesize text=${opts.text.length}ch lang=${opts.lang ?? ""} instruct=${instruct ?? ""}`,
  );

  return ctx.synthesize((view, layout, ffi, retain) => {
    const fields = layout.fields;
    const textBuf = encodeCString(opts.text);
    retain(textBuf);
    view.setBigUint64(fields.text.offset, ffi.ptr(textBuf), true);

    if (opts.lang) {
      const langBuf = encodeCString(opts.lang);
      retain(langBuf);
      view.setBigUint64(fields.lang.offset, ffi.ptr(langBuf), true);
    }
    if (instruct) {
      const ibuf = encodeCString(instruct);
      retain(ibuf);
      view.setBigUint64(fields.instruct.offset, ffi.ptr(ibuf), true);
    }

    if (typeof opts.frameOverride === "number" && opts.frameOverride > 0) {
      view.setInt32(fields.T_override.offset, opts.frameOverride, true);
    }
    if (typeof opts.chunkDurationSec === "number") {
      view.setFloat32(fields.chunk_duration_sec.offset, opts.chunkDurationSec, true);
    }
    if (typeof opts.chunkThresholdSec === "number") {
      view.setFloat32(fields.chunk_threshold_sec.offset, opts.chunkThresholdSec, true);
    }
    if (typeof opts.denoise === "boolean") {
      view.setUint8(fields.denoise.offset, opts.denoise ? 1 : 0);
    }
    if (typeof opts.preprocessPrompt === "boolean") {
      view.setUint8(fields.preprocess_prompt.offset, opts.preprocessPrompt ? 1 : 0);
    }
    if (opts.maskgit) {
      const m = opts.maskgit;
      if (typeof m.numStep === "number") view.setInt32(fields.mg_num_step.offset, m.numStep, true);
      if (typeof m.guidanceScale === "number") view.setFloat32(fields.mg_guidance_scale.offset, m.guidanceScale, true);
      if (typeof m.tShift === "number") view.setFloat32(fields.mg_t_shift.offset, m.tShift, true);
      if (typeof m.layerPenaltyFactor === "number") view.setFloat32(fields.mg_layer_penalty_factor.offset, m.layerPenaltyFactor, true);
      if (typeof m.positionTemperature === "number") view.setFloat32(fields.mg_position_temperature.offset, m.positionTemperature, true);
      if (typeof m.classTemperature === "number") view.setFloat32(fields.mg_class_temperature.offset, m.classTemperature, true);
      if (typeof m.seed !== "undefined") {
        view.setBigUint64(fields.mg_seed.offset, BigInt(m.seed), true);
      }
    }
    if (opts.reference?.audio24k) {
      const refBuf = new Uint8Array(opts.reference.audio24k.buffer.slice(
        opts.reference.audio24k.byteOffset,
        opts.reference.audio24k.byteOffset + opts.reference.audio24k.byteLength,
      ));
      retain(refBuf);
      view.setBigUint64(fields.ref_audio_24k.offset, ffi.ptr(refBuf), true);
      view.setInt32(fields.ref_n_samples.offset, opts.reference.audio24k.length, true);
    }
    if (opts.reference?.text) {
      const rtxt = encodeCString(opts.reference.text);
      retain(rtxt);
      view.setBigUint64(fields.ref_text.offset, ffi.ptr(rtxt), true);
    }
  });
}

/** Wrap mono float PCM in a canonical 16-bit PCM WAV (RIFF) container. */
export function pcmFloatToWavBuffer(
  samples: Float32Array,
  sampleRate: number,
  channels: number,
): Buffer {
  const bytesPerSample = 2;
  const dataBytes = samples.length * bytesPerSample;
  const headerBytes = 44;
  const buf = Buffer.alloc(headerBytes + dataBytes);
  // RIFF header
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  // fmt chunk
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(8 * bytesPerSample, 34);
  // data chunk
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  // Float32 [-1,1] -> PCM16
  let offset = headerBytes;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    buf.writeInt16LE(Math.round(sample * 32767), offset);
    offset += bytesPerSample;
  }
  return buf;
}

/** Re-export for tests. */
export const _internal = { buildInstruct, encodeCString };

// Public re-exports for the OV_TTS_PARAMS_LAYOUT consumers.
export { OV_TTS_PARAMS_LAYOUT };
