/**
 * Mic capture → `PcmRingBuffer` + VAD tee.
 *
 * The `MicSource` interface (see `./types`) is the only seam the rest of the
 * voice loop sees. The first concrete implementation, `DesktopMicSource`,
 * shells out to the platform's standard PCM-capable recorder
 * (`arecord` on Linux, `sox -d` on macOS — the same pattern
 * `plugin-vision/src/audio-capture-stream.ts` established), emits 16 kHz
 * mono `PcmFrame`s, and lets callers tee them anywhere:
 *
 *   mic → DesktopMicSource ─┬─→ PcmRingBuffer  (ASR reads PCM from here)
 *                           └─→ VadDetector    (speech / barge-in signals)
 *
 * Connectors that already have a decoded PCM stream (Discord voice, the
 * Electrobun renderer's `getUserMedia` path, a mobile capture callback)
 * implement `MicSource` over `PushMicSource` instead of spawning a process.
 *
 * No fallback sludge: if no recorder binary is on PATH, `start()` throws —
 * the caller surfaces "no mic backend available", it does not pretend to
 * capture silence.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { PcmRingBuffer } from "./ring-buffer";
import type { AudioSink, MicSource, PcmFrame } from "./types";

const DEFAULT_SAMPLE_RATE = 16_000;
const DEFAULT_FRAME_MS = 32; // 512 samples @ 16 kHz — matches Silero's window.

function frameSamplesFor(sampleRate: number, frameMs: number): number {
  return Math.round((sampleRate * frameMs) / 1000);
}

function now(): number {
  return typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();
}

abstract class BaseMicSource implements MicSource {
  readonly sampleRate: number;
  readonly frameSamples: number;
  protected readonly frameListeners = new Set<(frame: PcmFrame) => void>();
  protected readonly errorListeners = new Set<(error: Error) => void>();
  protected _running = false;

  constructor(sampleRate: number, frameSamples: number) {
    this.sampleRate = sampleRate;
    this.frameSamples = frameSamples;
  }

  get running(): boolean {
    return this._running;
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  onFrame(listener: (frame: PcmFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  protected emitFrame(pcm: Float32Array, timestampMs: number): void {
    const frame: PcmFrame = { pcm, sampleRate: this.sampleRate, timestampMs };
    for (const l of this.frameListeners) l(frame);
  }

  protected emitError(error: Error): void {
    this._running = false;
    for (const l of this.errorListeners) l(error);
  }
}

export interface DesktopMicSourceOptions {
  /** Capture sample rate. Default 16 kHz (what the VAD + Qwen3-ASR expect). */
  sampleRate?: number;
  /** Frame duration in ms. Default 32 ms (one Silero window @ 16 kHz). */
  frameMs?: number;
  /** Recorder program. Default: `arecord` on Linux, `sox` on macOS. */
  program?: string;
  /** Override the recorder argv. When set, `program` is the executable and
   *  these are the args (must produce raw little-endian signed 16-bit mono
   *  PCM at `sampleRate` on stdout). */
  argv?: string[];
  /** ALSA device (Linux `arecord -D`). Default `default`. */
  device?: string;
}

/**
 * `MicSource` backed by a recorder subprocess. Linux uses `arecord`, macOS
 * uses `sox -d`; both stream raw PCM16 mono to stdout, which this class
 * re-frames into fixed-size `Float32Array` frames in [-1, 1].
 *
 * On Windows there is no universally-available CLI recorder, so `start()`
 * throws — the Electrobun renderer's `getUserMedia` path (which feeds a
 * `PushMicSource`) is the Windows route.
 */
export class DesktopMicSource extends BaseMicSource {
  private readonly program: string;
  private readonly argv: string[];
  private proc: ChildProcess | null = null;
  // Carry-over bytes that didn't complete a frame on the last `data` chunk.
  private readonly carry: number[] = [];
  private readonly bytesPerFrame: number;

  constructor(opts: DesktopMicSourceOptions = {}) {
    const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
    const frameMs = opts.frameMs ?? DEFAULT_FRAME_MS;
    const frameSamples = frameSamplesFor(sampleRate, frameMs);
    super(sampleRate, frameSamples);
    this.bytesPerFrame = frameSamples * 2;

    if (opts.program && opts.argv) {
      this.program = opts.program;
      this.argv = opts.argv;
    } else if (process.platform === "linux") {
      this.program = opts.program ?? "arecord";
      this.argv = [
        "-q",
        "-D",
        opts.device ?? "default",
        "-f",
        "S16_LE",
        "-r",
        String(sampleRate),
        "-c",
        "1",
        "-t",
        "raw",
        "-",
      ];
    } else if (process.platform === "darwin") {
      this.program = opts.program ?? "sox";
      this.argv = [
        "-q",
        "-d",
        "-r",
        String(sampleRate),
        "-c",
        "1",
        "-b",
        "16",
        "-e",
        "signed-integer",
        "-t",
        "raw",
        "-",
      ];
    } else {
      this.program = opts.program ?? "";
      this.argv = opts.argv ?? [];
    }
  }

  async start(): Promise<void> {
    if (this._running) return;
    if (!this.program) {
      throw new Error(
        `[voice] No CLI mic recorder available on platform '${process.platform}'. Feed PCM via PushMicSource (e.g. the Electrobun renderer's getUserMedia path) instead.`,
      );
    }
    let proc: ChildProcess;
    try {
      proc = spawn(this.program, this.argv, {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      throw new Error(
        `[voice] Failed to spawn mic recorder '${this.program}': ${
          err instanceof Error ? err.message : String(err)
        }. Install it (Linux: alsa-utils; macOS: sox) or use PushMicSource.`,
      );
    }
    this.proc = proc;

    const stderrChunks: Buffer[] = [];
    proc.stderr?.on("data", (b: Buffer) => {
      stderrChunks.push(b);
      if (stderrChunks.length > 64) stderrChunks.shift();
    });
    proc.stdout?.on("data", (chunk: Buffer) => this.ingest(chunk));
    proc.on("error", (err) => {
      this.emitError(
        new Error(
          `[voice] Mic recorder '${this.program}' error: ${err.message}`,
        ),
      );
    });
    proc.on("exit", (code, signal) => {
      this.proc = null;
      if (this._running) {
        // Exited while we expected it to be running.
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        this.emitError(
          new Error(
            `[voice] Mic recorder '${this.program}' exited unexpectedly (code=${code} signal=${signal})${
              stderr ? `: ${stderr}` : ""
            }`,
          ),
        );
      }
    });

    // Confirm the process is alive and producing audio: arecord/sox emit
    // their first PCM chunk within a few hundred ms; if it dies immediately
    // (bad device, missing binary masquerading) the `exit` handler above
    // already fired. We just need to flip `_running` so callers can tee.
    this._running = true;
  }

  async stop(): Promise<void> {
    this._running = false;
    const proc = this.proc;
    this.proc = null;
    this.carry.length = 0;
    if (proc && proc.exitCode === null) {
      proc.kill("SIGTERM");
      // Best-effort hard kill if it ignores SIGTERM.
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          if (proc.exitCode === null) proc.kill("SIGKILL");
          resolve();
        }, 250);
        proc.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  private ingest(chunk: Buffer): void {
    const ts = now();
    // Accumulate raw bytes, slice into whole frames.
    for (let i = 0; i < chunk.length; i++) this.carry.push(chunk[i]);
    while (this.carry.length >= this.bytesPerFrame) {
      const bytes = this.carry.splice(0, this.bytesPerFrame);
      const pcm = new Float32Array(this.frameSamples);
      for (let s = 0; s < this.frameSamples; s++) {
        const lo = bytes[s * 2];
        const hi = bytes[s * 2 + 1];
        let v = (hi << 8) | lo;
        if (v >= 0x8000) v -= 0x10000;
        pcm[s] = v / 0x8000;
      }
      this.emitFrame(pcm, ts);
    }
  }
}

/**
 * `MicSource` driven by an external producer (Discord opus-decoded PCM, the
 * Electrobun renderer's `getUserMedia` chunks, a mobile capture callback,
 * or a test). The producer calls `push(pcm)` (any sample count, mono,
 * already at `sampleRate`); this class re-frames it to `frameSamples`-long
 * frames and emits them. `start()` / `stop()` just toggle the gate.
 */
export class PushMicSource extends BaseMicSource {
  // Pending samples that didn't complete a frame.
  private pending: Float32Array = new Float32Array(0);
  private pendingStartTimestampMs = 0;

  constructor(
    opts: { sampleRate?: number; frameMs?: number; frameSamples?: number } = {},
  ) {
    const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
    const frameSamples =
      opts.frameSamples ??
      frameSamplesFor(sampleRate, opts.frameMs ?? DEFAULT_FRAME_MS);
    super(sampleRate, frameSamples);
  }

  async start(): Promise<void> {
    this._running = true;
  }

  async stop(): Promise<void> {
    this._running = false;
    this.pending = new Float32Array(0);
    this.pendingStartTimestampMs = 0;
  }

  /**
   * Feed mono PCM in [-1, 1] at `sampleRate`. Re-frames and emits. The
   * timestamp is the first sample's timestamp; emitted frames advance by
   * their sample offset so a large pushed buffer still presents a real audio
   * timeline to VAD/ASR.
   */
  push(pcm: Float32Array, timestampMs = now()): void {
    if (!this._running) return;
    const mergedStartTimestampMs =
      this.pending.length > 0 ? this.pendingStartTimestampMs : timestampMs;
    const merged = new Float32Array(this.pending.length + pcm.length);
    merged.set(this.pending, 0);
    merged.set(pcm, this.pending.length);
    let offset = 0;
    while (merged.length - offset >= this.frameSamples) {
      const frame = merged.slice(offset, offset + this.frameSamples);
      const frameTimestampMs =
        mergedStartTimestampMs + (offset / this.sampleRate) * 1000;
      offset += this.frameSamples;
      this.emitFrame(frame, frameTimestampMs);
    }
    this.pending = merged.slice(offset);
    this.pendingStartTimestampMs =
      this.pending.length > 0
        ? mergedStartTimestampMs + (offset / this.sampleRate) * 1000
        : 0;
  }

  /** Feed mono PCM16 little-endian bytes (Discord / browser path). */
  pushPcm16(bytes: Uint8Array, timestampMs = now()): void {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = Math.floor(bytes.byteLength / 2);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
    this.push(out, timestampMs);
  }

  /** Surface a fatal producer-side error to subscribers. */
  fail(error: Error): void {
    this.emitError(error);
  }
}

/**
 * Wire a `MicSource` to a `PcmRingBuffer` (the buffer the ASR reads PCM
 * from). Returns the ring buffer and an unsubscribe function. The ring
 * buffer's `onOverflow` is forwarded so callers can apply backpressure.
 */
export function pipeMicToRingBuffer(
  source: MicSource,
  sink: AudioSink,
  opts: {
    /** Ring buffer capacity in samples. Default 8 s at the source rate. */
    capacitySamples?: number;
    onOverflow?: (droppedSamples: number) => void;
  } = {},
): { ringBuffer: PcmRingBuffer; unsubscribe: () => void } {
  const capacity = opts.capacitySamples ?? source.sampleRate * 8;
  const ringBuffer = new PcmRingBuffer(capacity, source.sampleRate, sink, {
    onOverflow: opts.onOverflow,
  });
  const off = source.onFrame((frame) => ringBuffer.write(frame.pcm));
  return { ringBuffer, unsubscribe: off };
}
