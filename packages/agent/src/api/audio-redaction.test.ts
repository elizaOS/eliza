/**
 * Covers the audio-PII redaction executor + variant store (#14807) on the
 * always-available pure-TS PCM16 WAV lane, against a real temp-dir media
 * store (no mocks):
 *
 *  - strict WAV parsing (extra chunks, non-PCM rejection),
 *  - mute/bleep sample rewriting with byte-exact duration preservation,
 *  - bit-determinism ⇒ content-addressed idempotency (same input sha + spans
 *    + ruleset ⇒ same output sha, memo present or wiped),
 *  - typed observable failures (no spans, malformed spans, lossy container
 *    on a host with no ffmpeg — simulated by really emptying PATH, not by
 *    mocking the module under test),
 *  - the redacted variant living as a SECOND object in the SAME
 *    content-addressed store, keyed off the original's sha,
 *  - the deterministic energy-fixture verifier catching a deliberately
 *    broken redaction (span omitted ⇒ verify FAILS) and passing a real one.
 */

import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyAudioRedaction } from "@elizaos/shared/audio-redaction-verify";
import type { TranscriptWord } from "@elizaos/shared/transcripts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let stateDir: string;

beforeAll(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-redaction-test-"));
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterAll(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

// Imported after env is set so resolveStateDir resolves to the temp dir.
const {
  parseWavPcm16,
  redactWavPcm16,
  redactAudioBytes,
  resolveFfmpegPath,
  resolveFfprobePath,
  durationToleranceMs,
  assertDurationPreserved,
} = await import("./audio-redaction.ts");
const {
  audioRedactionKey,
  findRedactedAudioVariant,
  persistRedactedAudioVariant,
} = await import("./audio-redaction-store.ts");
const { energyFixtureTranscriber } = await import(
  "./audio-redaction-verify.ts"
);
const { persistMediaBytes, readStoredMediaBytes } = await import(
  "./media-store.ts"
);

const SAMPLE_RATE = 16_000;

/** Synthesize a PCM16 WAV of a steady sine — a real, parseable audio file. */
function makeWav(
  durationMs: number,
  channels = 1,
  freqHz = 440,
  amplitude = 0.5,
): Buffer {
  const frames = Math.round((durationMs / 1000) * SAMPLE_RATE);
  const dataBytes = frames * channels * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    const value = Math.round(
      amplitude *
        32767 *
        Math.sin((2 * Math.PI * freqHz * frame) / SAMPLE_RATE),
    );
    for (let channel = 0; channel < channels; channel += 1) {
      buffer.writeInt16LE(value, 44 + (frame * channels + channel) * 2);
    }
  }
  return buffer;
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Peak |sample| (fraction of full scale) of channel 0 in a ms window. */
function windowPeak(wav: Buffer, startMs: number, endMs: number): number {
  const info = parseWavPcm16(wav);
  const startFrame = Math.floor((startMs / 1000) * info.sampleRate);
  const endFrame = Math.min(
    info.frameCount,
    Math.ceil((endMs / 1000) * info.sampleRate),
  );
  let peak = 0;
  for (let frame = startFrame; frame < endFrame; frame += 1) {
    const value = Math.abs(
      wav.readInt16LE(info.dataOffset + frame * 2 * info.channels),
    );
    if (value > peak) peak = value;
  }
  return peak / 32768;
}

describe("parseWavPcm16", () => {
  it("parses geometry of a canonical PCM16 file", () => {
    const info = parseWavPcm16(makeWav(2000));
    expect(info.sampleRate).toBe(SAMPLE_RATE);
    expect(info.channels).toBe(1);
    expect(info.frameCount).toBe(32_000);
    expect(info.durationMs).toBeCloseTo(2000, 6);
  });

  it("walks past extra chunks before data", () => {
    const base = makeWav(100);
    const list = Buffer.alloc(8 + 4);
    list.write("LIST", 0, "ascii");
    list.writeUInt32LE(4, 4);
    list.write("INFO", 8, "ascii");
    const withList = Buffer.concat([
      base.subarray(0, 36),
      list,
      base.subarray(36),
    ]);
    withList.writeUInt32LE(withList.length - 8, 4);
    expect(parseWavPcm16(withList).frameCount).toBe(1600);
  });

  it("rejects non-RIFF and non-PCM16 input with typed errors", () => {
    expect(() =>
      parseWavPcm16(Buffer.from("not audio at all........")),
    ).toThrow(/audio redaction input invalid/);
    const floatWav = makeWav(100);
    floatWav.writeUInt16LE(3, 20); // IEEE float format tag
    expect(() => parseWavPcm16(floatWav)).toThrow(/format tag 3/);
  });
});

describe("redactWavPcm16", () => {
  const spans = [{ startMs: 500, endMs: 1000 }];

  it("mutes exactly the window, preserving geometry and outside samples", () => {
    const input = makeWav(2000);
    const output = redactWavPcm16(input, spans, "mute");
    expect(output.length).toBe(input.length);
    expect(parseWavPcm16(output).durationMs).toBe(
      parseWavPcm16(input).durationMs,
    );
    expect(windowPeak(output, 510, 990)).toBe(0); // true digital silence
    expect(windowPeak(output, 0, 490)).toBeGreaterThan(0.4); // untouched
    expect(windowPeak(output, 1010, 2000)).toBeGreaterThan(0.4);
    // Bytes outside the window are IDENTICAL, not just similar.
    expect(output.subarray(0, 44 + 7900 * 2)).toEqual(
      input.subarray(0, 44 + 7900 * 2),
    );
  });

  it("bleeps the window with a tone and writes every channel", () => {
    const input = makeWav(2000, 2);
    const output = redactWavPcm16(input, spans, "bleep");
    expect(output.length).toBe(input.length);
    const info = parseWavPcm16(output);
    // Window carries the tone on both channels at the bleep amplitude.
    let peakLeft = 0;
    let peakRight = 0;
    for (let frame = 8320; frame < 15_680; frame += 1) {
      const offset = info.dataOffset + frame * 4;
      peakLeft = Math.max(peakLeft, Math.abs(output.readInt16LE(offset)));
      peakRight = Math.max(peakRight, Math.abs(output.readInt16LE(offset + 2)));
    }
    expect(peakLeft / 32768).toBeCloseTo(0.25, 1);
    expect(peakRight / 32768).toBeCloseTo(0.25, 1);
  });

  it("clamps spans that overhang the end of the file", () => {
    const input = makeWav(1000);
    const output = redactWavPcm16(
      input,
      [{ startMs: 900, endMs: 5000 }],
      "mute",
    );
    expect(output.length).toBe(input.length);
    expect(windowPeak(output, 910, 1000)).toBe(0);
  });
});

describe("redactAudioBytes (pure-TS WAV lane)", () => {
  it("redacts deterministically with duration preserved exactly", async () => {
    const input = makeWav(3000);
    const first = await redactAudioBytes({
      bytes: input,
      containerExt: "wav",
      spans: [{ startMs: 1000, endMs: 1500 }],
      mode: "mute",
    });
    expect(first.lane).toBe("pure-ts-wav");
    expect(first.outputDurationMs).toBe(first.inputDurationMs);
    const second = await redactAudioBytes({
      bytes: input,
      containerExt: "wav",
      spans: [{ startMs: 1000, endMs: 1500 }],
      mode: "mute",
    });
    expect(sha256(second.bytes)).toBe(sha256(first.bytes));
    // The redacted variant is a DIFFERENT object than the original.
    expect(sha256(first.bytes)).not.toBe(sha256(input));
  });

  it("throws typed on empty or malformed span lists", async () => {
    const input = makeWav(1000);
    await expect(
      redactAudioBytes({
        bytes: input,
        containerExt: "wav",
        spans: [],
        mode: "mute",
      }),
    ).rejects.toThrow(/no redaction spans/);
    await expect(
      redactAudioBytes({
        bytes: input,
        containerExt: "wav",
        spans: [{ startMs: 500, endMs: 500 }],
        mode: "mute",
      }),
    ).rejects.toThrow(/malformed span/);
  });

  it("fails typed (not silently) for lossy containers when the host has no ffmpeg", async () => {
    const savedPath = process.env.PATH;
    const savedOverride = process.env.ELIZA_FFMPEG_PATH;
    try {
      process.env.PATH = "";
      delete process.env.ELIZA_FFMPEG_PATH;
      resolveFfmpegPath(true);
      resolveFfprobePath(true);
      await expect(
        redactAudioBytes({
          bytes: Buffer.from("OggS fake"),
          containerExt: "ogg",
          spans: [{ startMs: 0, endMs: 100 }],
          mode: "mute",
        }),
      ).rejects.toThrow(/needs ffmpeg and this host has none/);
    } finally {
      process.env.PATH = savedPath;
      if (savedOverride !== undefined) {
        process.env.ELIZA_FFMPEG_PATH = savedOverride;
      }
      resolveFfmpegPath(true);
      resolveFfprobePath(true);
    }
  });
});

describe("duration preservation contract", () => {
  it("gives frame-padded containers one encoder frame of slack, others ~none", () => {
    expect(durationToleranceMs("wav", 16_000)).toBe(2);
    expect(durationToleranceMs("ogg", 16_000)).toBe(2);
    expect(durationToleranceMs("m4a", 16_000)).toBe(66);
    expect(() =>
      assertDurationPreserved(4000, 4032, "m4a", 16_000),
    ).not.toThrow();
    expect(() => assertDurationPreserved(4000, 4032, "ogg", 16_000)).toThrow(
      /transcript anchors would be invalid/,
    );
  });
});

describe("content-addressed redacted variant store", () => {
  const spans = [{ startMs: 500, endMs: 1000 }];
  const rulesetVersion = "2026-07-01";

  it("stores the variant as a second object keyed off the original sha and is idempotent", async () => {
    const original = makeWav(2000);
    const stored = persistMediaBytes(original, "audio/wav");

    const before = findRedactedAudioVariant({
      originalSha: stored.hash,
      spans,
      mode: "mute",
      rulesetVersion,
    });
    expect(before).toBeNull();

    const first = await persistRedactedAudioVariant({
      originalFileName: stored.fileName,
      spans,
      mode: "mute",
      rulesetVersion,
    });
    expect(first.reused).toBe(false);
    expect(first.fileName.endsWith(".wav")).toBe(true);
    expect(first.hash).not.toBe(stored.hash);
    expect(first.url).toBe(`/api/media/${first.fileName}`);

    // Both objects live side by side in the ONE store; the original bytes
    // are untouched and the variant hashes back to its own name.
    const originalBytes = readStoredMediaBytes(stored.fileName);
    const variantBytes = readStoredMediaBytes(first.fileName);
    expect(originalBytes && sha256(originalBytes)).toBe(stored.hash);
    expect(variantBytes && sha256(variantBytes)).toBe(first.hash);

    // Re-run: memo hit, no recompute, same variant.
    const second = await persistRedactedAudioVariant({
      originalFileName: stored.fileName,
      spans,
      mode: "mute",
      rulesetVersion,
    });
    expect(second.reused).toBe(true);
    expect(second.hash).toBe(first.hash);

    // Idempotency survives losing the memo: wipe it and recompute — the
    // deterministic op converges on the IDENTICAL output sha.
    fs.rmSync(path.join(stateDir, "media", "audio-redactions.json"));
    const third = await persistRedactedAudioVariant({
      originalFileName: stored.fileName,
      spans,
      mode: "mute",
      rulesetVersion,
    });
    expect(third.reused).toBe(false);
    expect(third.hash).toBe(first.hash);
  });

  it("keys strictly on original sha + spans + mode + ruleset version", async () => {
    const original = makeWav(1500);
    const stored = persistMediaBytes(original, "audio/wav");
    const variant = await persistRedactedAudioVariant({
      originalFileName: stored.fileName,
      spans,
      mode: "mute",
      rulesetVersion,
    });
    const baseKey = { originalSha: stored.hash, spans, mode: "mute" as const };
    expect(findRedactedAudioVariant({ ...baseKey, rulesetVersion })?.hash).toBe(
      variant.hash,
    );
    expect(
      findRedactedAudioVariant({ ...baseKey, rulesetVersion: "2026-08-01" }),
    ).toBeNull();
    expect(
      findRedactedAudioVariant({
        ...baseKey,
        mode: "bleep",
        rulesetVersion,
      }),
    ).toBeNull();
    expect(audioRedactionKey({ ...baseKey, rulesetVersion })).not.toBe(
      audioRedactionKey({
        ...baseKey,
        spans: [{ startMs: 500, endMs: 1001 }],
        rulesetVersion,
      }),
    );
  });

  it("throws when the original is not in the store", async () => {
    await expect(
      persistRedactedAudioVariant({
        originalFileName: `${"0".repeat(64)}.wav`,
        spans,
        mode: "mute",
        rulesetVersion,
      }),
    ).rejects.toThrow(/not in the store/);
  });
});

describe("energy-fixture verifier (deterministic, real bytes)", () => {
  // Three "words": tone bursts with silent gaps, like real speech pauses.
  const words: TranscriptWord[] = [
    { text: "keep-one", startMs: 100, endMs: 600 },
    { text: "secret", startMs: 800, endMs: 1300 },
    { text: "keep-two", startMs: 1500, endMs: 2000 },
  ];

  function makeSpeechLikeWav(): Buffer {
    const wav = makeWav(2200, 1, 440, 0);
    const info = parseWavPcm16(wav);
    for (const word of words) {
      const start = Math.floor((word.startMs / 1000) * info.sampleRate);
      const end = Math.ceil((word.endMs / 1000) * info.sampleRate);
      for (let frame = start; frame < end; frame += 1) {
        wav.writeInt16LE(
          Math.round(
            0.5 * 32767 * Math.sin((2 * Math.PI * 440 * frame) / 16_000),
          ),
          info.dataOffset + frame * 2,
        );
      }
    }
    return wav;
  }

  const expectation = {
    piiTexts: ["secret"],
    sentinelTexts: ["keep-one", "keep-two"],
  };

  it("passes a correct mute and a correct bleep", async () => {
    const original = makeSpeechLikeWav();
    for (const mode of ["mute", "bleep"] as const) {
      const redacted = redactWavPcm16(
        original,
        [{ startMs: 700, endMs: 1400 }],
        mode,
      );
      const result = await verifyAudioRedaction(
        [energyFixtureTranscriber(words)],
        { audio: redacted, mimeType: "audio/wav" },
        expectation,
      );
      expect(result.ok).toBe(true);
      expect(result.findings[0].transcript).toBe("keep-one keep-two");
    }
  });

  it("FAILS a deliberately broken run where the PII span was omitted", async () => {
    const original = makeSpeechLikeWav();
    // "Broken" redaction: muted an unrelated window, left the secret audible.
    const broken = redactWavPcm16(
      original,
      [{ startMs: 0, endMs: 90 }],
      "mute",
    );
    const result = await verifyAudioRedaction(
      [energyFixtureTranscriber(words)],
      { audio: broken, mimeType: "audio/wav" },
      expectation,
    );
    expect(result.ok).toBe(false);
    expect(result.findings[0].piiFound).toEqual(["secret"]);
  });

  it("FAILS an over-mute that silenced a sentinel", async () => {
    const original = makeSpeechLikeWav();
    const overMuted = redactWavPcm16(
      original,
      [{ startMs: 0, endMs: 1400 }], // took keep-one down with the secret
      "mute",
    );
    const result = await verifyAudioRedaction(
      [energyFixtureTranscriber(words)],
      { audio: overMuted, mimeType: "audio/wav" },
      expectation,
    );
    expect(result.ok).toBe(false);
    expect(result.findings[0].sentinelsMissing).toEqual(["keep-one"]);
  });
});
