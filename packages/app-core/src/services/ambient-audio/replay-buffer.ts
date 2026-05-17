import type { AudioFrame, ReplayBufferConfig } from "./types.ts";

export class ReplayBuffer {
  private readonly frames: AudioFrame[] = [];
  private readonly maxMs: number;
  private bytes = 0;

  constructor(private readonly config: ReplayBufferConfig) {
    if (config.maxSeconds <= 0) {
      throw new Error("ReplayBuffer.maxSeconds must be positive");
    }
    this.maxMs = config.maxSeconds * 1000;
  }

  push(frame: AudioFrame): void {
    if (frame.endMs < frame.startMs) {
      throw new Error("ReplayBuffer.push: frame.endMs < frame.startMs");
    }
    if (frame.sampleRate !== this.config.sampleRate) {
      throw new Error(
        `ReplayBuffer.push: frame sampleRate ${frame.sampleRate} != ${this.config.sampleRate}`,
      );
    }
    this.frames.push(frame);
    this.bytes += frame.pcm.byteLength;
    this.evict(frame.endMs);
  }

  private evict(headMs: number): void {
    const cutoff = headMs - this.maxMs;
    while (this.frames.length > 0) {
      const head = this.frames[0];
      if (head === undefined) break;
      if (head.endMs <= cutoff) {
        this.frames.shift();
        this.bytes -= head.pcm.byteLength;
        continue;
      }
      break;
    }
  }

  tail(seconds: number): AudioFrame[] {
    if (this.frames.length === 0) return [];
    const lastFrame = this.frames[this.frames.length - 1];
    if (lastFrame === undefined) return [];
    const cutoff = lastFrame.endMs - seconds * 1000;
    return this.frames.filter((f) => f.endMs > cutoff);
  }

  drain(): AudioFrame[] {
    const out = this.frames.slice();
    this.frames.length = 0;
    this.bytes = 0;
    return out;
  }

  clear(): void {
    this.frames.length = 0;
    this.bytes = 0;
  }

  bytesUsed(): number {
    return this.bytes;
  }

  frameCount(): number {
    return this.frames.length;
  }
}
