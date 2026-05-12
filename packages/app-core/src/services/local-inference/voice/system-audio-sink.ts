/**
 * System audio sinks for the interactive voice harness.
 *
 * The voice scheduler writes synthesized PCM (`Float32Array` mono in
 * [-1, 1] at the bridge sample rate) into an {@link AudioSink}. For tests
 * and headless runs `InMemoryAudioSink` (in `./ring-buffer`) captures the
 * samples; for an interactive session the harness needs the audio to
 * actually come out of the speakers.
 *
 * `SystemAudioSink` shells out to a long-lived player that reads raw 16-bit
 * signed-LE PCM on stdin. Per-platform selection (priority order):
 *   - Linux:   `aplay` (alsa-utils), else `paplay` (PulseAudio), else
 *              `play`/`sox` (sox), else `ffplay` (ffmpeg).
 *   - macOS:   `play`/`sox` (sox), else `ffplay` (ffmpeg). `afplay` needs a
 *              file (no stdin) so it cannot be used for streaming.
 *   - Windows: `ffplay` (ffmpeg), else `play`/`sox` if installed. PowerShell's
 *              `Media.SoundPlayer` also needs a file, not a stream, so it's not
 *              used here — the renderer's `AudioContext` path (feeding nothing
 *              here; the renderer plays directly) is the no-ffmpeg route.
 * If no player is on `PATH`, `available()` returns false and the harness
 * falls back to `WavFileAudioSink` (writes a rolling WAV) — never silence.
 *
 * `WavFileAudioSink` accumulates everything written and serializes a
 * single mono PCM16 WAV on `finalize()` — used by `--no-audio` and as the
 * no-player fallback.
 */

import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { Writable } from "node:stream";
import type { AudioSink } from "./types";

function which(bin: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  const exts =
    process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function floatToPcm16(pcm: Float32Array): Buffer {
  const out = Buffer.allocUnsafe(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    let s = pcm[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    out.writeInt16LE((s * 0x7fff) | 0, i * 2);
  }
  return out;
}

function soxRawArgs(sampleRate: number): string[] {
  return [
    "-q",
    "-t",
    "raw",
    "-r",
    String(sampleRate),
    "-e",
    "signed",
    "-b",
    "16",
    "-c",
    "1",
    "-",
  ];
}

function ffplayRawArgs(sampleRate: number): string[] {
  // ffplay reads raw PCM with -f s16le; -nodisp suppresses the window,
  // -autoexit quits at EOF, -i - reads stdin.
  return [
    "-loglevel",
    "error",
    "-nodisp",
    "-autoexit",
    "-f",
    "s16le",
    "-ar",
    String(sampleRate),
    "-ac",
    "1",
    "-i",
    "-",
  ];
}

/** Pick a CLI player that reads raw PCM16-LE on stdin, for the host platform. */
function resolvePlayer(
  sampleRate: number,
): { bin: string; args: string[] } | null {
  if (process.platform === "linux") {
    const aplay = which("aplay");
    if (aplay) {
      return {
        bin: aplay,
        args: [
          "-q",
          "-f",
          "S16_LE",
          "-c",
          "1",
          "-r",
          String(sampleRate),
          "-t",
          "raw",
          "-",
        ],
      };
    }
    const paplay = which("paplay");
    if (paplay) {
      return {
        bin: paplay,
        args: [
          "--raw",
          `--format=s16le`,
          "--channels=1",
          `--rate=${sampleRate}`,
        ],
      };
    }
    const play = which("play");
    if (play) return { bin: play, args: soxRawArgs(sampleRate) };
    const sox = which("sox");
    if (sox) return { bin: sox, args: [...soxRawArgs(sampleRate), "-d"] };
    const ffplay = which("ffplay");
    if (ffplay) return { bin: ffplay, args: ffplayRawArgs(sampleRate) };
    return null;
  }
  if (process.platform === "darwin") {
    // `afplay` needs a file (no stdin), so it can't stream — use sox/ffplay.
    const play = which("play");
    if (play) return { bin: play, args: soxRawArgs(sampleRate) };
    const sox = which("sox");
    if (sox) return { bin: sox, args: [...soxRawArgs(sampleRate), "-d"] };
    const ffplay = which("ffplay");
    if (ffplay) return { bin: ffplay, args: ffplayRawArgs(sampleRate) };
    return null;
  }
  if (process.platform === "win32") {
    const ffplay = which("ffplay");
    if (ffplay) return { bin: ffplay, args: ffplayRawArgs(sampleRate) };
    const play = which("play");
    if (play) return { bin: play, args: soxRawArgs(sampleRate) };
    const sox = which("sox");
    if (sox) return { bin: sox, args: [...soxRawArgs(sampleRate), "-d"] };
    return null;
  }
  // Other (BSD, etc.) — best-effort sox/ffplay.
  const play = which("play");
  if (play) return { bin: play, args: soxRawArgs(sampleRate) };
  const ffplay = which("ffplay");
  if (ffplay) return { bin: ffplay, args: ffplayRawArgs(sampleRate) };
  return null;
}

/**
 * Exported view of {@link resolvePlayer} for the cross-platform preflight
 * (`voice:interactive --platform-report`). Returns the bare program name
 * (no args) the host would stream synthesized audio to, or `null`.
 */
export function resolveSystemPlayerName(sampleRate = 24_000): string | null {
  const spec = resolvePlayer(sampleRate);
  return spec ? path.basename(spec.bin) : null;
}

export interface SystemAudioSinkOptions {
  sampleRate: number;
}

/**
 * Streams synthesized PCM to a long-lived CLI player (`aplay` / `paplay` /
 * sox `play`). `write()` is non-blocking — PCM is buffered into the
 * player's stdin pipe. `drain()` is a barge-in hook: it kills the current
 * player so queued audio stops within a tick, then a fresh player is
 * spawned lazily on the next `write()`.
 */
type StdinPipeProcess = ChildProcessByStdio<Writable, null, null>;

export class SystemAudioSink implements AudioSink {
  private readonly sampleRate: number;
  private readonly playerSpec: { bin: string; args: string[] } | null;
  private proc: StdinPipeProcess | null = null;
  private buffered = 0;

  constructor(opts: SystemAudioSinkOptions) {
    this.sampleRate = opts.sampleRate;
    this.playerSpec = resolvePlayer(opts.sampleRate);
  }

  available(): boolean {
    return this.playerSpec !== null;
  }

  player(): string {
    return this.playerSpec ? path.basename(this.playerSpec.bin) : "(none)";
  }

  private ensureProc(): StdinPipeProcess | null {
    if (!this.playerSpec) return null;
    if (this.proc && !this.proc.killed && this.proc.exitCode === null)
      return this.proc;
    const child = spawn(this.playerSpec.bin, this.playerSpec.args, {
      stdio: ["pipe", "ignore", "ignore"] as const,
    });
    child.on("error", () => {
      // Player vanished mid-stream — drop it; next write retries.
      if (this.proc === child) this.proc = null;
    });
    child.on("exit", () => {
      if (this.proc === child) this.proc = null;
      this.buffered = 0;
    });
    this.proc = child;
    return child;
  }

  write(pcm: Float32Array, _sampleRate: number): void {
    const child = this.ensureProc();
    if (!child?.stdin.writable) return;
    const bytes = floatToPcm16(pcm);
    this.buffered += pcm.length;
    child.stdin.write(bytes, () => {
      this.buffered = Math.max(0, this.buffered - pcm.length);
    });
  }

  drain(): void {
    // Barge-in: stop the player immediately. The next write spawns a fresh
    // one so the new turn's audio isn't queued behind cancelled audio.
    if (this.proc) {
      try {
        this.proc.stdin.destroy();
      } catch {
        /* ignore */
      }
      try {
        this.proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
    this.buffered = 0;
  }

  bufferedSamples(): number {
    return this.buffered;
  }

  /** Flush + close the player. Idempotent. */
  async dispose(): Promise<void> {
    const child = this.proc;
    this.proc = null;
    if (!child) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      child.on("exit", finish);
      child.on("error", finish);
      try {
        child.stdin.end();
      } catch {
        finish();
      }
      // Don't hang on a stuck player.
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        finish();
      }, 1500);
    });
  }
}

export interface WavFileAudioSinkOptions {
  sampleRate: number;
  filePath: string;
}

/**
 * Accumulates all written PCM and serializes a single mono PCM16 WAV on
 * {@link finalize}. Used by `--no-audio` and as the no-player fallback so
 * a headless run still produces an inspectable artifact (never silence).
 */
export class WavFileAudioSink implements AudioSink {
  private readonly sampleRate: number;
  private readonly filePath: string;
  private readonly chunks: Float32Array[] = [];
  private buffered = 0;

  constructor(opts: WavFileAudioSinkOptions) {
    this.sampleRate = opts.sampleRate;
    this.filePath = opts.filePath;
  }

  write(pcm: Float32Array, _sampleRate: number): void {
    this.chunks.push(pcm.slice());
    this.buffered += pcm.length;
  }

  drain(): void {
    // The WAV sink keeps everything (it's an artifact, not a live stream),
    // so `drain()` only resets the "buffered" counter the scheduler reads.
    this.buffered = 0;
  }

  bufferedSamples(): number {
    return this.buffered;
  }

  totalSamples(): number {
    let n = 0;
    for (const c of this.chunks) n += c.length;
    return n;
  }

  async finalize(): Promise<string> {
    const total = this.totalSamples();
    const dataBytes = total * 2;
    const header = Buffer.allocUnsafe(44);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(36 + dataBytes, 4);
    header.write("WAVE", 8, "ascii");
    header.write("fmt ", 12, "ascii");
    header.writeUInt32LE(16, 16); // PCM fmt chunk size
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(this.sampleRate, 24);
    header.writeUInt32LE(this.sampleRate * 2, 28); // byte rate
    header.writeUInt16LE(2, 32); // block align
    header.writeUInt16LE(16, 34); // bits per sample
    header.write("data", 36, "ascii");
    header.writeUInt32LE(dataBytes, 40);
    const body = Buffer.allocUnsafe(dataBytes);
    let off = 0;
    for (const chunk of this.chunks) {
      for (let i = 0; i < chunk.length; i++) {
        let s = chunk[i];
        if (s > 1) s = 1;
        else if (s < -1) s = -1;
        body.writeInt16LE((s * 0x7fff) | 0, off);
        off += 2;
      }
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, Buffer.concat([header, body]));
    return this.filePath;
  }
}
