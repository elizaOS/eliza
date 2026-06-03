/**
 * voice-warmup — background "warm like embedding" for voice models.
 *
 * Unlike embedding (which has a runtime-free `ensureModel` facade), the voice
 * models (local Whisper STT / Kokoro TTS, or cloud ElevenLabs) only load
 * through the live agent runtime's `useModel(TRANSCRIPTION | TEXT_TO_SPEECH, …)`
 * path — the Kokoro bridge auto-starts on the first TEXT_TO_SPEECH call, and
 * the cloud handler validates its connection. So we warm them AFTER the runtime
 * is ready by firing one tiny request at each, fire-and-forget. That actually
 * loads (not just downloads) the models, so the first real voice interaction is
 * instant — the embedding warmup's spirit, via the path voice already uses.
 * Nothing in the voice engine is touched.
 *
 * BEHAVIOR CHANGE (PR #8175): warmup now fires for **both** local and cloud
 * setups. Previously, warmup was gated on `localInferenceActive` and was
 * suppressed for cloud-configured users. The gate has been removed.
 *
 * Impact for cloud users: at every desktop boot, two tiny API calls (one
 * silent WAV for STT, one empty-string TTS) will be dispatched through the
 * runtime's model router to whichever cloud voice provider is configured
 * (e.g. ElevenLabs, Eliza Cloud TTS). These calls are billable if the
 * provider charges per-request. They are intentionally small (~100 ms WAV for
 * STT, empty string for TTS) and non-blocking (fire-and-forget). Failures are
 * non-fatal and logged at WARN level.
 *
 * To suppress warmup entirely (both local and cloud) set:
 *   ELIZA_SKIP_LOCAL_VOICE_WARMUP=1
 */

/** Minimal runtime surface we need — avoids importing the heavy AgentRuntime. */
export interface VoiceWarmupRuntime {
  useModel(modelType: unknown, params: unknown): Promise<unknown>;
}

export interface VoiceWarmupGate {
  /** Running on a mobile platform (no local voice models shipped). */
  mobile: boolean;
  /** ELIZA_SKIP_LOCAL_VOICE_WARMUP is set. */
  skipEnv: boolean;
  /**
   * @deprecated No longer used — warmup fires for both local and cloud.
   * Kept for API compatibility; callers may still pass it.
   */
  localInferenceActive?: boolean;
}

/** Pure policy: should we warm voice models in the background? */
export function shouldWarmupVoice(gate: VoiceWarmupGate): boolean {
  if (gate.mobile) return false;
  if (gate.skipEnv) return false;
  return true;
}

/**
 * A tiny valid silent WAV (16 kHz mono 16-bit, ~100 ms) used as transcription
 * warmup input. Enough to make the runtime load the ASR model; the (empty)
 * result is discarded.
 */
export function buildSilentWarmupWav(): Buffer {
  const sampleRate = 16_000;
  const numSamples = Math.round(sampleRate * 0.1); // ~100 ms
  const dataBytes = numSamples * 2; // 16-bit mono
  const buf = Buffer.alloc(44 + dataBytes); // header + silence (already zeroed)
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4); // file size - 8
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate (mono 16-bit)
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

export interface VoiceWarmupModelTypes {
  /** ModelType.TEXT_TO_SPEECH value (injected to keep this module decoupled). */
  ttsType: unknown;
  /** ModelType.TRANSCRIPTION value. */
  transcriptionType: unknown;
}

type LogSink = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

const noopLog: LogSink = { info: () => {}, warn: () => {} };

/**
 * Retry a warmup call up to `maxRetries` times when the error message
 * indicates a transient HTTP issue (429 / 503). Waits `delayMs` between
 * retries (doubles each attempt). Non-transient errors are re-thrown
 * immediately so the caller's catch handler logs them.
 */
async function withRetry(
  fn: () => Promise<void>,
  maxRetries = 2,
  delayMs = 3_000,
): Promise<void> {
  let attempt = 0;
  while (true) {
    try {
      await fn();
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient = /\b(429|503)\b/.test(msg);
      if (!isTransient || attempt >= maxRetries) throw err;
      attempt++;
      await new Promise((r) => setTimeout(r, delayMs * attempt));
    }
  }
}

/**
 * Load both voice models by firing one warm request at each. Each call is
 * independently guarded: a failure (e.g. missing native lib) is logged and
 * skipped — the model simply loads on first real use instead. Never rejects.
 *
 * Transient cloud errors (429 / 503) are retried up to 2 times with backoff
 * before being treated as non-fatal.
 */
export async function warmVoiceModels(
  runtime: VoiceWarmupRuntime,
  types: VoiceWarmupModelTypes,
  log: LogSink = noopLog,
): Promise<void> {
  try {
    await withRetry(
      () =>
        runtime.useModel(types.ttsType, "Warming up voice.") as Promise<void>,
    );
    log.info("[eliza] Voice TTS model: ready");
  } catch (err) {
    log.warn(
      `[eliza] Voice TTS warmup failed (will load on first use): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  try {
    await withRetry(
      () =>
        runtime.useModel(
          types.transcriptionType,
          buildSilentWarmupWav(),
        ) as Promise<void>,
    );
    log.info("[eliza] Voice STT model: ready");
  } catch (err) {
    log.warn(
      `[eliza] Voice STT warmup failed (will load on first use): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
