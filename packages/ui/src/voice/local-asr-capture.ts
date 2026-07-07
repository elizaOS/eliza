/**
 * Mic-capture recorder for local ASR: records mono PCM16, exposes a live analyser
 * for amplitude visualization, and stops/cancels the audio context cleanly.
 */
import {
  DEFAULT_POST_TTS_COOLDOWN_MS,
  isTtsEchoGateActive as sharedTtsEchoGateActive,
} from "./tts-playback-activity";

export interface LocalAsrRecorder {
  stop(): Promise<Uint8Array>;
  cancel(): void;
  /**
   * Live analyser tapped off the same mic stream, for amplitude visualization.
   * `null` once the recorder has been stopped / cancelled (the context closes).
   */
  analyser: AnalyserNode | null;
}

export interface LocalAsrAutoStopOptions {
  startGraceMs?: number;
  minSpeechMs?: number;
  silenceMs?: number;
  maxSpeechMs?: number;
  speechRmsThreshold?: number;
  speechPeakThreshold?: number;
  /** Post-TTS cooldown (ms) during which the raised echo gate stays active.
   * Default {@link DEFAULT_POST_TTS_COOLDOWN_MS} (1500). */
  postTtsCooldownMs?: number;
  /** Injectable playback-activity probe (tests). Defaults to the shared
   * renderer signal in tts-playback-activity.ts. */
  isTtsEchoGateActive?: (nowMs: number) => boolean;
}

export interface LocalAsrRecorderOptions {
  autoStop?: LocalAsrAutoStopOptions;
  onAutoStop?: () => void;
}

/** Fully-resolved auto-stop config (every {@link LocalAsrAutoStopOptions} field set). */
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

/**
 * The subset of `PermissionState` the voice loop reacts to, plus `"unknown"`
 * for the platforms where the Permissions API can't answer (Safari/iOS PWA
 * historically does not support the `"microphone"` descriptor name — the query
 * rejects). `"unknown"` is treated as "proceed and let getUserMedia decide"
 * so the recheck never blocks capture on a browser that simply can't report.
 */
export type MicrophonePermissionState =
  | "granted"
  | "denied"
  | "prompt"
  | "unknown";

/**
 * Proactively read the microphone permission via
 * `navigator.permissions.query({ name: "microphone" })` without opening the
 * mic. Used to show a "re-enable mic" affordance on hands-free engage / boot
 * before `getUserMedia` reaches a revoked grant at capture time.
 *
 * Returns `"unknown"` (never throws) when the Permissions API is missing or
 * the `"microphone"` descriptor is unsupported (Safari/older iOS) — callers
 * treat unknown as "proceed normally", identical to `"prompt"`/`"granted"`.
 */
export async function queryMicrophonePermission(): Promise<MicrophonePermissionState> {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.permissions?.query !== "function"
  ) {
    return "unknown";
  }
  try {
    const status = await navigator.permissions.query({
      // `"microphone"` isn't in the older lib.dom PermissionName union; the
      // cast is the same one the desktop permissions client uses.
      name: "microphone" as PermissionName,
    });
    const state = status?.state;
    if (state === "granted" || state === "denied" || state === "prompt") {
      return state;
    }
    return "unknown";
  } catch {
    // Unsupported descriptor / query rejection → "unknown" is the explicit
    // "can't determine, proceed normally" signal (matches the desktop
    // permissions probe's null-on-throw contract).
    return "unknown";
  }
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

/**
 * Speech-threshold multiplier applied while the TTS echo gate is active
 * (#12256 layer 1): during agent playback + the post-TTS cooldown, quiet
 * far-field echo must not read as speech, while loud close speech (a real
 * barge-in) still clears the raised bar. 4x lifts the default RMS gate from
 * 0.003 to 0.012 and the peak gate from 0.012 to 0.048.
 */
export const POST_TTS_ECHO_THRESHOLD_MULTIPLIER = 4;

export const DEFAULT_LOCAL_ASR_AUTO_STOP: LocalAsrAutoStopConfig = {
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
  const cooldownMs = options.postTtsCooldownMs ?? DEFAULT_POST_TTS_COOLDOWN_MS;
  const echoGateActive =
    options.isTtsEchoGateActive ??
    ((atMs: number) => sharedTtsEchoGateActive(atMs, cooldownMs));
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
    // Echo gate (#12256 layer 1): while the agent's TTS is playing (and for a
    // short cooldown after), demand louder speech before treating the frame as
    // a turn — the agent's own tail must not self-trigger an ASR submission,
    // but a loud, close interjection (real barge-in) still clears the bar.
    const gateMultiplier = echoGateActive(sampleTimeMs)
      ? POST_TTS_ECHO_THRESHOLD_MULTIPLIER
      : 1;
    const speechDetected =
      stats.rms >= config.speechRmsThreshold * gateMultiplier ||
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

/**
 * Decode a mono PCM16 WAV (as produced by {@link encodeMonoPcm16Wav}) back to a
 * Float32 sample buffer in [-1, 1]. Used by the pre-POST silence guard
 * (#voice-V5): the capture recorder hands the factory an already-encoded WAV,
 * so to test it for silence with {@link isSilentPcmAudio} we read the PCM back
 * out of the RIFF body rather than plumbing a second Float32 buffer through the
 * recorder API.
 *
 * Best-effort + defensive: it locates the `data` chunk instead of assuming the
 * canonical 44-byte header, and returns an empty buffer for anything it can't
 * parse (a non-WAV / truncated body). An empty buffer reads as silent, which is
 * the safe default for the guard (a body we can't decode is not worth a STT
 * round-trip).
 */
export function decodeMonoPcm16Wav(wav: Uint8Array): Float32Array {
  // Minimum parseable size: RIFF/WAVE header (12) + a `data` sub-chunk header
  // (8) = 20. (The canonical encoder writes a 44-byte header, but a valid WAV
  // with a non-canonical chunk layout can be smaller — don't over-reject.)
  if (wav.length < 20) return new Float32Array(0);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const riff =
    view.getUint8(0) === 0x52 && // 'R'
    view.getUint8(1) === 0x49 && // 'I'
    view.getUint8(2) === 0x46 && // 'F'
    view.getUint8(3) === 0x46; // 'F'
  if (!riff) return new Float32Array(0);

  // Walk sub-chunks from offset 12 to find `data` (chunks may precede it, e.g.
  // `fmt `); don't assume the 44-byte canonical layout.
  let offset = 12;
  let dataStart = -1;
  let dataBytes = 0;
  while (offset + 8 <= wav.length) {
    const id0 = view.getUint8(offset);
    const id1 = view.getUint8(offset + 1);
    const id2 = view.getUint8(offset + 2);
    const id3 = view.getUint8(offset + 3);
    const chunkBytes = view.getUint32(offset + 4, true);
    // 'data'
    if (id0 === 0x64 && id1 === 0x61 && id2 === 0x74 && id3 === 0x61) {
      dataStart = offset + 8;
      dataBytes = chunkBytes;
      break;
    }
    // Chunks are word-aligned (odd sizes get a pad byte).
    offset += 8 + chunkBytes + (chunkBytes % 2);
  }
  if (dataStart < 0) return new Float32Array(0);

  // Clamp to the actual buffer length in case the header over-reports.
  const available = Math.max(0, wav.length - dataStart);
  const usableBytes = Math.min(dataBytes, available);
  const sampleCount = Math.floor(usableBytes / 2);
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    const int16 = view.getInt16(dataStart + i * 2, true);
    out[i] = int16 < 0 ? int16 / 0x8000 : int16 / 0x7fff;
  }
  return out;
}

/**
 * True when a captured WAV carries no usable speech (peak amplitude below the
 * {@link isSilentPcmAudio} floor) — the pre-POST silence guard (#voice-V5) uses
 * this to no-op an accidental near-silent tap instead of burning a cloud STT
 * round-trip / credit and surfacing a spurious empty-transcript error.
 */
export function isSilentWav(wav: Uint8Array): boolean {
  return isSilentPcmAudio(decodeMonoPcm16Wav(wav));
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
    // A context that cannot resume produces silence — surface the failure to
    // the caller (voice-capture-factory setState("error")) instead of
    // recording a dead stream. Release the mic + context first so the failed
    // start does not leave the capture indicator on.
    try {
      await context.resume();
    } catch (err) {
      // error-policy:J2 release the hot mic, then rethrow with context
      for (const track of stream.getTracks()) track.stop();
      // error-policy:J6 teardown — the context may already be closed
      await context.close().catch(() => undefined);
      throw new Error("AudioContext could not resume for local ASR capture", {
        cause: err,
      });
    }
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
      analyser?.disconnect();
    } catch {
      // error-policy:J6 teardown — node already disconnected
    }
    analyser = null;
    try {
      source.disconnect();
    } catch {
      // error-policy:J6 teardown — node already disconnected
    }
    try {
      processor.disconnect();
    } catch {
      // error-policy:J6 teardown — node already disconnected
    }
    for (const track of stream.getTracks()) {
      track.stop();
    }
    // error-policy:J6 teardown — closing an already-closed context throws
    await context.close().catch(() => undefined);
  };

  return {
    get analyser() {
      return analyser;
    },
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
