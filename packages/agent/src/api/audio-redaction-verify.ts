/**
 * Audio PII redaction — verifier transcriber adapters (#14807).
 *
 * The verifier CONTRACT (and the pure PII-absence / sentinel-presence
 * judgment) lives in `@elizaos/shared/audio-redaction-verify`, deliberately
 * separable from the span producer so verification can run on a different
 * ASR backend. This module supplies the concrete backends the agent host can
 * offer:
 *
 *  - {@link runtimeTranscriptionTranscriber} — the registered
 *    `ModelType.TRANSCRIPTION` handler (local fused eliza-1-asr, or whichever
 *    provider won registration). A missing handler THROWS through
 *    `useModel`, so the verify step fails, never passes vacuously.
 *  - {@link openAiCompatSttTranscriber} — any self-hosted OpenAI-compatible
 *    `/v1/audio/transcriptions` endpoint (faster-whisper, FunASR, SenseVoice,
 *    the voice-whisper-stt cloud sibling). This is the independent-verifier
 *    lane from the #14807 acceptance note.
 *  - {@link energyFixtureTranscriber} — a deterministic, model-free stand-in
 *    for environments with no reachable ASR: it "transcribes" a PCM16 WAV by
 *    measuring real signal energy in each expected word's window (RMS floor
 *    for mute, 1 kHz Goertzel dominance for bleep) and emitting only words
 *    whose original audio is still audible. It grounds the verify in the
 *    actual redacted bytes, but it is a FIXTURE verifier — it needs the
 *    expected word list and never replaces a real ASR pass in evidence.
 */

import { Buffer } from "node:buffer";
import {
  ElizaError,
  fetchWithSsrfGuard,
  type IAgentRuntime,
  ModelType,
  toWellFormedUnicode,
  truncateWellFormed,
} from "@elizaos/core";
import type {
  RedactionTranscribeInput,
  RedactionTranscriber,
  RedactionTranscript,
} from "@elizaos/shared/audio-redaction-verify";
import type { TranscriptWord } from "@elizaos/shared/transcripts";
import { BLEEP_FREQUENCY_HZ, parseWavPcm16 } from "./audio-redaction.ts";

// ---------------------------------------------------------------------------
// Runtime TRANSCRIPTION adapter
// ---------------------------------------------------------------------------

/**
 * Verify through the runtime's registered TRANSCRIPTION model (interim
 * purpose — a verify pass is pipeline-internal, never a billable user
 * transcription). `useModel` throws when no handler is registered or the
 * handler fails (`AsrUnavailableError`), which is exactly the fail-closed
 * behavior the verify step requires.
 */
export function runtimeTranscriptionTranscriber(
  runtime: IAgentRuntime,
): RedactionTranscriber {
  return {
    id: "runtime-transcription",
    async transcribe(
      input: RedactionTranscribeInput,
    ): Promise<RedactionTranscript> {
      const text = await runtime.useModel(ModelType.TRANSCRIPTION, {
        audioUrl: "",
        audio: input.audio,
        mimeType: input.mimeType,
        transcriptionPurpose: "interim",
      });
      if (typeof text !== "string" || !text.trim()) {
        throw new ElizaError(
          "runtime transcription verifier returned no usable string transcript",
          { code: "AUDIO_REDACTION_VERIFY_EMPTY_TRANSCRIPT" },
        );
      }
      return { text };
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible STT adapter (independent verifier lane)
// ---------------------------------------------------------------------------

/** Config for an OpenAI-compatible `/v1/audio/transcriptions` verifier. */
export interface OpenAiCompatSttOptions {
  /** Endpoint base, e.g. `https://stt.internal` (no trailing path). */
  baseUrl: string;
  /** Backend model id (e.g. `Systran/faster-whisper-small`). */
  model: string;
  apiKey?: string;
  /** Request timeout; defaults to 120 s (CPU STT on long clips is slow). */
  timeoutMs?: number;
  /** Deterministic transport seam; production uses the pinned Node transport. */
  fetchImpl?: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
}

/**
 * Verifier backend over any self-hosted OpenAI-compatible STT server —
 * multipart `file` + `model` to `/v1/audio/transcriptions`, `{text}` back.
 * Errors (non-2xx, timeout, malformed body) THROW so the verify step fails
 * observably.
 */
export function openAiCompatSttTranscriber(
  options: OpenAiCompatSttOptions,
): RedactionTranscriber {
  let endpoint: URL;
  try {
    endpoint = new URL(
      "/v1/audio/transcriptions",
      `${options.baseUrl.replace(/\/+$/, "")}/`,
    );
  } catch (error) {
    // error-policy:J2 Preserve invalid URL construction as typed config context.
    throw new ElizaError("STT verifier base URL is invalid", {
      code: "AUDIO_REDACTION_VERIFY_CONFIG_INVALID",
      cause: error,
    });
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new ElizaError("STT verifier URL must use http or https", {
      code: "AUDIO_REDACTION_VERIFY_CONFIG_INVALID",
    });
  }
  return {
    id: `openai-compat-stt:${endpoint.host}`,
    async transcribe(
      input: RedactionTranscribeInput,
    ): Promise<RedactionTranscript> {
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(input.audio)], { type: input.mimeType }),
        "audio",
      );
      form.append("model", options.model);
      form.append("response_format", "json");
      if (input.languageHint) form.append("language", input.languageHint);
      let guarded: Awaited<ReturnType<typeof fetchWithSsrfGuard>>;
      try {
        guarded = await fetchWithSsrfGuard({
          url: endpoint.toString(),
          fetchImpl: options.fetchImpl,
          timeoutMs: options.timeoutMs ?? 120_000,
          // Audio and bearer credentials must never cross an origin boundary.
          // A redirect is therefore a typed failure, not an automatic replay.
          maxRedirects: 0,
          init: {
            method: "POST",
            body: form,
            headers: options.apiKey
              ? { Authorization: `Bearer ${options.apiKey}` }
              : {},
          },
        });
      } catch (error) {
        // error-policy:J2 Preserve guarded transport/SSRF failure context.
        throw new ElizaError("STT verifier request failed", {
          code: "AUDIO_REDACTION_VERIFY_REQUEST_FAILED",
          cause: error,
          context: { host: endpoint.host },
        });
      }
      const { response, release } = guarded;
      try {
        const textBody = await readResponseTextLimited(response, 1024 * 1024);
        if (!response.ok) {
          throw new ElizaError(
            `STT verifier answered HTTP ${response.status}: ${truncateWellFormed(toWellFormedUnicode(textBody), 300)}`,
            {
              code: "AUDIO_REDACTION_VERIFY_REQUEST_FAILED",
              context: { host: endpoint.host, status: response.status },
            },
          );
        }
        let body: unknown;
        try {
          body = JSON.parse(textBody);
        } catch (error) {
          // error-policy:J2 Malformed provider JSON is a typed failed verify.
          throw new ElizaError("STT verifier returned malformed JSON", {
            code: "AUDIO_REDACTION_VERIFY_RESPONSE_INVALID",
            cause: error,
          });
        }
        const text = (body as { text?: unknown }).text;
        if (typeof text !== "string" || !text.trim()) {
          throw new ElizaError("STT verifier returned no transcript text", {
            code: "AUDIO_REDACTION_VERIFY_EMPTY_TRANSCRIPT",
          });
        }
        return { text };
      } finally {
        await release();
      }
    },
  };
}

async function readResponseTextLimited(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      total += chunk.length;
      if (total > maxBytes) {
        try {
          await reader.cancel("STT verifier response exceeded byte limit");
        } catch (error) {
          // error-policy:J2 Preserve cancellation failure on the bounded reader.
          throw new ElizaError("STT verifier response exceeded byte limit", {
            code: "AUDIO_REDACTION_VERIFY_RESPONSE_INVALID",
            cause: error,
          });
        }
        throw new ElizaError("STT verifier response exceeded byte limit", {
          code: "AUDIO_REDACTION_VERIFY_RESPONSE_INVALID",
        });
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } catch (error) {
    if (error instanceof ElizaError) throw error;
    // error-policy:J2 Preserve streamed response read failures.
    throw new ElizaError("STT verifier response stream failed", {
      code: "AUDIO_REDACTION_VERIFY_RESPONSE_INVALID",
      cause: error,
    });
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Deterministic energy-fixture verifier (no-ASR environments)
// ---------------------------------------------------------------------------

/** A word window is "silenced" below this RMS fraction of full scale (~−52 dB). */
const SILENCE_RMS_FLOOR = 0.0025;
/** A word window is "bleeped" when ≥ this fraction of its energy is the tone. */
const TONE_DOMINANCE_FLOOR = 0.8;

/** Goertzel power of one frequency over a PCM16 window, plus total power. */
function windowPowers(
  samples: Int16Array,
  sampleRate: number,
  frequencyHz: number,
): { tonePower: number; totalPower: number } {
  const n = samples.length;
  if (n === 0) return { tonePower: 0, totalPower: 0 };
  const k = Math.round((n * frequencyHz) / sampleRate);
  const omega = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(omega);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let totalPower = 0;
  for (let i = 0; i < n; i += 1) {
    const x = samples[i] / 32768;
    totalPower += x * x;
    s0 = x + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const tonePower =
    (s1 * s1 + s2 * s2 - coeff * s1 * s2) / Math.max(1, n * n * 0.25);
  return { tonePower, totalPower: totalPower / n };
}

/**
 * Deterministic fixture verifier for PCM16 WAV: given the words expected in
 * the ORIGINAL audio, it emits only those whose window still carries audible
 * original signal in the redacted bytes — a zeroed window (RMS under the
 * silence floor) or a tone-dominated window (1 kHz Goertzel share over the
 * dominance floor) drops the word. Model-free and grounded in the real bytes;
 * clearly a fixture (requires the expected word list), for environments where
 * no live ASR is reachable.
 */
export function energyFixtureTranscriber(
  expectedWords: readonly TranscriptWord[],
): RedactionTranscriber {
  return {
    id: "energy-fixture",
    transcribe(input: RedactionTranscribeInput): Promise<RedactionTranscript> {
      const bytes = Buffer.from(input.audio);
      const info = parseWavPcm16(bytes);
      const audible: TranscriptWord[] = [];
      for (const word of expectedWords) {
        const startFrame = Math.max(
          0,
          Math.floor((word.startMs / 1000) * info.sampleRate),
        );
        const endFrame = Math.min(
          info.frameCount,
          Math.ceil((word.endMs / 1000) * info.sampleRate),
        );
        if (endFrame <= startFrame) continue;
        // First channel is representative — redaction writes every channel.
        const samples = new Int16Array(endFrame - startFrame);
        const bytesPerFrame = 2 * info.channels;
        for (let frame = startFrame; frame < endFrame; frame += 1) {
          samples[frame - startFrame] = bytes.readInt16LE(
            info.dataOffset + frame * bytesPerFrame,
          );
        }
        const { tonePower, totalPower } = windowPowers(
          samples,
          info.sampleRate,
          BLEEP_FREQUENCY_HZ,
        );
        const rms = Math.sqrt(totalPower);
        const toneShare = totalPower > 0 ? tonePower / totalPower : 0;
        const silenced = rms < SILENCE_RMS_FLOOR;
        const bleeped = toneShare >= TONE_DOMINANCE_FLOOR;
        if (!silenced && !bleeped) audible.push(word);
      }
      return Promise.resolve({
        text: audible.map((word) => word.text).join(" "),
        words: audible,
      });
    },
  };
}
