/**
 * Mic-capture recorder for local ASR: records mono PCM16, exposes a live analyser
 * for amplitude visualization, and stops/cancels the audio context cleanly.
 */
export interface LocalAsrRecorder {
  stop(): Promise<Uint8Array>;
  cancel(): void;
  /** Monotonic capture timing, in the same clock used by playback-frame taps. */
  readonly captureTiming?: LocalAsrCaptureTiming;
  /**
   * Live analyser tapped off the same mic stream, for amplitude visualization.
   * `null` once the recorder has been stopped / cancelled (the context closes).
   */
  analyser: AnalyserNode | null;
}

export interface LocalAsrCaptureTiming {
  captureStartedAtMs: number;
  captureEndedAtMs?: number;
}

export interface LocalAsrAutoStopOptions {
  startGraceMs?: number;
  minSpeechMs?: number;
  silenceMs?: number;
  maxSpeechMs?: number;
  speechRmsThreshold?: number;
  speechPeakThreshold?: number;
  ttsCooldownGate?: LocalAsrTtsCooldownGateOptions;
}

export interface LocalAsrRecorderOptions {
  autoStop?: LocalAsrAutoStopOptions;
  ttsCooldownGate?: LocalAsrTtsCooldownGateOptions;
  onAutoStop?: () => void;
}

/** Fully-resolved numeric auto-stop config. */
export interface LocalAsrAutoStopConfig {
  startGraceMs: number;
  minSpeechMs: number;
  silenceMs: number;
  maxSpeechMs: number;
  speechRmsThreshold: number;
  speechPeakThreshold: number;
}

export interface LocalAsrAutoStopUpdate {
  shouldBuffer: boolean;
  shouldStop: boolean;
}

export interface LocalAsrTtsCooldownGateOptions {
  postTtsCooldownMs?: number;
  bargeInRmsThreshold?: number;
  bargeInPeakThreshold?: number;
  isPlaybackActive?: () => boolean;
  lastPlaybackEndedAtMs?: () => number | null | undefined;
}

export interface LocalAsrTtsCooldownGateConfig {
  postTtsCooldownMs: number;
  bargeInRmsThreshold: number;
  bargeInPeakThreshold: number;
}

type AudioContextConstructor = typeof AudioContext;

type WindowWithAudioContext = Window & {
  AudioContext?: AudioContextConstructor;
  webkitAudioContext?: AudioContextConstructor;
};

type WindowWithTtsPlaybackState = Window & {
  __elizaVoiceTtsPlayback?: {
    active?: boolean;
    lastEndedAtMs?: number;
  };
};

type ProcessWithEnv = {
  env?: Record<string, string | undefined>;
};

function getAudioContextCtor(): AudioContextConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  const win = window as WindowWithAudioContext;
  return win.AudioContext ?? win.webkitAudioContext;
}

export function isLocalAsrCaptureSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    !!getAudioContextCtor()
  );
}

function concatPcm(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function clampPcm16(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export type PcmAudioStats = {
  rms: number;
  peak: number;
};

export function measurePcmAudio(pcm: Float32Array): PcmAudioStats {
  if (pcm.length === 0) return { rms: 0, peak: 0 };

  let sumSquares = 0;
  let peak = 0;

  for (const sample of pcm) {
    const value = Number.isFinite(sample) ? sample : 0;
    const abs = Math.abs(value);
    sumSquares += value * value;
    if (abs > peak) peak = abs;
  }

  return {
    rms: Math.sqrt(sumSquares / pcm.length),
    peak,
  };
}

export function isSilentPcmAudio(pcm: Float32Array): boolean {
  return measurePcmAudio(pcm).peak < 0.0005;
}

export const DEFAULT_LOCAL_ASR_AUTO_STOP: LocalAsrAutoStopConfig = {
  startGraceMs: 250,
  minSpeechMs: 180,
  silenceMs: 900,
  maxSpeechMs: 12_000,
  speechRmsThreshold: 0.003,
  speechPeakThreshold: 0.012,
};

export const DEFAULT_LOCAL_ASR_POST_TTS_COOLDOWN_MS = 1500;
export const DEFAULT_LOCAL_ASR_TTS_BARGE_IN_RMS_THRESHOLD = 0.025;
export const DEFAULT_LOCAL_ASR_TTS_BARGE_IN_PEAK_THRESHOLD = 0.08;

function readRuntimeEnvValue(key: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  const env = (process as ProcessWithEnv).env;
  if (!env) return undefined;
  return env[key];
}

function parseNonNegativeMs(
  value: string | number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.round(parsed);
}

function finitePositive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

export function resolveLocalAsrTtsCooldownGateConfig(
  options: LocalAsrTtsCooldownGateOptions = {},
): LocalAsrTtsCooldownGateConfig {
  return {
    postTtsCooldownMs: parseNonNegativeMs(
      options.postTtsCooldownMs ??
        readRuntimeEnvValue("ELIZA_VOICE_POST_TTS_COOLDOWN_MS"),
      DEFAULT_LOCAL_ASR_POST_TTS_COOLDOWN_MS,
    ),
    bargeInRmsThreshold: finitePositive(
      options.bargeInRmsThreshold,
      DEFAULT_LOCAL_ASR_TTS_BARGE_IN_RMS_THRESHOLD,
    ),
    bargeInPeakThreshold: finitePositive(
      options.bargeInPeakThreshold,
      DEFAULT_LOCAL_ASR_TTS_BARGE_IN_PEAK_THRESHOLD,
    ),
  };
}

function getWindowTtsPlaybackState():
  | WindowWithTtsPlaybackState["__elizaVoiceTtsPlayback"]
  | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as WindowWithTtsPlaybackState).__elizaVoiceTtsPlayback;
}

function isDefaultPlaybackActive(): boolean {
  if (typeof window === "undefined") return false;
  const sidecar = getWindowTtsPlaybackState();
  if (sidecar?.active === true) return true;
  const synth = window.speechSynthesis;
  return synth?.speaking === true || synth?.pending === true;
}

function defaultLastPlaybackEndedAtMs(): number | null | undefined {
  return getWindowTtsPlaybackState()?.lastEndedAtMs;
}

export function markLocalAsrTtsPlaybackStarted(atMs = nowMs()): void {
  if (typeof window === "undefined") return;
  (window as WindowWithTtsPlaybackState).__elizaVoiceTtsPlayback = {
    active: true,
    lastEndedAtMs: atMs,
  };
}

export function markLocalAsrTtsPlaybackEnded(atMs = nowMs()): void {
  if (typeof window === "undefined") return;
  (window as WindowWithTtsPlaybackState).__elizaVoiceTtsPlayback = {
    active: false,
    lastEndedAtMs: atMs,
  };
}

export function isLocalAsrTtsCooldownStartAllowed(
  stats: PcmAudioStats,
  options: LocalAsrTtsCooldownGateOptions = {},
  sampleTimeMs = nowMs(),
): boolean {
  const config = resolveLocalAsrTtsCooldownGateConfig(options);
  const playbackActive =
    options.isPlaybackActive?.() ?? isDefaultPlaybackActive();
  const lastEndedAtMs =
    options.lastPlaybackEndedAtMs?.() ?? defaultLastPlaybackEndedAtMs();
  const elapsedSincePlaybackEndMs =
    typeof lastEndedAtMs === "number" && Number.isFinite(lastEndedAtMs)
      ? sampleTimeMs - lastEndedAtMs
      : Number.POSITIVE_INFINITY;
  const inCooldown =
    elapsedSincePlaybackEndMs >= 0 &&
    elapsedSincePlaybackEndMs < config.postTtsCooldownMs;

  if (!playbackActive && !inCooldown) return true;

  return (
    stats.rms >= config.bargeInRmsThreshold ||
    stats.peak >= config.bargeInPeakThreshold
  );
}

export function createLocalAsrAutoStopDetector(
  options: LocalAsrAutoStopOptions | undefined,
  startedAtMs = nowMs(),
):
  | ((pcm: Float32Array, sampleTimeMs?: number) => LocalAsrAutoStopUpdate)
  | null {
  if (!options) return null;

  const config: LocalAsrAutoStopConfig = {
    ...DEFAULT_LOCAL_ASR_AUTO_STOP,
    ...options,
  };
  const ttsCooldownGate = options.ttsCooldownGate;
  let firstSpeechAtMs: number | null = null;
  let lastSpeechAtMs: number | null = null;
  let stopped = false;

  return (pcm: Float32Array, sampleTimeMs = nowMs()) => {
    if (stopped) return { shouldBuffer: false, shouldStop: false };

    const elapsedMs = Math.max(0, sampleTimeMs - startedAtMs);
    if (elapsedMs < config.startGraceMs) {
      return { shouldBuffer: false, shouldStop: false };
    }

    const stats = measurePcmAudio(pcm);
    const normalSpeechDetected =
      stats.rms >= config.speechRmsThreshold ||
      stats.peak >= config.speechPeakThreshold;
    const speechDetected =
      normalSpeechDetected &&
      (firstSpeechAtMs !== null ||
        isLocalAsrTtsCooldownStartAllowed(
          stats,
          ttsCooldownGate,
          sampleTimeMs,
        ));

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
}

export function encodeMonoPcm16Wav(
  pcm: Float32Array,
  sampleRateHz: number,
): Uint8Array {
  const sampleRate = Math.max(1, Math.round(sampleRateHz));
  const bytesPerSample = 2;
  const dataBytes = pcm.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (const sample of pcm) {
    const clamped = clampPcm16(sample);
    const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(offset, Math.round(int16), true);
    offset += bytesPerSample;
  }

  return new Uint8Array(buffer);
}

export async function startLocalAsrRecorder(
  options: LocalAsrRecorderOptions = {},
): Promise<LocalAsrRecorder> {
  const AudioContextCtor = getAudioContextCtor();
  if (!AudioContextCtor) {
    throw new Error("AudioContext is not available for local ASR capture");
  }
  if (typeof navigator.mediaDevices?.getUserMedia !== "function") {
    throw new Error("Microphone capture is not available for local ASR");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      // Gemma ASR ingests 16 kHz mono; request it at capture so the
      // browser resamples once instead of us downsampling a 48 kHz buffer.
      sampleRate: 16000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const context = new AudioContextCtor();
  if (context.state === "suspended") {
    await context.resume().catch(() => {});
  }

  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  let analyser: AnalyserNode | null = context.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.8;
  source.connect(analyser);
  const chunks: Float32Array[] = [];
  let stopped = false;
  let autoStopRequested = false;
  let captureStartedAtMs: number | undefined;
  let captureEndedAtMs: number | undefined;
  const autoStopDetector = createLocalAsrAutoStopDetector(options.autoStop);
  const ttsCooldownGate = options.autoStop?.ttsCooldownGate
    ? undefined
    : options.ttsCooldownGate;
  let captureStartAccepted = false;

  processor.onaudioprocess = (event) => {
    if (stopped) return;
    const input = event.inputBuffer;
    const frameCount = input.length;
    const channelCount = Math.max(1, input.numberOfChannels);
    const mono = new Float32Array(frameCount);

    for (let channel = 0; channel < channelCount; channel += 1) {
      const data = input.getChannelData(channel);
      for (let index = 0; index < frameCount; index += 1) {
        mono[index] = (mono[index] ?? 0) + (data[index] ?? 0) / channelCount;
      }
    }

    const autoStopUpdate =
      autoStopDetector?.(mono) ??
      (() => {
        if (captureStartAccepted) {
          return { shouldBuffer: true, shouldStop: false };
        }
        const stats = measurePcmAudio(mono);
        const shouldBuffer = isLocalAsrTtsCooldownStartAllowed(
          stats,
          ttsCooldownGate,
        );
        if (shouldBuffer) captureStartAccepted = true;
        return { shouldBuffer, shouldStop: false };
      })();
    if (autoStopUpdate.shouldBuffer) {
      captureStartedAtMs ??=
        nowMs() - (mono.length / Math.max(1, context.sampleRate)) * 1000;
      chunks.push(mono);
    }
    if (autoStopUpdate.shouldStop && !autoStopRequested && options.onAutoStop) {
      autoStopRequested = true;
      window.setTimeout(options.onAutoStop, 0);
    }
  };

  source.connect(processor);
  processor.connect(context.destination);

  const cleanup = async () => {
    stopped = true;
    processor.onaudioprocess = null;
    try {
      analyser?.disconnect();
    } catch {
      /* already disconnected */
    }
    analyser = null;
    try {
      source.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      processor.disconnect();
    } catch {
      /* already disconnected */
    }
    for (const track of stream.getTracks()) {
      track.stop();
    }
    await context.close().catch(() => {});
  };

  return {
    get analyser() {
      return analyser;
    },
    get captureTiming() {
      const timing: LocalAsrCaptureTiming = {
        captureStartedAtMs: captureStartedAtMs ?? captureEndedAtMs ?? nowMs(),
      };
      if (captureEndedAtMs !== undefined) {
        timing.captureEndedAtMs = captureEndedAtMs;
      }
      return timing;
    },
    async stop() {
      const sampleRate = context.sampleRate;
      captureEndedAtMs = nowMs();
      await cleanup();
      const pcm = concatPcm(chunks);
      if (pcm.length === 0) {
        throw new Error("No microphone audio was captured for local ASR");
      }
      return encodeMonoPcm16Wav(pcm, sampleRate);
    },
    cancel() {
      void cleanup();
    },
  };
}
