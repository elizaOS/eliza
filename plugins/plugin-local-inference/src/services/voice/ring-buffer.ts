import type { AudioSink } from "./types";

export interface PcmRingBufferOptions {
  /**
   * Fired when the buffer is full and a write overwrites unread samples.
   * Reports the count of dropped samples in this write call. Schedulers
   * should use this signal to apply backpressure upstream — silent
   * overwrites produce audible glitches.
   */
  onOverflow?: (droppedSamples: number) => void;
}

export class PcmRingBuffer {
  private readonly buf: Float32Array;
  private readPos = 0;
  private writePos = 0;
  private filled = 0;
  private readonly onOverflow?: (droppedSamples: number) => void;

  constructor(
    private readonly capacity: number,
    private readonly sampleRate: number,
    private readonly sink: AudioSink,
    options: PcmRingBufferOptions = {},
  ) {
    if (capacity <= 0) {
      throw new Error("PcmRingBuffer: capacity must be positive");
    }
    this.buf = new Float32Array(capacity);
    this.onOverflow = options.onOverflow;
  }

  write(pcm: Float32Array): void {
    let dropped = 0;
    for (let i = 0; i < pcm.length; i++) {
      this.buf[this.writePos] = pcm[i];
      this.writePos = (this.writePos + 1) % this.capacity;
      if (this.filled < this.capacity) {
        this.filled++;
      } else {
        this.readPos = (this.readPos + 1) % this.capacity;
        dropped++;
      }
    }
    if (dropped > 0 && this.onOverflow) {
      this.onOverflow(dropped);
    }
  }

  /** Fill ratio in [0, 1]. Schedulers can throttle TTS dispatches as this approaches 1. */
  pressure(): number {
    return this.filled / this.capacity;
  }

  flushToSink(): number {
    if (this.filled === 0) return 0;
    const out = new Float32Array(this.filled);
    for (let i = 0; i < this.filled; i++) {
      out[i] = this.buf[(this.readPos + i) % this.capacity];
    }
    const n = this.filled;
    this.readPos = this.writePos;
    this.filled = 0;
    this.sink.write(out, this.sampleRate);
    return n;
  }

  drain(): void {
    this.readPos = this.writePos;
    this.filled = 0;
    this.sink.drain();
  }

  size(): number {
    return this.filled;
  }

  capacityHint(): number {
    return this.capacity;
  }
}

export class InMemoryAudioSink implements AudioSink {
  readonly chunks: Array<{ pcm: Float32Array; sampleRate: number }> = [];
  private buffered = 0;

  write(pcm: Float32Array, sampleRate: number): void {
    this.chunks.push({ pcm, sampleRate });
    this.buffered += pcm.length;
  }

  drain(): void {
    this.buffered = 0;
  }

  bufferedSamples(): number {
    return this.buffered;
  }

  totalWritten(): number {
    let n = 0;
    for (const c of this.chunks) n += c.pcm.length;
    return n;
  }
}
