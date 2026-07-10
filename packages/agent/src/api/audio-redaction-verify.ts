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
import { type IAgentRuntime, ModelType } from "@elizaos/core";
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
      return { text: typeof text === "string" ? text : String(text) };
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
  const base = options.baseUrl.replace(/\/+$/, "");
  return {
    id: `openai-compat-stt:${new URL(base).host}`,
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
      const response = await fetch(`${base}/v1/audio/transcriptions`, {
        method: "POST",
        body: form,
        headers: options.apiKey
          ? { Authorization: `Bearer ${options.apiKey}` }
          : {},
        signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
      });
      if (!response.ok) {
        throw new Error(
          `STT verifier ${base} answered ${response.status}: ${await response
            .text()
            .catch(() => "")}`,
        );
      }
      const body: unknown = await response.json();
      const text = (body as { text?: unknown }).text;
      if (typeof text !== "string") {
        throw new Error(`STT verifier ${base} returned no transcript text`);
      }
      return { text };
    },
  };
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
