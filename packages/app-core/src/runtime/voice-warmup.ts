/**
 * Background "warm like embedding" for voice models.
 *
 * Voice models load only through the live agent runtime's
 * `useModel(TRANSCRIPTION | TEXT_TO_SPEECH, …)` path, so we warm them AFTER the
 * runtime is ready by firing one tiny request at each, fire-and-forget. That
 * loads (not just downloads) the model the session will use, so the first real
 * interaction is instant.
 *
 * The warmup call goes through the model router with NO pinned provider, so it
 * exercises exactly the engine the session will use. It never picks the engine
 * itself: the router fails closed for `TEXT_TO_SPEECH` (#12253), so a broken
 * Kokoro surfaces its structured error here — logged at `warn` — instead of the
 * router silently swapping in edge-tts and reporting a healthy warmup. Warmup is
 * a first-use-latency optimization; a failure is non-fatal (the model loads on
 * first real use) but is never masked by warming a different voice.
 *
 * Warmup is skipped for mobile, hot-reload respawns, explicit cloud-only
 * desktop runtimes, and ELIZA_SKIP_LOCAL_VOICE_WARMUP=1.
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
  /** The runtime is explicitly cloud-only, so voice loads on first real use. */
  cloudOnly?: boolean;
  /**
   * Dev hot-reload respawn (not a cold boot). Each hot-reload spawns a fresh
   * API child that re-runs the whole boot tail; warming voice every bounce
   * re-fires a billable cloud TTS call and fully reloads the native whisper
   * model (~80 lines of GPU init), flooding the dev log on every edit. Warmup
   * is a first-use-latency optimization, so we skip it on reloads — voice still
   * loads on first real use. Cold boot still warms.
   */
  hotReload?: boolean;
}

/** Pure policy: should we warm voice models in the background? */
export function shouldWarmupVoice(gate: VoiceWarmupGate): boolean {
  if (gate.mobile) return false;
  if (gate.skipEnv) return false;
  if (gate.cloudOnly) return false;
  if (gate.hotReload) return false;
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

function isMissingModelHandlerError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("No handler found for delegate type");
}

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
    const logMethod = isMissingModelHandlerError(err) ? log.info : log.warn;
    logMethod(
      `[eliza] Voice TTS warmup skipped (will load on first use): ${
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
    const logMethod = isMissingModelHandlerError(err) ? log.info : log.warn;
    logMethod(
      `[eliza] Voice STT warmup skipped (will load on first use): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
