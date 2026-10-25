/**
 * Minimal PCM WAV encoding for the meeting pipeline: mono Float32 samples in
 * [-1, 1] → 16-bit little-endian PCM WAV. Same container the local-inference
 * voice stack produces/consumes (44-byte canonical header, format 1, mono);
 * reimplemented here — plugins do not import each other's source.
 */

import { Buffer } from "node:buffer";
import { MEETING_AUDIO_SAMPLE_RATE } from "../types";

const HEADER_SIZE = 44;
const BYTES_PER_SAMPLE = 2;

/** Encode mono Float32 PCM ([-1,1], clamped) as a 16-bit PCM WAV Buffer. */
export function float32ToWav(
  samples: Float32Array,
  sampleRate: number = MEETING_AUDIO_SAMPLE_RATE,
): Buffer {
  const dataSize = samples.length * BYTES_PER_SAMPLE;
  const buffer = Buffer.alloc(HEADER_SIZE + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);

  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // fmt sub-chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28); // byte rate
  buffer.writeUInt16LE(BYTES_PER_SAMPLE, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample

  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  let offset = HEADER_SIZE;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    buffer.writeInt16LE(Math.round(int16), offset);
    offset += BYTES_PER_SAMPLE;
  }

  return buffer;
}

/** Concatenate Float32 chunks into one contiguous array. */
export function concatFloat32(
  chunks: ReadonlyArray<Float32Array>,
): Float32Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Decode a mono 16-bit PCM WAV produced by {@link float32ToWav} (tests/round-trip). */
export function wavToFloat32(wav: Buffer): {
  samples: Float32Array;
  sampleRate: number;
} {
  if (wav.length < HEADER_SIZE || wav.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("[MeetingPipeline] Not a RIFF WAV buffer");
  }
  const sampleRate = wav.readUInt32LE(24);
  const dataSize = wav.readUInt32LE(40);
  const count = Math.min(dataSize, wav.length - HEADER_SIZE) / BYTES_PER_SAMPLE;
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const int16 = wav.readInt16LE(HEADER_SIZE + i * BYTES_PER_SAMPLE);
    samples[i] = int16 < 0 ? int16 / 0x8000 : int16 / 0x7fff;
  }
  return { samples, sampleRate };
}
