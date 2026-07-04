/**
 * Fixed-duration rolling buffer of the most recent ambient audio. Accepts only
 * 16 kHz mono Int16 frames, copies their samples, and caps retained audio to
 * `maxSeconds` (default 30) by trimming the oldest samples as new ones arrive.
 * `readTail(seconds)` returns the newest N seconds as a contiguous Int16Array,
 * letting the service replay the moment just before a response decision.
 */
import type { AudioFrame } from "./types.ts";

interface StoredFrame {
  samples: Int16Array;
  capturedAt: number;
}

export class ReplayBuffer {
  readonly sampleRate = 16000;
  readonly channels = 1;
  readonly maxSeconds: number;

  private frames: StoredFrame[] = [];
  private totalSamples = 0;

  constructor(maxSeconds = 30) {
    if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) {
      throw new Error("maxSeconds must be positive");
    }
    this.maxSeconds = maxSeconds;
  }

  push(frame: AudioFrame): void {
    if (
      frame.sampleRate !== this.sampleRate ||
      frame.channels !== this.channels
    ) {
      throw new Error("ambient audio frames must be 16 kHz mono Int16");
    }
    if (!(frame.samples instanceof Int16Array)) {
      throw new Error("ambient audio samples must be Int16Array");
    }

    const samples = new Int16Array(frame.samples);
    this.frames.push({ samples, capturedAt: frame.capturedAt });
    this.totalSamples += samples.length;
    this.trim();
  }

  readTail(seconds = this.maxSeconds): Int16Array {
    if (!Number.isFinite(seconds) || seconds <= 0) return new Int16Array();
    const maxSamples = Math.min(
      this.totalSamples,
      Math.floor(seconds * this.sampleRate),
    );
    const out = new Int16Array(maxSamples);
    let writeOffset = maxSamples;

    for (let i = this.frames.length - 1; i >= 0 && writeOffset > 0; i--) {
      const frame = this.frames[i];
      if (!frame) continue;
      const take = Math.min(writeOffset, frame.samples.length);
      const start = frame.samples.length - take;
      writeOffset -= take;
      out.set(frame.samples.subarray(start), writeOffset);
    }

    return out;
  }

  clear(): void {
    this.frames = [];
    this.totalSamples = 0;
  }

  private trim(): void {
    const maxSamples = Math.floor(this.maxSeconds * this.sampleRate);
    while (this.totalSamples > maxSamples && this.frames.length > 0) {
      const frame = this.frames[0];
      if (!frame) break;
      const overflow = this.totalSamples - maxSamples;
      if (overflow >= frame.samples.length) {
        this.frames.shift();
        this.totalSamples -= frame.samples.length;
        continue;
      }

      this.frames[0] = {
        ...frame,
        samples: frame.samples.slice(overflow),
      };
      this.totalSamples -= overflow;
    }
  }
}
