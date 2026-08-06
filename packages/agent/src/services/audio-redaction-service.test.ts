/**
 * Exercises the registered audio-redaction service against real PCM16 bytes
 * and the real media store. The runtime ASR boundary is deterministic so the
 * suite can prove publish-after-verify and no-publish-on-leak behavior.
 */

import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let stateDir: string;

beforeAll(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-redaction-service-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  delete process.env.ELIZA_AUDIO_REDACTION_VERIFY_STT_URL;
  delete process.env.ELIZA_AUDIO_REDACTION_VERIFY_STT_MODEL;
  delete process.env.ELIZA_AUDIO_REDACTION_VERIFY_STT_API_KEY;
});

afterAll(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const { persistMediaBytes, readStoredMediaBytes } = await import(
  "../api/media-store.ts"
);
const { parseWavPcm16 } = await import("../api/audio-redaction.ts");
const { AudioRedactionService, selectAudioRedactionSentinels } = await import(
  "./audio-redaction-service.ts"
);

const SAMPLE_RATE = 16_000;

function makeWav(durationMs: number): Buffer {
  const frames = Math.round((durationMs / 1000) * SAMPLE_RATE);
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

function runtimeReturning(transcript: unknown): IAgentRuntime {
  return {
    useModel: vi.fn(async () => transcript),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
}

const WORDS = [
  { text: "meeting", startMs: 50, endMs: 350 },
  { text: "bob@example.com", startMs: 600, endMs: 1000 },
  { text: "weather", startMs: 1400, endMs: 1800 },
];

describe("AudioRedactionService", () => {
  it("selects distributed non-PII sentinels", () => {
    expect(
      selectAudioRedactionSentinels(
        [
          { text: "alpha", startMs: 0, endMs: 100 },
          { text: "secret", startMs: 200, endMs: 300 },
          { text: "middle", startMs: 400, endMs: 500 },
          { text: "omega", startMs: 800, endMs: 900 },
        ],
        [{ startMs: 150, endMs: 350 }],
      ),
    ).toEqual(["alpha", "middle", "omega"]);
  });

  it("publishes a different content address only after ASR verification", async () => {
    const original = persistMediaBytes(makeWav(2000), "audio/wav");
    const runtime = runtimeReturning("the meeting discussed weather");
    const service = new AudioRedactionService(runtime);
    const result = await service.redactAndVerify({
      originalAudioUrl: original.url,
      durationMs: 2000,
      words: WORDS,
      piiSpans: [{ text: "bob@example.com", label: "EMAIL" }],
    });

    expect(result.hash).not.toBe(original.hash);
    expect(result.url).not.toBe(original.url);
    expect(result.verifierIds).toEqual(["runtime-transcription"]);
    expect(result.sentinelTexts).toEqual(["meeting", "weather"]);
    const redacted = readStoredMediaBytes(result.url.split("/").pop() ?? "");
    expect(redacted).not.toBeNull();
    const info = parseWavPcm16(redacted as Buffer);
    const from = info.dataOffset + Math.floor(0.6 * SAMPLE_RATE) * 2;
    const to = info.dataOffset + Math.ceil(1.0 * SAMPLE_RATE) * 2;
    expect(
      (redacted as Buffer).subarray(from, to).every((byte) => byte === 0),
    ).toBe(true);
  });

  it("does not publish candidate bytes when the verifier still hears PII", async () => {
    const original = persistMediaBytes(makeWav(2100), "audio/wav");
    const mediaDir = path.join(stateDir, "media");
    const before = new Set(fs.readdirSync(mediaDir));
    const runtime = runtimeReturning("bob@example.com and weather");
    const service = new AudioRedactionService(runtime);

    await expect(
      service.redactAndVerify({
        originalAudioUrl: original.url,
        durationMs: 2100,
        words: WORDS,
        piiSpans: [{ text: "bob@example.com", label: "EMAIL" }],
        rulesetVersion: "failed-verifier-fixture",
      }),
    ).rejects.toThrow(/mandatory re-transcription verification/);
    expect(new Set(fs.readdirSync(mediaDir))).toEqual(before);
    expect(runtime.reportError).toHaveBeenCalled();
  });

  it("rejects unlocatable PII and malformed model output", async () => {
    const original = persistMediaBytes(makeWav(2200), "audio/wav");
    const service = new AudioRedactionService(runtimeReturning("weather"));
    await expect(
      service.redactAndVerify({
        originalAudioUrl: original.url,
        durationMs: 2200,
        words: WORDS,
        piiSpans: [{ text: "not in timed words" }],
      }),
    ).rejects.toThrow(/could not be located/);

    const malformed = new AudioRedactionService(runtimeReturning({ ok: true }));
    await expect(
      malformed.redactAndVerify({
        originalAudioUrl: original.url,
        durationMs: 2200,
        words: WORDS,
        piiSpans: [{ text: "bob@example.com" }],
        rulesetVersion: "malformed-model-fixture",
      }),
    ).rejects.toThrow(/no usable string transcript/);
  });
});
