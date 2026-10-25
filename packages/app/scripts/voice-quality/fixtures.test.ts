import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FIXTURES, loadSentences } from "./host-wer-gate";

const repoRoot = path.resolve(import.meta.dir, "../../../..");
const qualifyJava = path.join(
  repoRoot,
  "packages/app/scripts/paradee-voice/qualify/app/src/androidTest/java/ai/eliza/voicequalify/Wer.java",
);

describe("voice-quality fixtures", () => {
  it("keeps host and device thresholds identical", () => {
    const java = readFileSync(qualifyJava, "utf8");
    expect(FIXTURES.thresholds.ttsRoundTripWer).toBe(0.08);
    expect(FIXTURES.thresholds.asrWer).toBe(0.06);
    expect(java).toContain(
      `TTS_ROUND_TRIP_MAX_WER = ${FIXTURES.thresholds.ttsRoundTripWer};`,
    );
    expect(java).toContain(`ASR_MAX_WER = ${FIXTURES.thresholds.asrWer};`);
  });

  it("pins the in-repo qualify sentences by sha256", async () => {
    const lines = await loadSentences(
      FIXTURES.tts.qualifySentences,
      "/nonexistent",
    );
    expect(lines).toHaveLength(25);
  });

  it("pins 100 distinct LibriSpeech test-clean utterances plus the speech fixture", () => {
    const { utterances } = FIXTURES.asr.librispeech;
    expect(utterances).toHaveLength(100);
    expect(new Set(utterances.map((u) => u.id)).size).toBe(100);
    for (const u of utterances) {
      expect(u.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(u.path).toBe(
        `test-clean/${u.id.split("-")[0]}/${u.id.split("-")[1]}/${u.id}.flac`,
      );
      expect(u.text).toMatch(/^[A-Z' ]+$/);
    }
    expect(FIXTURES.asr.speechFixture.librispeechId).toBe("1089-134686-0002");
    expect(FIXTURES.asr.librispeech.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("pins the remote TTS sentence sources to immutable revisions", () => {
    for (const key of ["paradeeSamples", "paradeeHeldOut"] as const) {
      const spec = FIXTURES.tts[key];
      expect(spec.url).toMatch(/\/[0-9a-f]{40}\//);
      expect(spec.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(FIXTURES.tts.paradeeHeldOut.take).toBe(200);
    // The loader rejects bytes that do not match the pin.
    const sentences = readFileSync(
      path.join(repoRoot, FIXTURES.tts.qualifySentences.path as string),
    );
    expect(createHash("sha256").update(sentences).digest("hex")).toBe(
      FIXTURES.tts.qualifySentences.sha256,
    );
  });
});
