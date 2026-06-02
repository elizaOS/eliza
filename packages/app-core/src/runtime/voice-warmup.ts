/**
 * voice-warmup — background "warm like embedding" for local voice models.
 *
 * Unlike embedding (which has a runtime-free `ensureModel` facade), the local
 * voice models (Whisper STT / Kokoro TTS) only load through the live agent
 * runtime's `useModel(TRANSCRIPTION | TEXT_TO_SPEECH, …)` path — the Kokoro
 * bridge auto-starts on the first TEXT_TO_SPEECH call. So we warm them AFTER
 * the runtime is ready by firing one tiny request at each, fire-and-forget.
 * That actually loads (not just downloads) the models, so the first real voice
 * interaction is instant — the embedding warmup's spirit, via the path voice
 * already uses. Nothing in the voice engine is touched.
 *
 * Gating keeps this off cloud-only setups (so it never triggers a paid cloud
 * TTS/STT call): warm only when local inference is the active path.
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
  /** Local inference is the active model path (vs cloud/remote). */
  localInferenceActive: boolean;
}

/** Pure policy: should we warm local voice models in the background? */
export function shouldWarmupVoice(gate: VoiceWarmupGate): boolean {
  if (gate.mobile) return false;
  if (gate.skipEnv) return false;
  if (!gate.localInferenceActive) return false;
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
 * Load both voice models by firing one warm request at each. Each call is
 * independently guarded: a failure (e.g. missing native lib) is logged and
 * skipped — the model simply loads on first real use instead. Never rejects.
 */
export async function warmVoiceModels(
  runtime: VoiceWarmupRuntime,
  types: VoiceWarmupModelTypes,
  log: LogSink = noopLog,
): Promise<void> {
  try {
    await runtime.useModel(types.ttsType, "Warming up voice.");
    log.info("[eliza] Voice TTS model: ready");
  } catch (err) {
    log.warn(
      `[eliza] Voice TTS warmup failed (will load on first use): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  try {
    await runtime.useModel(types.transcriptionType, buildSilentWarmupWav());
    log.info("[eliza] Voice STT model: ready");
  } catch (err) {
    log.warn(
      `[eliza] Voice STT warmup failed (will load on first use): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
