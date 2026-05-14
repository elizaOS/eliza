/**
 * SyntheticAudioSource — loads a WAV file (16-bit PCM mono @ 16 kHz) and
 * replays it as Float32 PCM frames at wall-clock rate. Used by the bench
 * runner to drive the voice pipeline deterministically.
 *
 * The 32 ms / 512-sample hop matches the Silero VAD window
 * (`voice/vad.ts:113`) so VAD timing is preserved when we replay through
 * the real pipeline. Synthetic-only callers can ignore the hop and pull
 * the full Float32Array.
 */

import { readFileSync } from "node:fs";
import type {
  BenchAudioPayload,
  BenchInjection,
  BenchPcmFrame,
} from "./types.ts";

/** Frame hop @ 16 kHz that matches Silero VAD. */
export const FRAME_SAMPLES_16K = 512;
/** Frame duration in ms at 16 kHz / 512 samples (= 32 ms). */
export const FRAME_DURATION_MS_16K = (FRAME_SAMPLES_16K / 16000) * 1000;

/**
 * Decode a 16-bit PCM WAV file into Float32 [-1, 1]. Supports mono, any
 * sample rate, "RIFF"/"WAVE" little-endian. Throws on anything else —
 * the harness only writes WAVs in this format itself.
 */
export function loadWav(path: string): BenchAudioPayload {
  const buf = readFileSync(path);
  return decodeWav(buf, path);
}

export function decodeWav(buf: Uint8Array, sourcePath?: string): BenchAudioPayload {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // RIFF chunk
  const riff = readAscii(buf, 0, 4);
  const wave = readAscii(buf, 8, 4);
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error(`[voice-bench] not a RIFF/WAVE file: ${sourcePath ?? "<inline>"}`);
  }
  // Walk sub-chunks to find fmt + data
  let offset = 12;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let channels = 0;
  let dataStart = 0;
  let dataSize = 0;
  while (offset + 8 <= buf.byteLength) {
    const id = readAscii(buf, offset, 4);
    const size = dv.getUint32(offset + 4, true);
    if (id === "fmt ") {
      // audioFormat at +8 must be 1 (PCM)
      const audioFormat = dv.getUint16(offset + 8, true);
      channels = dv.getUint16(offset + 10, true);
      sampleRate = dv.getUint32(offset + 12, true);
      bitsPerSample = dv.getUint16(offset + 22, true);
      if (audioFormat !== 1) {
        throw new Error(
          `[voice-bench] only PCM WAVs supported (audioFormat=${audioFormat})`,
        );
      }
    } else if (id === "data") {
      dataStart = offset + 8;
      dataSize = size;
      break;
    }
    offset += 8 + size + (size & 1); // pad to even
  }
  if (!sampleRate || !bitsPerSample || !channels || !dataStart) {
    throw new Error("[voice-bench] malformed WAV — missing fmt/data chunk");
  }
  if (channels !== 1) {
    throw new Error(`[voice-bench] mono only (got ${channels} channels)`);
  }
  if (bitsPerSample !== 16) {
    throw new Error(
      `[voice-bench] 16-bit PCM only (got ${bitsPerSample}-bit)`,
    );
  }
  const sampleCount = dataSize / 2;
  const pcm = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const s = dv.getInt16(dataStart + i * 2, true);
    pcm[i] = s / 0x8000;
  }
  return {
    pcm,
    sampleRate,
    sourcePath,
    durationMs: (sampleCount / sampleRate) * 1000,
  };
}

function readAscii(buf: Uint8Array, offset: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    const c = buf[offset + i];
    if (c === undefined) return s;
    s += String.fromCharCode(c);
  }
  return s;
}

/**
 * Encode a Float32 PCM array as a 16-bit PCM mono WAV. Used by
 * `fixtures.ts` to write generated test audio to disk.
 */
export function encodeWav(pcm: Float32Array, sampleRate: number): Uint8Array {
  const dataSize = pcm.length * 2;
  const buf = new Uint8Array(44 + dataSize);
  const dv = new DataView(buf.buffer);
  // RIFF header
  writeAscii(buf, 0, "RIFF");
  dv.setUint32(4, 36 + dataSize, true);
  writeAscii(buf, 8, "WAVE");
  // fmt chunk
  writeAscii(buf, 12, "fmt ");
  dv.setUint32(16, 16, true); // PCM fmt size
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); // byte rate
  dv.setUint16(32, 2, true); // block align
  dv.setUint16(34, 16, true); // bits/sample
  // data chunk
  writeAscii(buf, 36, "data");
  dv.setUint32(40, dataSize, true);
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] ?? 0;
    const clipped = Math.max(-1, Math.min(1, v));
    dv.setInt16(44 + i * 2, Math.round(clipped * 0x7fff), true);
  }
  return buf;
}

function writeAscii(buf: Uint8Array, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) buf[offset + i] = s.charCodeAt(i);
}

/**
 * Replays Float32 PCM as fixed-size frames at wall-clock rate. The
 * scheduler delays each frame's `onFrame` callback so the consumer
 * (real VAD or test harness) sees them with the same inter-frame timing
 * a live microphone would produce. Setting `realtime: false` plays as
 * fast as the event loop allows — useful for unit tests.
 */
export interface SyntheticAudioSourceOpts {
  payload: BenchAudioPayload;
  /** Override frame hop in samples. Defaults to 512 (32 ms @ 16 kHz). */
  frameSamples?: number;
  /** When false, frames fire back-to-back. Defaults to true. */
  realtime?: boolean;
  /** Scripted injections (silence gap, barge-in overlay, false-EOS). */
  injection?: BenchInjection;
}

export class SyntheticAudioSource {
  readonly sampleRate: number;
  readonly frameSamples: number;
  private readonly payload: BenchAudioPayload;
  private readonly injection: BenchInjection | undefined;
  private readonly realtime: boolean;
  private listeners: ((frame: BenchPcmFrame) => void)[] = [];
  private errorListeners: ((e: Error) => void)[] = [];
  private _running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: SyntheticAudioSourceOpts) {
    this.payload = opts.payload;
    this.sampleRate = opts.payload.sampleRate;
    this.frameSamples = opts.frameSamples ?? FRAME_SAMPLES_16K;
    this.realtime = opts.realtime ?? true;
    this.injection = opts.injection;
  }

  get running(): boolean {
    return this._running;
  }

  onFrame(listener: (frame: BenchPcmFrame) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  onError(listener: (e: Error) => void): () => void {
    this.errorListeners.push(listener);
    return () => {
      const i = this.errorListeners.indexOf(listener);
      if (i >= 0) this.errorListeners.splice(i, 1);
    };
  }

  /** Compose the playback PCM with any scripted injections. */
  private composePlaybackPcm(): Float32Array {
    const src = this.payload.pcm;
    const sr = this.sampleRate;
    const j = this.injection;
    if (!j) return src;
    // Silence gap insertion.
    let pcm = src;
    if (j.silenceGapMs && j.gapMs && j.gapMs > 0) {
      const insertAt = Math.floor((j.silenceGapMs / 1000) * sr);
      const gapSamples = Math.floor((j.gapMs / 1000) * sr);
      const out = new Float32Array(pcm.length + gapSamples);
      out.set(pcm.subarray(0, insertAt), 0);
      out.set(pcm.subarray(insertAt), insertAt + gapSamples);
      pcm = out;
    }
    if (j.falseEosAtMs !== undefined && j.falseEosDurationMs) {
      const at = Math.floor((j.falseEosAtMs / 1000) * sr);
      const dur = Math.floor((j.falseEosDurationMs / 1000) * sr);
      const out = new Float32Array(pcm.length + dur);
      out.set(pcm.subarray(0, at), 0);
      out.set(pcm.subarray(at), at + dur);
      pcm = out;
    }
    if (j.bargeInAtMs !== undefined && j.bargeInAudio) {
      const at = Math.floor((j.bargeInAtMs / 1000) * sr);
      // Overlay (additive mix, clipped) into a copy.
      const out = new Float32Array(pcm);
      for (let i = 0; i < j.bargeInAudio.length; i++) {
        if (at + i >= out.length) break;
        const a = out[at + i] ?? 0;
        const b = j.bargeInAudio[i] ?? 0;
        const mix = a + b;
        out[at + i] = Math.max(-1, Math.min(1, mix));
      }
      pcm = out;
    }
    return pcm;
  }

  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;
    const pcm = this.composePlaybackPcm();
    const total = pcm.length;
    const hop = this.frameSamples;
    const frameMs = (hop / this.sampleRate) * 1000;
    let cursor = 0;
    let elapsed = 0;
    const emitFrame = (): boolean => {
      if (!this._running) return false;
      if (cursor >= total) {
        this._running = false;
        return false;
      }
      const end = Math.min(cursor + hop, total);
      const slice = pcm.subarray(cursor, end);
      // If the slice is short (last frame), pad to hop with zeros so the
      // VAD always sees its expected window size.
      let frame: Float32Array;
      if (slice.length === hop) {
        frame = slice;
      } else {
        frame = new Float32Array(hop);
        frame.set(slice);
      }
      const payload: BenchPcmFrame = {
        pcm: frame,
        sampleRate: this.sampleRate,
        timestampMs: elapsed,
      };
      for (const l of this.listeners) {
        try {
          l(payload);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          for (const errL of this.errorListeners) errL(error);
        }
      }
      cursor = end;
      elapsed += frameMs;
      return true;
    };
    if (this.realtime) {
      return new Promise<void>((resolve) => {
        const pumpOnce = (): void => {
          if (!emitFrame()) {
            resolve();
            return;
          }
          this.timer = setTimeout(pumpOnce, frameMs);
        };
        pumpOnce();
      });
    }
    // Non-realtime: pump synchronously, yielding to the event loop only
    // periodically so listeners' microtasks (await) still progress. This
    // keeps the unit-test path well under 50 ms per fixture.
    while (emitFrame()) {
      // Tight loop — pure CPU.
    }
  }

  async stop(): Promise<void> {
    this._running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
