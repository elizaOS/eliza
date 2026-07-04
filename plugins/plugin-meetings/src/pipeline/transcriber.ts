/**
 * The ASR boundary of the meeting pipeline.
 *
 * `AsrBackend` is the seam: the pipeline hands it a mono 16 kHz 16-bit PCM
 * WAV window and gets back text (plus per-word timings when the backend has
 * them). The default backend routes through
 * `runtime.useModel(ModelType.TRANSCRIPTION)`.
 *
 * ── Why there is no in-process word-timing backend ─────────────────────────
 * The only first-party words-returning ASR path is
 * plugin-local-inference's `transcribeWavWithWords` (fused libelizainference
 * `transcribePcmTimed`). It is reachable only by (a) importing that plugin's
 * source — forbidden, plugins never import each other — or (b) the
 * `/api/asr/local-inference` HTTP route, which app-core mounts explicitly
 * (it is not on `runtime.routes`, not a registered elizaOS service, and the
 * locked `ModelType.TRANSCRIPTION ⇒ string` contract carries text only). No
 * clean in-process seam exists, so this module ships RuntimeModelAsrBackend
 * alone; segments then carry `words: []` (the transcript player falls back
 * to segment-level highlighting) rather than fabricated timings.
 */

import type { Buffer } from "node:buffer";
import { type IAgentRuntime, logger, ModelType } from "@elizaos/core";

export interface AsrTranscribeOptions {
  /** BCP-47 language hint; auto-detect when absent. */
  language?: string;
  /** Previously confirmed text — decoding context for streaming continuity. */
  prompt?: string;
  /** Repeated overlap windows are interim; terminal flushes are final. */
  purpose?: "interim" | "final";
  signal?: AbortSignal;
}

export interface AsrTranscribeResult {
  /** Transcript text; empty string means silence / nothing usable. */
  text: string;
  /** Per-word timings in ms relative to the submitted WAV, when available. */
  words?: Array<{ text: string; startMs: number; endMs: number }>;
  /** Detected language, when the backend reports it. */
  language?: string;
}

export interface AsrBackend {
  transcribe(
    wav: Buffer,
    opts: AsrTranscribeOptions,
  ): Promise<AsrTranscribeResult>;
}

export interface RuntimeModelAsrBackendConfig {
  /** Max retry attempts for transient failures. Default: 3 */
  maxRetries?: number;
  /** Base delay between retries in ms (exponential backoff). Default: 1000 */
  retryDelayMs?: number;
}

/** Whisper-style non-speech markers, e.g. "[BLANK_AUDIO]", "(silence)". */
const NON_SPEECH_PATTERN =
  /^[\s[(]*(?:blank[\s_]*audio|silence|no[\s_]*speech|inaudible|music)[\s\])]*$/i;
const LOCAL_INFERENCE_PROVIDER = "eliza-local-inference";

function isNonSpeech(text: string): boolean {
  return text.length === 0 || NON_SPEECH_PATTERN.test(text);
}

function localTranscriptionProvider(
  runtime: IAgentRuntime,
): string | undefined {
  const registrations = runtime.getModelRegistrations();
  const localRegistration = registrations.find(
    (registration) =>
      registration.modelType === ModelType.TRANSCRIPTION &&
      registration.metadata?.local === true,
  );
  if (localRegistration) return localRegistration.provider;

  return registrations.find(
    (registration) =>
      registration.modelType === ModelType.TRANSCRIPTION &&
      registration.provider === LOCAL_INFERENCE_PROVIDER &&
      registration.metadata?.local !== false,
  )?.provider;
}

/**
 * Default ASR backend: `runtime.useModel(ModelType.TRANSCRIPTION)` with
 * retry/backoff (ported from Vexa's transcription-client). The params object
 * carries the WAV under both conventions in use across first-party
 * providers — `audio` (Buffer + mimeType; plugin-openai's local params,
 * plugin-local-inference's service.transcribe) and `audioUrl` (core
 * `TranscriptionParams`, as a data: URL) — plus `prompt` for continuity.
 * The locked TRANSCRIPTION contract returns text only (no word timings).
 */
export class RuntimeModelAsrBackend implements AsrBackend {
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly runtime: IAgentRuntime,
    config?: RuntimeModelAsrBackendConfig,
  ) {
    this.maxRetries = config?.maxRetries ?? 3;
    this.retryDelayMs = config?.retryDelayMs ?? 1000;
  }

  async transcribe(
    wav: Buffer,
    opts: AsrTranscribeOptions,
  ): Promise<AsrTranscribeResult> {
    const params = {
      audio: wav,
      mimeType: "audio/wav",
      audioUrl: `data:audio/wav;base64,${wav.toString("base64")}`,
      ...(opts.language ? { language: opts.language } : {}),
      ...(opts.prompt ? { prompt: opts.prompt } : {}),
      transcriptionPurpose: opts.purpose ?? "final",
      billing: {
        billable: opts.purpose !== "interim",
        reason:
          opts.purpose === "interim"
            ? "meeting-local-agreement-overlap"
            : "meeting-final-window",
      },
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
    const provider =
      opts.purpose === "interim"
        ? localTranscriptionProvider(this.runtime)
        : undefined;

    if (opts.purpose === "interim" && !provider) {
      logger.debug(
        "[MeetingPipeline] Skipping interim LocalAgreement ASR window; local inference TRANSCRIPTION provider is unavailable",
      );
      return { text: "" };
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      opts.signal?.throwIfAborted();
      try {
        const raw = await this.runtime.useModel(
          ModelType.TRANSCRIPTION,
          params,
          provider,
        );
        const text = typeof raw === "string" ? raw.trim() : "";
        return isNonSpeech(text) ? { text: "" } : { text };
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        lastError = err;
        if (attempt === this.maxRetries) break;
        const delay = this.retryDelayMs * 2 ** attempt;
        logger.warn(
          { err },
          `[MeetingPipeline] TRANSCRIPTION attempt ${attempt + 1}/${this.maxRetries + 1} failed; retrying in ${delay}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(
          `[MeetingPipeline] TRANSCRIPTION failed: ${String(lastError)}`,
        );
  }
}
