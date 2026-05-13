import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AudioSink } from "./types";

function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveSystemPlayerName(_sampleRate = 24_000): string | null {
  if (process.platform === "darwin") return findOnPath("afplay") ? "afplay" : null;
  return findOnPath("paplay") ? "paplay" : findOnPath("aplay") ? "aplay" : null;
}

function floatToInt16(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

function wavBytes(chunks: Float32Array[], sampleRate: number): Buffer {
  const sampleCount = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const dataBytes = sampleCount * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(dataBytes, 40);
  let offset = 44;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      out.writeInt16LE(floatToInt16(sample), offset);
      offset += 2;
    }
  }
  return out;
}

export class WavFileAudioSink implements AudioSink {
  private readonly chunks: Float32Array[] = [];
  private samples = 0;
  private sampleRate: number;

  constructor(opts: { sampleRate: number; filePath: string }) {
    this.sampleRate = opts.sampleRate;
    this.filePath = opts.filePath;
  }

  readonly filePath: string;

  write(pcm: Float32Array, sampleRate: number): void {
    this.sampleRate = sampleRate || this.sampleRate;
    this.chunks.push(new Float32Array(pcm));
    this.samples += pcm.length;
  }

  drain(): void {
    this.chunks.length = 0;
    this.samples = 0;
  }

  bufferedSamples(): number {
    return this.samples;
  }

  finalize(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, wavBytes(this.chunks, this.sampleRate));
  }
}

export class SystemAudioSink implements AudioSink {
  private readonly wav: WavFileAudioSink;

  constructor(opts: { sampleRate: number }) {
    this.wav = new WavFileAudioSink({
      sampleRate: opts.sampleRate,
      filePath: path.join(os.tmpdir(), `eliza-audio-${process.pid}-${Date.now()}.wav`),
    });
  }

  available(): boolean {
    return resolveSystemPlayerName() !== null;
  }

  write(pcm: Float32Array, sampleRate: number): void {
    this.wav.write(pcm, sampleRate);
  }

  drain(): void {
    this.wav.drain();
  }

  bufferedSamples(): number {
    return this.wav.bufferedSamples();
  }

  finalize(): void {
    this.wav.finalize();
    const player = resolveSystemPlayerName();
    if (!player) return;
    spawnSync(player, [this.wav.filePath], { stdio: "ignore" });
    fs.rmSync(this.wav.filePath, { force: true });
  }
}
