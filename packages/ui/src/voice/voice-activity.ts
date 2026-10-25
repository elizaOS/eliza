/** Canonical capture activity policy shared by PCM and native peak-only recorders. */
export interface VoiceActivityMetrics {
  peak: number;
  rms?: number;
}
export interface VoiceActivityConfig {
  startGraceMs: number;
  minSpeechMs: number;
  silenceMs: number;
  maxSpeechMs: number;
  speechRmsThreshold: number;
  speechPeakThreshold: number;
}
export interface VoiceActivityOptions extends Partial<VoiceActivityConfig> {
  isTtsEchoGateActive?: (atMs: number) => boolean;
}
export interface VoiceActivityUpdate {
  shouldBuffer: boolean;
  shouldStop: boolean;
}
export type VoiceActivityDetector = ((
  stats: VoiceActivityMetrics,
  sampleTimeMs?: number,
) => VoiceActivityUpdate) & { readonly hasSpeech: boolean };

export const POST_TTS_ECHO_THRESHOLD_MULTIPLIER = 4;

export const DEFAULT_VOICE_ACTIVITY: VoiceActivityConfig = {
  startGraceMs: 250,
  minSpeechMs: 180,
  // Trailing-silence window that ends a hands-free turn (#voice-V6). 900 → 650:
  // still shaves ~250ms off every turn's speech-end → capture-stop leg, but keeps
  // headroom for natural inter-clause pauses (per review on #15267: 550 risks
  // clipping slow/deliberate speakers, and mid-sentence pauses routinely exceed
  // 550ms). The user override still wins: `loadVadAutoStop()` reads a persisted
  // `silenceMs` first and only falls back to this default. On-device tuning can
  // move this again once false-cutoff behavior is verified on the installed PWA.
  silenceMs: 650,
  maxSpeechMs: 12_000,
  speechRmsThreshold: 0.003,
  speechPeakThreshold: 0.012,
};

export function createVoiceActivityDetector(
  options: VoiceActivityOptions,
  startedAtMs: number,
  now: () => number,
): VoiceActivityDetector;
export function createVoiceActivityDetector(
  options: VoiceActivityOptions | undefined,
  startedAtMs: number,
  now: () => number,
): VoiceActivityDetector | null;
export function createVoiceActivityDetector(
  options: VoiceActivityOptions | undefined,
  startedAtMs: number,
  now: () => number,
): VoiceActivityDetector | null {
  if (!options) return null;

  const config: VoiceActivityConfig = {
    ...DEFAULT_VOICE_ACTIVITY,
    ...options,
  };
  const echoGateActive = options.isTtsEchoGateActive ?? (() => false);
  let firstSpeechAtMs: number | null = null;
  let lastSpeechAtMs: number | null = null;
  let stopped = false;

  const detector = (stats: VoiceActivityMetrics, sampleTimeMs = now()) => {
    if (stopped) return { shouldBuffer: false, shouldStop: false };

    const elapsedMs = Math.max(0, sampleTimeMs - startedAtMs);
    if (elapsedMs < config.startGraceMs) {
      return { shouldBuffer: false, shouldStop: false };
    }

    // Echo gate (#12256 layer 1): while the agent's TTS is playing (and for a
    // short cooldown after), demand louder speech before treating the frame as
    // a turn — the agent's own tail must not self-trigger an ASR submission,
    // but a loud, close interjection (real barge-in) still clears the bar.
    const gateMultiplier = echoGateActive(sampleTimeMs)
      ? POST_TTS_ECHO_THRESHOLD_MULTIPLIER
      : 1;
    const speechDetected =
      (stats.rms ?? 0) >= config.speechRmsThreshold * gateMultiplier ||
      stats.peak >= config.speechPeakThreshold * gateMultiplier;

    if (speechDetected) {
      if (firstSpeechAtMs === null) firstSpeechAtMs = sampleTimeMs;
      lastSpeechAtMs = sampleTimeMs;
      if (sampleTimeMs - firstSpeechAtMs >= config.maxSpeechMs) {
        stopped = true;
        return { shouldBuffer: true, shouldStop: true };
      }
      return { shouldBuffer: true, shouldStop: false };
    }

    if (firstSpeechAtMs === null || lastSpeechAtMs === null) {
      return { shouldBuffer: false, shouldStop: false };
    }

    const speechDurationMs = lastSpeechAtMs - firstSpeechAtMs;
    const silenceDurationMs = sampleTimeMs - lastSpeechAtMs;
    if (
      speechDurationMs >= config.minSpeechMs &&
      silenceDurationMs >= config.silenceMs
    ) {
      stopped = true;
      return { shouldBuffer: false, shouldStop: true };
    }

    return { shouldBuffer: true, shouldStop: false };
  };
  return Object.defineProperty(detector, "hasSpeech", {
    get: () =>
      firstSpeechAtMs !== null &&
      lastSpeechAtMs !== null &&
      lastSpeechAtMs - firstSpeechAtMs >= config.minSpeechMs,
  }) as VoiceActivityDetector;
}
