/**
 * REAL-ffmpeg integration for the audio-PII redaction lossy lane (#14807):
 * drives the actual ffmpeg/ffprobe binaries on real encoded audio (no mocks,
 * no stubs) and asserts the empirical contract from the issue:
 *
 *  - OGG/opus mute + bleep: output duration EXACT (±2 ms probe slack),
 *  - M4A/AAC mute + bleep: within ±(1024/sampleRate)s (one encoder frame),
 *  - volumedetect proves the muted window is silenced (WAV/PCM −91 dB floor;
 *    opus codec noise floor ≤ −80 dB mean) while untouched audio stays loud,
 *  - `-bitexact` determinism: the same job twice yields byte-identical
 *    output ⇒ the same content address (the store-level idempotency proof
 *    for the ffmpeg lane, memo present or wiped).
 *
 * Skips — LOUDLY, with a reason — when the host has no ffmpeg/ffprobe (CI
 * images without ffmpeg; mobile-like hosts). On such hosts the pure-TS WAV
 * lane tests (audio-redaction.test.ts) still run in full.
 */

import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let stateDir: string;
let workDir: string;

beforeAll(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-redaction-ffm-"));
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-redaction-fix-"));
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterAll(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

// Imported after env is set so resolveStateDir resolves to the temp dir.
const { audioRedactionCapability, redactAudioBytes, resolveFfmpegPath } =
  await import("./audio-redaction.ts");
const { persistRedactedAudioVariant } = await import(
  "./audio-redaction-store.ts"
);
const { persistMediaBytes } = await import("./media-store.ts");

const capability = audioRedactionCapability();
if (!capability.lossyContainers) {
  // Loud, honest skip: the lossy lane cannot be exercised without ffmpeg.
  console.warn(
    "[audio-redaction.ffmpeg.test] SKIPPING real-ffmpeg lossy-lane tests: " +
      "no ffmpeg/ffprobe on this host. The pure-TS WAV lane tests still run.",
  );
}

const SAMPLE_RATE = 16_000;
const SPANS = [
  { startMs: 1000, endMs: 2000 },
  { startMs: 2500, endMs: 3000 },
];

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Synthesize the 4 s / 16 kHz mono PCM16 sine source fixture. */
function makeSourceWav(): Buffer {
  const frames = 4 * SAMPLE_RATE;
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + frames * 2, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(frames * 2, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    buffer.writeInt16LE(
      Math.round(
        0.5 * 32767 * Math.sin((2 * Math.PI * 440 * frame) / SAMPLE_RATE),
      ),
      44 + frame * 2,
    );
  }
  return buffer;
}

/** Encode the WAV fixture to a lossy container with the real ffmpeg. */
function encodeFixture(ext: "ogg" | "m4a"): Buffer {
  const ffmpeg = resolveFfmpegPath();
  if (!ffmpeg) throw new Error("ffmpeg vanished mid-test");
  const wavPath = path.join(workDir, "src.wav");
  const outPath = path.join(workDir, `src.${ext}`);
  if (!fs.existsSync(wavPath)) fs.writeFileSync(wavPath, makeSourceWav());
  const codec = ext === "ogg" ? "libopus" : "aac";
  const result = spawnSync(
    ffmpeg,
    ["-y", "-v", "error", "-i", wavPath, "-c:a", codec, outPath],
    { windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(`fixture encode failed: ${result.stderr?.toString()}`);
  }
  return fs.readFileSync(outPath);
}

/** Real volumedetect over a window; returns mean volume in dB. */
function meanVolumeDb(
  bytes: Buffer,
  ext: string,
  startS: number,
  endS: number,
): number {
  const ffmpeg = resolveFfmpegPath();
  if (!ffmpeg) throw new Error("ffmpeg vanished mid-test");
  const filePath = path.join(
    workDir,
    `probe-${Date.now()}-${Math.random()}.${ext}`,
  );
  fs.writeFileSync(filePath, bytes);
  const result = spawnSync(
    ffmpeg,
    [
      "-v",
      "info",
      "-i",
      filePath,
      "-af",
      `atrim=${startS}:${endS},volumedetect`,
      "-f",
      "null",
      "-",
    ],
    { windowsHide: true },
  );
  fs.rmSync(filePath, { force: true });
  const match = /mean_volume:\s*(-?[\d.]+|inf|-inf)\s*dB/.exec(
    result.stderr?.toString() ?? "",
  );
  if (!match) throw new Error("volumedetect produced no mean_volume");
  return match[1] === "-inf" ? -120 : Number.parseFloat(match[1]);
}

describe.skipIf(!capability.lossyContainers)(
  "audio redaction — real ffmpeg lossy lane",
  () => {
    it("mutes ogg/opus with exact duration, real silence, and bit-determinism", async () => {
      const source = encodeFixture("ogg");
      const first = await redactAudioBytes({
        bytes: source,
        containerExt: "ogg",
        spans: SPANS,
        mode: "mute",
      });
      expect(first.lane).toBe("ffmpeg");
      expect(
        Math.abs(first.outputDurationMs - first.inputDurationMs),
      ).toBeLessThanOrEqual(2);

      // Muted window is true silence down to the opus noise floor (probed
      // inside the window, past the codec's edge decay ringing); audio outside
      // the windows is untouched and still loud.
      expect(meanVolumeDb(first.bytes, "ogg", 1.2, 1.8)).toBeLessThanOrEqual(
        -80,
      );
      expect(meanVolumeDb(first.bytes, "ogg", 0.1, 0.9)).toBeGreaterThan(-30);

      const second = await redactAudioBytes({
        bytes: source,
        containerExt: "ogg",
        spans: SPANS,
        mode: "mute",
      });
      expect(sha256(second.bytes)).toBe(sha256(first.bytes));
    });

    it("bleeps ogg/opus: tone inside the window, original outside, exact duration", async () => {
      const source = encodeFixture("ogg");
      const result = await redactAudioBytes({
        bytes: source,
        containerExt: "ogg",
        spans: SPANS,
        mode: "bleep",
      });
      expect(
        Math.abs(result.outputDurationMs - result.inputDurationMs),
      ).toBeLessThanOrEqual(2);
      // Window carries an audible tone (not silence), and the surrounding
      // original audio survives at its normal level.
      expect(meanVolumeDb(result.bytes, "ogg", 1.05, 1.95)).toBeGreaterThan(
        -40,
      );
      expect(meanVolumeDb(result.bytes, "ogg", 0.1, 0.9)).toBeGreaterThan(-30);
    });

    it("mutes m4a/aac within one encoder frame of duration and silences the window", async () => {
      const source = encodeFixture("m4a");
      const result = await redactAudioBytes({
        bytes: source,
        containerExt: "m4a",
        spans: SPANS,
        mode: "mute",
      });
      const toleranceMs = (1024 / result.sampleRate) * 1000 + 2;
      expect(
        Math.abs(result.outputDurationMs - result.inputDurationMs),
      ).toBeLessThanOrEqual(toleranceMs);
      expect(meanVolumeDb(result.bytes, "m4a", 1.05, 1.95)).toBeLessThanOrEqual(
        -85,
      );
      expect(meanVolumeDb(result.bytes, "m4a", 0.1, 0.9)).toBeGreaterThan(-30);
    });

    it("bleeps m4a/aac within one encoder frame of duration", async () => {
      const source = encodeFixture("m4a");
      const result = await redactAudioBytes({
        bytes: source,
        containerExt: "m4a",
        spans: SPANS,
        mode: "bleep",
      });
      const toleranceMs = (1024 / result.sampleRate) * 1000 + 2;
      expect(
        Math.abs(result.outputDurationMs - result.inputDurationMs),
      ).toBeLessThanOrEqual(toleranceMs);
      expect(meanVolumeDb(result.bytes, "m4a", 1.05, 1.95)).toBeGreaterThan(
        -40,
      );
    });

    it("store-level idempotency holds on the ffmpeg lane (memo present or wiped)", async () => {
      const source = encodeFixture("ogg");
      const stored = persistMediaBytes(source, "audio/ogg");
      const job = {
        originalFileName: stored.fileName,
        spans: SPANS,
        mode: "mute" as const,
        rulesetVersion: "2026-07-01",
      };
      const first = await persistRedactedAudioVariant(job);
      expect(first.reused).toBe(false);
      expect(first.fileName.endsWith(".ogg")).toBe(true);
      expect(first.hash).not.toBe(stored.hash);

      const second = await persistRedactedAudioVariant(job);
      expect(second.reused).toBe(true);
      expect(second.hash).toBe(first.hash);

      fs.rmSync(path.join(stateDir, "media", "audio-redactions.json"));
      const third = await persistRedactedAudioVariant(job);
      expect(third.reused).toBe(false);
      expect(third.hash).toBe(first.hash); // -bitexact determinism, end to end
    });
  },
);
