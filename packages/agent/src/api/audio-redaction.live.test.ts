/**
 * LIVE end-to-end for the audio-PII redaction pipeline (#14807) against real
 * network services — real TTS speech, real timed ASR, real redaction, real
 * re-transcribe-verify. No mocks anywhere:
 *
 *   1. A speech fixture with PLANTED PII ("John Smith", a phone number) and
 *      sentinel words ("meeting", "weather", "sunny") is synthesized by a
 *      live Kokoro-style TTS endpoint (`ELIZA_PII_AUDIO_TTS_URL`).
 *   2. Word timestamps come from a live OpenAI-compatible STT endpoint
 *      (`ELIZA_PII_AUDIO_STT_URL`, `timestamp_granularities=word`) — a REAL
 *      timed-ASR span producer, and deliberately a DIFFERENT backend family
 *      than the fused eliza ASR, exercising the raw-word-span input design.
 *   3. Text-PII verdicts map onto word spans → padded merged windows → the
 *      pure-TS WAV mute/bleep executor (duration preserved exactly).
 *   4. The redacted audio is RE-TRANSCRIBED through the verifier contract
 *      (`openAiCompatSttTranscriber` — the independent-verifier lane from the
 *      #14807 acceptance note): every PII token must be gone, every sentinel
 *      still present.
 *   5. A deliberately BROKEN run (phone-number span omitted) must FAIL the
 *      verify — proving the verifier actually hears residual PII.
 *
 * Lane: `*.live.test.ts` — excluded from the default vitest lane; runs where
 * the operator provides live endpoints:
 *
 *   ELIZA_PII_AUDIO_TTS_URL=https://<kokoro-host> \
 *   ELIZA_PII_AUDIO_STT_URL=https://<whisper-host> \
 *   ELIZA_PII_AUDIO_STT_MODEL=Systran/faster-whisper-tiny.en \
 *   bunx vitest run src/api/audio-redaction.live.test.ts --config ./vitest.config.ts
 */

import { Buffer } from "node:buffer";
import { buildAudioRedactionSpans } from "@elizaos/shared/audio-redaction";
import { verifyAudioRedaction } from "@elizaos/shared/audio-redaction-verify";
import type { TranscriptWord } from "@elizaos/shared/transcripts";
import { describe, expect, it } from "vitest";
import { parseWavPcm16, redactAudioBytes } from "./audio-redaction.ts";
import { openAiCompatSttTranscriber } from "./audio-redaction-verify.ts";

const TTS_URL = process.env.ELIZA_PII_AUDIO_TTS_URL?.trim();
const STT_URL = process.env.ELIZA_PII_AUDIO_STT_URL?.trim();
const STT_MODEL =
  process.env.ELIZA_PII_AUDIO_STT_MODEL?.trim() ||
  "Systran/faster-whisper-tiny.en";

if (!TTS_URL || !STT_URL) {
  console.warn(
    "[audio-redaction.live.test] SKIPPING live pipeline: set " +
      "ELIZA_PII_AUDIO_TTS_URL and ELIZA_PII_AUDIO_STT_URL to run it.",
  );
}

const FIXTURE_TEXT =
  "This is a team meeting recording. My name is John Smith and my phone " +
  "number is five five five zero one two three. The weather today is sunny " +
  "and the project deadline is Friday.";

const PII_NAME = "John Smith";
const PII_PHONE = "5550123";
const SENTINELS = ["meeting", "weather", "sunny", "deadline"];

async function synthesizeFixture(): Promise<Buffer> {
  const response = await fetch(`${TTS_URL}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: FIXTURE_TEXT, voice: "af_heart", speed: 1.0 }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`live TTS answered ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Span-producer path: LIVE word timestamps (verifier never needs these). */
async function transcribeTimed(
  audio: Buffer,
): Promise<{ text: string; words: TranscriptWord[] }> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(audio)], { type: "audio/wav" }),
    "fixture.wav",
  );
  form.append("model", STT_MODEL);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  const response = await fetch(`${STT_URL}/v1/audio/transcriptions`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) {
    throw new Error(`live timed STT answered ${response.status}`);
  }
  const body = (await response.json()) as {
    text?: string;
    words?: Array<{ word: string; start: number; end: number }>;
  };
  if (typeof body.text !== "string" || !Array.isArray(body.words)) {
    throw new Error("live timed STT returned no word timestamps");
  }
  return {
    text: body.text,
    words: body.words.map((word) => ({
      text: word.word,
      startMs: word.start * 1000,
      endMs: word.end * 1000,
    })),
  };
}

describe.skipIf(!TTS_URL || !STT_URL)(
  "audio redaction — LIVE TTS → timed ASR → redact → re-transcribe verify",
  () => {
    it("renders planted PII inaudible (mute + bleep) and FAILS a broken run", {
      timeout: 600_000,
    }, async () => {
      // 1. Real speech with planted PII.
      const fixture = await synthesizeFixture();
      const durationMs = parseWavPcm16(fixture).durationMs;
      expect(durationMs).toBeGreaterThan(5000);

      // 2. Real timed ASR word spans; the transcript must contain the PII
      //    (otherwise the fixture is not exercising anything).
      const timed = await transcribeTimed(fixture);
      expect(timed.words.length).toBeGreaterThan(10);
      const verifier = openAiCompatSttTranscriber({
        baseUrl: STT_URL as string,
        model: STT_MODEL,
      });
      const preCheck = await verifyAudioRedaction(
        [verifier],
        { audio: fixture, mimeType: "audio/wav" },
        { piiTexts: [PII_NAME, PII_PHONE], sentinelTexts: SENTINELS },
      );
      expect(preCheck.ok).toBe(false); // PII is audible BEFORE redaction
      expect(preCheck.findings[0].piiFound.length).toBeGreaterThan(0);

      // 3. Text-PII verdicts → padded merged windows.
      const plan = buildAudioRedactionSpans(
        timed.words,
        [
          { text: PII_NAME, label: "PERSON_1" },
          { text: PII_PHONE, label: "PHONE_1" },
        ],
        { durationMs, padMs: 250 },
      );
      expect(plan.unmatched).toEqual([]);
      expect(plan.spans.length).toBeGreaterThan(0);

      // 4. Mute AND bleep, duration preserved exactly, verified by a real
      //    re-transcription: PII gone, sentinels intact.
      for (const mode of ["mute", "bleep"] as const) {
        const redacted = await redactAudioBytes({
          bytes: fixture,
          containerExt: "wav",
          spans: plan.spans,
          mode,
        });
        expect(redacted.outputDurationMs).toBe(redacted.inputDurationMs);
        const verdict = await verifyAudioRedaction(
          [verifier],
          { audio: redacted.bytes, mimeType: "audio/wav" },
          { piiTexts: [PII_NAME, PII_PHONE], sentinelTexts: SENTINELS },
        );
        expect(verdict.findings[0].piiFound).toEqual([]);
        expect(verdict.findings[0].sentinelsMissing).toEqual([]);
        expect(verdict.ok).toBe(true);
      }

      // 5. Deliberately broken run: leave the phone number audible — the
      //    verifier MUST catch it.
      const nameOnly = buildAudioRedactionSpans(
        timed.words,
        [{ text: PII_NAME, label: "PERSON_1" }],
        { durationMs, padMs: 250 },
      );
      const broken = await redactAudioBytes({
        bytes: fixture,
        containerExt: "wav",
        spans: nameOnly.spans,
        mode: "mute",
      });
      const brokenVerdict = await verifyAudioRedaction(
        [verifier],
        { audio: broken.bytes, mimeType: "audio/wav" },
        { piiTexts: [PII_NAME, PII_PHONE], sentinelTexts: SENTINELS },
      );
      expect(brokenVerdict.ok).toBe(false);
      expect(brokenVerdict.findings[0].piiFound).toEqual([PII_PHONE]);
    });
  },
);
