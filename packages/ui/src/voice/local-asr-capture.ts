export interface LocalAsrRecorder {
  stop(): Promise<Uint8Array>;
  cancel(): void;
}

export interface LocalAsrAutoStopOptions {
  startGraceMs?: number;
  minSpeechMs?: number;
  silenceMs?: number;
  maxSpeechMs?: number;
  speechRmsThreshold?: number;
  speechPeakThreshold?: number;
}

export interface LocalAsrRecorderOptions {
  autoStop?: LocalAsrAutoStopOptions;
  onAutoStop?: () => void;
}

interface LocalAsrAutoStopConfig {
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

type AudioContextConstructor = typeof AudioContext;

type WindowWithAudioContext = Window & {
  AudioContext?: AudioContextConstructor;
  webkitAudioContext?: AudioContextConstructor;
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

const DEFAULT_LOCAL_ASR_AUTO_STOP: LocalAsrAutoStopConfig = {
  startGraceMs: 250,
  minSpeechMs: 180,
  silenceMs: 900,
  maxSpeechMs: 12_000,
  speechRmsThreshold: 0.003,
  speechPeakThreshold: 0.012,
};

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
    const speechDetected =
      stats.rms >= config.speechRmsThreshold ||
      stats.peak >= config.speechPeakThreshold;

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
  const chunks: Float32Array[] = [];
  let stopped = false;
  let autoStopRequested = false;
  const autoStopDetector = createLocalAsrAutoStopDetector(options.autoStop);

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

    const autoStopUpdate = autoStopDetector?.(mono) ?? {
      shouldBuffer: true,
      shouldStop: false,
    };
    if (autoStopUpdate.shouldBuffer) {
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
    async stop() {
      const sampleRate = context.sampleRate;
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
