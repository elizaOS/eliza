/**
 * PulseAudio capture path for the Zoom Web bot (Linux / containers).
 *
 * Ported from Vexa's PulseAudioCapture + per-bot null-sink setup
 * (services/audio-pipeline.ts, index.ts, Apache-2.0), reshaped to emit
 * Float32 16 kHz PCM chunks for MeetingAudioSink instead of WAV upload
 * chunks:
 *  - createNullSink()/unloadNullSink(): `pactl load-module module-null-sink`
 *    creates a per-bot sink; the browser is launched with PULSE_SINK set so
 *    its output lands there and concurrent bots don't cross-contaminate.
 *  - PulsePcmCapture: spawns `parecord --raw --format=s16le --rate=16000
 *    --channels=1 --device=<sink>.monitor`, slices stdout into fixed-size
 *    sample chunks, converts s16le → Float32, and invokes onChunk.
 *
 * The child-process seam is injectable so chunking/conversion is
 * unit-testable without PulseAudio.
 */

import { execFile, spawn as nodeSpawn } from "node:child_process";
import type { Readable } from "node:stream";
import { logger } from "@elizaos/core";

const TAG = "[ZoomAdapter]";

export interface ChildProcessLike {
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(
    event: "exit",
    listener: (code: number | null, signal: string | null) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFn = (command: string, args: string[]) => ChildProcessLike;

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.toString().trim());
    });
  });
}

/** True when pactl exists and a PulseAudio server answers. */
export async function pulseAudioAvailable(): Promise<boolean> {
  try {
    await execFileText("pactl", ["info"]);
    return true;
  } catch {
    return false;
  }
}

export interface NullSink {
  sinkName: string;
  moduleId: string;
}

/** Create a per-bot null sink so the bot's browser audio is isolated. */
export async function createNullSink(sessionId: string): Promise<NullSink> {
  const sinkName = `eliza_meet_${sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`;
  const moduleId = await execFileText("pactl", [
    "load-module",
    "module-null-sink",
    `sink_name=${sinkName}`,
    `sink_properties=device.description="ElizaMeetSink_${sinkName}"`,
  ]);
  logger.info({ sinkName, moduleId }, `${TAG} PulseAudio null sink created`);
  return { sinkName, moduleId };
}

export async function unloadNullSink(sink: NullSink): Promise<void> {
  try {
    await execFileText("pactl", ["unload-module", sink.moduleId]);
    logger.info(
      { sinkName: sink.sinkName },
      `${TAG} PulseAudio null sink unloaded`,
    );
  } catch (err) {
    logger.warn(
      {
        sinkName: sink.sinkName,
        error: err instanceof Error ? err.message : String(err),
      },
      `${TAG} failed to unload PulseAudio sink`,
    );
  }
}

export interface PulsePcmCaptureOptions {
  /** Sink name; parecord reads from `<device>.monitor`. */
  device: string;
  /** Samples per emitted chunk (default 4096 ≈ 256 ms at 16 kHz). */
  chunkSamples?: number;
  onChunk: (samples: Float32Array) => void;
  /** Injectable for tests (default node:child_process spawn). */
  spawn?: SpawnFn;
}

const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2; // s16le mono

export class PulsePcmCapture {
  private readonly device: string;
  private readonly chunkBytes: number;
  private readonly onChunk: (samples: Float32Array) => void;
  private readonly spawnFn: SpawnFn;

  private child: ChildProcessLike | null = null;
  private pending: Buffer = Buffer.alloc(0);
  private stopped = false;
  private firstDataAt: number | null = null;

  constructor(options: PulsePcmCaptureOptions) {
    this.device = options.device;
    this.chunkBytes = (options.chunkSamples ?? 4096) * BYTES_PER_SAMPLE;
    this.onChunk = options.onChunk;
    this.spawnFn =
      options.spawn ??
      ((command, args) =>
        nodeSpawn(command, args) as unknown as ChildProcessLike);
  }

  /** Epoch ms when the first audio byte arrived, or null. */
  get receivedFirstAudioAt(): number | null {
    return this.firstDataAt;
  }

  start(): void {
    if (this.stopped)
      throw new Error(
        `${TAG} PulsePcmCapture cannot be restarted after stop()`,
      );
    if (this.child)
      throw new Error(`${TAG} PulsePcmCapture.start() called twice`);
    const child = this.spawnFn("parecord", [
      "--raw",
      "--format=s16le",
      `--rate=${SAMPLE_RATE}`,
      "--channels=1",
      `--device=${this.device}.monitor`,
    ]);
    this.child = child;
    if (!child.stdout) {
      throw new Error(`${TAG} parecord has no stdout`);
    }
    child.stdout.on("data", (buf: Buffer) => {
      if (this.stopped) return;
      if (this.firstDataAt === null) {
        this.firstDataAt = Date.now();
        logger.info(
          { device: `${this.device}.monitor` },
          `${TAG} parecord receiving audio`,
        );
      }
      this.appendAndSlice(buf);
    });
    child.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) logger.warn({ msg }, `${TAG} parecord stderr`);
    });
    child.on("error", (err: Error) => {
      logger.error({ error: err.message }, `${TAG} parecord process error`);
    });
    child.on("exit", (code, signal) => {
      logger.info({ code, signal }, `${TAG} parecord exited`);
      this.child = null;
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.child) {
      try {
        this.child.kill("SIGTERM");
      } catch (err) {
        logger.warn(
          {
            error: err instanceof Error ? err.message : String(err),
          },
          `${TAG} parecord kill failed`,
        );
      }
      this.child = null;
    }
    // Flush the sub-chunk tail so no audio is lost at teardown.
    const tailSamples = Math.floor(this.pending.length / BYTES_PER_SAMPLE);
    if (tailSamples > 0) {
      this.onChunk(
        s16leToFloat32(
          this.pending.subarray(0, tailSamples * BYTES_PER_SAMPLE),
        ),
      );
    }
    this.pending = Buffer.alloc(0);
  }

  private appendAndSlice(buf: Buffer): void {
    this.pending =
      this.pending.length === 0 ? buf : Buffer.concat([this.pending, buf]);
    while (this.pending.length >= this.chunkBytes) {
      const slice = this.pending.subarray(0, this.chunkBytes);
      this.pending = this.pending.subarray(this.chunkBytes);
      this.onChunk(s16leToFloat32(slice));
    }
  }
}

/** Convert little-endian signed 16-bit PCM bytes to normalized Float32. */
export function s16leToFloat32(bytes: Buffer): Float32Array {
  const sampleCount = Math.floor(bytes.length / BYTES_PER_SAMPLE);
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const s = bytes.readInt16LE(i * BYTES_PER_SAMPLE);
    out[i] = s < 0 ? s / 32768 : s / 32767;
  }
  return out;
}
