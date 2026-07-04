/**
 * The ASR boundary of the meeting pipeline.
 *
 * `AsrBackend` is the seam: the pipeline hands it a mono 16 kHz window and gets
 * back text (plus per-word timings when the backend has them). The default
 * meeting path pins interim LocalAgreement windows to local runtime ASR so
 * overlapping stabilization windows cannot accidentally bill a hosted provider.
 *
 * ── Why there is no in-process word-timing backend ─────────────────────────
 * The only first-party words-returning ASR path is
 * plugin-local-inference's `transcribeWavWithWords` (fused libelizainference
 * `transcribePcmTimed`). It is reachable only by (a) importing that plugin's
 * source — forbidden, plugins never import each other — or (b) the
 * `/api/asr/local-inference` HTTP route, which app-core mounts explicitly
 * (it is not on `runtime.routes`, not a registered elizaOS service, and the
 * locked `ModelType.TRANSCRIPTION ⇒ string` contract carries text only). No
 * clean in-process word-timing path exists, so runtime-backed segments carry
 * `words: []` (the transcript player falls back to segment-level
 * highlighting) rather than fabricated timings.
 */

import type { Buffer } from "node:buffer";
import { type IAgentRuntime, logger, ModelType } from "@elizaos/core";

const LOCAL_TRANSCRIPTION_PROVIDER = "eliza-local-inference";

export interface AsrTranscribeOptions {
  /** BCP-47 language hint; auto-detect when absent. */
  language?: string;
  /** Previously confirmed text — decoding context for streaming continuity. */
  prompt?: string;
  /** Raw mono PCM backing the WAV. Required by the local inference handler. */
  pcm?: Float32Array;
  /** Sample rate for `pcm`. Meeting audio is 16 kHz mono. */
  sampleRateHz?: number;
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

interface LocalTranscriptionParams {
  pcm: Float32Array;
  sampleRateHz: number;
  language?: string;
  prompt?: string;
  signal?: AbortSignal;
}

/** Whisper-style non-speech markers, e.g. "[BLANK_AUDIO]", "(silence)". */
const NON_SPEECH_PATTERN =
  /^[\s[(]*(?:blank[\s_]*audio|silence|no[\s_]*speech|inaudible|music)[\s\])]*$/i;

function isNonSpeech(text: string): boolean {
  return text.length === 0 || NON_SPEECH_PATTERN.test(text);
}

function isLocalTranscriptionRegistration(registration: {
  modelType: string;
  provider: string;
  metadata?: { local?: boolean };
}): boolean {
  return (
    registration.modelType === ModelType.TRANSCRIPTION &&
    (registration.metadata?.local === true ||
      registration.provider === LOCAL_TRANSCRIPTION_PROVIDER)
  );
}

export function findLocalTranscriptionProvider(
  runtime: IAgentRuntime,
): string | null {
  const registration = runtime
    .getModelRegistrations()
    .find(isLocalTranscriptionRegistration);
  return registration?.provider ?? null;
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
      ...(opts.signal ? { signal: opts.signal } : {}),
    };

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      opts.signal?.throwIfAborted();
      try {
        const raw = await this.runtime.useModel(
          ModelType.TRANSCRIPTION,
          params,
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

/**
 * Local-only ASR backend for live meeting stabilization windows.
 *
 * LocalAgreement intentionally retranscribes overlapping audio as it waits for
 * stable text. Routing those windows through provider priority would let a
 * higher-priority cloud ASR handler win, multiplying metered calls. This backend
 * resolves the local provider once and calls it by explicit provider name; if no
 * local registration exists, meeting transcription fails visibly instead of
 * silently spending cloud tokens.
 */
export class LocalRuntimeAsrBackend implements AsrBackend {
  private readonly provider: string;

  constructor(private readonly runtime: IAgentRuntime) {
    const provider = findLocalTranscriptionProvider(runtime);
    if (!provider) {
      throw new Error(
        "[MeetingPipeline] Local TRANSCRIPTION provider is required for meeting interim ASR",
      );
    }
    this.provider = provider;
  }

  async transcribe(
    _wav: Buffer,
    opts: AsrTranscribeOptions,
  ): Promise<AsrTranscribeResult> {
    if (!opts.pcm || !opts.sampleRateHz) {
      throw new Error(
        "[MeetingPipeline] Local TRANSCRIPTION requires PCM samples and sample rate",
      );
    }
    const params: LocalTranscriptionParams = {
      pcm: opts.pcm,
      sampleRateHz: opts.sampleRateHz,
      ...(opts.language ? { language: opts.language } : {}),
      ...(opts.prompt ? { prompt: opts.prompt } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
    const raw = await this.runtime.useModel(
      ModelType.TRANSCRIPTION,
      params,
      this.provider,
    );
    const text = typeof raw === "string" ? raw.trim() : "";
    return isNonSpeech(text) ? { text: "" } : { text };
  }
}
