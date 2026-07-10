/**
 * Audio PII redaction — re-transcribe verifier contract (#14807).
 *
 * Deliberately SEPARATE from the span producer (`audio-redaction.ts`): the
 * verifier must be able to run on a DIFFERENT ASR backend than the one that
 * produced the word spans, so a model that missed a PII token in span
 * production cannot "verify" the redacted audio with the same blind spot
 * (acceptance note on #14807). The provider contract is intentionally
 * minimal — normalized transcript text in, no timestamps required — so
 * self-hosted OpenAI-compatible STT endpoints (faster-whisper, FunASR,
 * SenseVoice) plug in as independent verifiers next to the local
 * `ModelType.TRANSCRIPTION` handler.
 *
 * Judgment semantics (pure, unit-testable here):
 *  - **PII absence** is separator-insensitive containment over normalized
 *    text (never transcript equality — Whisper-family models hallucinate
 *    filler over silence, and that is fine as long as no PII token surfaces).
 *  - **Sentinel presence** guards against over-mute: known non-PII words from
 *    the original must still be heard.
 *  - **No verifier ⇒ typed failure.** An unreachable/unregistered ASR makes
 *    the verify step FAIL ({@link AudioRedactionVerifyUnavailableError}),
 *    never a vacuous pass; a transcriber that throws mid-run fails the run.
 */

import { normalizeSpokenText } from "./audio-redaction";
import type { TranscriptWord } from "./transcripts";

/** Input to one verifier transcription call. */
export interface RedactionTranscribeInput {
  /** The redacted audio bytes to re-transcribe. */
  audio: Uint8Array;
  /** Container mime (e.g. `audio/wav`, `audio/ogg`). */
  mimeType: string;
  /** Expected-language hint for multilingual backends (BCP-47 / ISO 639-1). */
  languageHint?: string;
}

/** One verifier transcription result. Timestamps are optional by contract. */
export interface RedactionTranscript {
  text: string;
  /** Per-word spans when the backend has them — never required for verify. */
  words?: readonly TranscriptWord[];
}

/**
 * A pluggable ASR backend for the verify step. Implementations MUST throw on
 * failure (model unavailable, transport error) — returning an empty
 * transcript for "could not transcribe" would fabricate a PII-absent pass.
 */
export interface RedactionTranscriber {
  /** Stable id for logs/evidence (e.g. `"local-transcription"`). */
  readonly id: string;
  transcribe(input: RedactionTranscribeInput): Promise<RedactionTranscript>;
}

/** Thrown when the verify step has no usable transcriber — never a pass. */
export class AudioRedactionVerifyUnavailableError extends Error {
  constructor(message: string) {
    super(`audio redaction verify unavailable: ${message}`);
    this.name = "AudioRedactionVerifyUnavailableError";
  }
}

/** What the verifier asserts over the redacted transcript. */
export interface RedactionVerifyExpectation {
  /** PII surface texts that must be INAUDIBLE (absent from the transcript). */
  piiTexts: readonly string[];
  /** Non-PII words that must still be AUDIBLE (over-mute guard). */
  sentinelTexts?: readonly string[];
}

/** One verifier backend's judgment. */
export interface RedactionVerifierFinding {
  verifierId: string;
  /** The raw transcript the backend produced (evidence trail). */
  transcript: string;
  /** PII texts still present — any entry fails the verify. */
  piiFound: string[];
  /** Sentinels no longer present — any entry fails the verify (over-mute). */
  sentinelsMissing: string[];
  ok: boolean;
}

/** Aggregated verify outcome across all configured verifier backends. */
export interface RedactionVerifyResult {
  /** True only when EVERY configured verifier found no PII + all sentinels. */
  ok: boolean;
  findings: RedactionVerifierFinding[];
}

/**
 * PII texts still detectable in a transcript, by separator-insensitive
 * normalized containment ("555 0123" is found in "…is 5550123."). Exact-token
 * and fuzzed-separator hits are the same check by construction.
 */
export function findResidualPii(
  transcript: string,
  piiTexts: readonly string[],
): string[] {
  const haystack = normalizeSpokenText(transcript);
  const found: string[] = [];
  for (const pii of piiTexts) {
    const needle = normalizeSpokenText(pii);
    if (needle.length > 0 && haystack.includes(needle)) found.push(pii);
  }
  return found;
}

/** Sentinel texts NOT present in the transcript (normalized containment). */
export function findMissingSentinels(
  transcript: string,
  sentinelTexts: readonly string[],
): string[] {
  const haystack = normalizeSpokenText(transcript);
  const missing: string[] = [];
  for (const sentinel of sentinelTexts) {
    const needle = normalizeSpokenText(sentinel);
    if (needle.length === 0 || !haystack.includes(needle)) {
      missing.push(sentinel);
    }
  }
  return missing;
}

/** Pure judgment of one transcript against the expectation. */
export function judgeRedactedTranscript(
  verifierId: string,
  transcript: string,
  expectation: RedactionVerifyExpectation,
): RedactionVerifierFinding {
  const piiFound = findResidualPii(transcript, expectation.piiTexts);
  const sentinelsMissing = findMissingSentinels(
    transcript,
    expectation.sentinelTexts ?? [],
  );
  return {
    verifierId,
    transcript,
    piiFound,
    sentinelsMissing,
    ok: piiFound.length === 0 && sentinelsMissing.length === 0,
  };
}

/**
 * Run the verifier matrix: every configured backend re-transcribes the
 * redacted audio and judges it independently; the aggregate passes only when
 * ALL pass. Zero backends throws {@link AudioRedactionVerifyUnavailableError}
 * and a backend failure (its `transcribe` throwing) propagates — the verify
 * step fails observably, it never silently passes.
 */
export async function verifyAudioRedaction(
  transcribers: readonly RedactionTranscriber[],
  input: RedactionTranscribeInput,
  expectation: RedactionVerifyExpectation,
): Promise<RedactionVerifyResult> {
  if (transcribers.length === 0) {
    throw new AudioRedactionVerifyUnavailableError(
      "no verifier transcriber configured — refusing a vacuous pass",
    );
  }
  const findings: RedactionVerifierFinding[] = [];
  for (const transcriber of transcribers) {
    const transcript = await transcriber.transcribe(input);
    findings.push(
      judgeRedactedTranscript(transcriber.id, transcript.text, expectation),
    );
  }
  return { ok: findings.every((finding) => finding.ok), findings };
}
