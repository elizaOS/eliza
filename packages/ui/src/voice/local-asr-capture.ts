/**
 * Mic-capture recorder for local ASR: records mono PCM16, exposes a live analyser
 * for amplitude visualization, and stops/cancels the audio context cleanly.
 */
import { encodeMonoPcm16Wav } from "./pcm-wave";
import {
  createVoiceActivityDetector,
  DEFAULT_VOICE_ACTIVITY,
} from "./voice-activity";

export { encodeMonoPcm16Wav } from "./pcm-wave";

import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";
import { logger } from "../logger.ts";
import { voiceCaptureDebug } from "../utils/voice-capture-debug";
import {
  DEFAULT_POST_TTS_COOLDOWN_MS,
  isTtsEchoGateActive as sharedTtsEchoGateActive,
} from "./tts-playback-activity";
import { concatPcm } from "./voice-session-pcm";

export interface LocalAsrRecorder {
  stop(): Promise<Uint8Array>;
  cancel(): void;
  /**
   * Live analyser tapped off the same mic stream, for amplitude visualization.
   * `null` once the recorder has been stopped / cancelled (the context closes).
   */
  analyser: AnalyserNode | null;
  /** Browser-selected input identity returned by the live MediaStream track. */
  inputDevice: { deviceId: string; label: string };
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
  /** Exact browser media-device id for hardware acceptance lanes. */
  deviceId?: string;
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

interface NativeMicrophonePermissionState {
  status?: unknown;
  platform?: unknown;
}

/**
 * Maps the macOS app-process (TCC) microphone state reported by the Electrobun
 * permission bridge. Returns `null` when there is no desktop bridge, the host
 * is not macOS, or the reply is not a recognizable permission state, so the
 * caller falls back to the renderer Permissions API.
 */
function mapNativeMicrophonePermission(
  state: NativeMicrophonePermissionState | null,
): MicrophonePermissionState | null {
  if (state?.platform !== "darwin") return null;
  switch (state.status) {
    case "granted":
    case "limited":
      return "granted";
    case "denied":
    case "restricted":
      return "denied";
    case "not-determined":
      return "prompt";
    default:
      return null;
  }
}

async function invokeNativeMicrophonePermission(
  action: "check" | "request",
): Promise<MicrophonePermissionState | null> {
  try {
    const state =
      action === "check"
        ? await invokeDesktopBridgeRequest<NativeMicrophonePermissionState>({
            rpcMethod: "permissionsCheck",
            ipcChannel: "permissions:check",
            params: { id: "microphone", forceRefresh: true },
          })
        : await invokeDesktopBridgeRequest<NativeMicrophonePermissionState>({
            rpcMethod: "permissionsRequest",
            ipcChannel: "permissions:request",
            params: { id: "microphone" },
          });
    return mapNativeMicrophonePermission(state);
  } catch (err) {
    // The renderer Permissions API remains the fallback probe; keep the bridge
    // failure observable instead of reporting it as a permission state.
    logger.warn(
      { err, action },
      "[voice] desktop microphone permission bridge request failed",
    );
    return null;
  }
}

/**
 * Asks the macOS desktop host to request microphone access for the app process
 * (the same native request Settings → Permissions uses), so a first-use Talk in
 * chat presents the system prompt from the capture path itself. Returns `null`
 * outside a macOS Electrobun shell, where getUserMedia owns the prompt.
 */
export async function requestDesktopMicrophoneAccess(): Promise<MicrophonePermissionState | null> {
  return invokeNativeMicrophonePermission("request");
}

/**
 * Proactively read the microphone permission via
 * `navigator.permissions.query({ name: "microphone" })` without opening the
 * mic. Used to show a "re-enable mic" affordance on hands-free engage / boot
 * before `getUserMedia` reaches a revoked grant at capture time.
 *
 * Returns `"unknown"` (never throws) when the Permissions API is missing or
 * the `"microphone"` descriptor is unsupported (Safari/older iOS) — callers
 * treat unknown as "proceed normally", identical to `"prompt"`/`"granted"`.
 * On the macOS Electrobun shell the native (TCC) app grant is read first.
 */
export async function queryMicrophonePermission(): Promise<MicrophonePermissionState> {
  // In the macOS desktop shell the app-process grant is authoritative: the
  // WKWebView Permissions API describes the embedded page, can report
  // "denied" before any capture request reached the native media-permission
  // handler, and does not observe a grant made from the Settings window.
  const nativeState = await invokeNativeMicrophonePermission("check");
  if (nativeState) return nativeState;
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

function appendBoundedPcmFrame(
  chunks: Float32Array[],
  frame: Float32Array,
  maxSamples: number,
): void {
  if (maxSamples <= 0) return;

  chunks.push(frame);
  let retainedSamples = 0;
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index];
    if (!chunk) continue;
    const nextRetainedSamples = retainedSamples + chunk.length;
    if (nextRetainedSamples <= maxSamples) {
      retainedSamples = nextRetainedSamples;
      continue;
    }

    const keepFromChunk = maxSamples - retainedSamples;
    if (keepFromChunk > 0) {
      chunks[index] = chunk.slice(chunk.length - keepFromChunk);
      chunks.splice(0, index);
    } else {
      chunks.splice(0, index + 1);
    }
    return;
  }
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
export { POST_TTS_ECHO_THRESHOLD_MULTIPLIER } from "./voice-activity";

const AUTO_STOP_PRE_ROLL_MS = 200;
export const DEFAULT_LOCAL_ASR_AUTO_STOP = DEFAULT_VOICE_ACTIVITY;
export function createLocalAsrAutoStopDetector(
  options: LocalAsrAutoStopOptions | undefined,
  startedAtMs = nowMs(),
):
  | ((pcm: Float32Array, sampleTimeMs?: number) => LocalAsrAutoStopUpdate)
  | null {
  const detector = createVoiceActivityDetector(
    options
      ? {
          ...options,
          isTtsEchoGateActive:
            options.isTtsEchoGateActive ??
            ((at) =>
              sharedTtsEchoGateActive(
                at,
                options.postTtsCooldownMs ?? DEFAULT_POST_TTS_COOLDOWN_MS,
              )),
        }
      : undefined,
    startedAtMs,
    nowMs,
  );
  return detector ? (pcm, at) => detector(measurePcmAudio(pcm), at) : null;
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

  // getUserMedia round-trip: on iOS PWA this pops the native permission dialog.
  // Trace the request/resolve/reject so the on-screen HUD shows whether the
  // grant was denied (`gum:err(NotAllowedError)`) or resolved but the graph
  // then died (a later `ctx:suspended!`) — the two crickets modes look
  // identical without this split.
  voiceCaptureDebug("gum:req", {});
  const gumStartMs = nowMs();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // Gemma ASR ingests 16 kHz mono; request it at capture so the
        // browser resamples once instead of us downsampling a 48 kHz buffer.
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
      },
    });
  } catch (err) {
    voiceCaptureDebug("gum:err", {
      name: err instanceof Error ? err.name : "Error",
      reason:
        err instanceof Error
          ? err.message.slice(0, 80)
          : String(err).slice(0, 80),
    });
    throw err;
  }
  voiceCaptureDebug("gum:ok", {
    ms: Math.round(nowMs() - gumStartMs),
    // Defensive: some capture stubs expose only `getTracks`; never let a HUD
    // breadcrumb throw and break the capture it's meant to observe.
    tracks:
      typeof stream.getAudioTracks === "function"
        ? stream.getAudioTracks().length
        : typeof stream.getTracks === "function"
          ? stream.getTracks().length
          : undefined,
  });
  const inputTrack =
    typeof stream.getAudioTracks === "function"
      ? stream.getAudioTracks()[0]
      : stream.getTracks().find((track) => track.kind === "audio");
  const inputSettings = inputTrack?.getSettings?.() ?? {};
  const inputDevice = {
    deviceId:
      typeof inputSettings.deviceId === "string" ? inputSettings.deviceId : "",
    label: inputTrack?.label ?? "",
  };
  if (options.deviceId && inputDevice.deviceId !== options.deviceId) {
    for (const track of stream.getTracks()) track.stop();
    throw new Error(
      `Microphone device binding mismatch: requested ${options.deviceId}, ` +
        `selected ${inputDevice.deviceId || "<missing>"}`,
    );
  }
  const context = new AudioContextCtor();
  voiceCaptureDebug(
    context.state === "running" ? "ctx:running" : `ctx:${context.state}`,
    { state: context.state },
  );
  if (context.state === "suspended") {
    // A context that cannot resume produces silence (all-zero PCM → the WAV
    // reads as silent → a quiet no-op → the user sees crickets). Surface the
    // failure to the caller (voice-capture-factory setState("error")) instead
    // of recording a dead stream. Release the mic + context first so the failed
    // start does not leave the capture indicator on.
    //
    // iOS/WebKit quirk (#voice-crickets): `context.resume()` can RESOLVE while
    // `state` is still "suspended" — the resume is queued behind a user gesture
    // that the getUserMedia permission dialog interrupted. A single await
    // therefore isn't proof the graph is live; re-check the state and retry a
    // couple of times before giving up, so a context that just needed a beat to
    // actually resume after the dialog dismissed isn't misread as dead.
    const failResume = async (cause: unknown): Promise<never> => {
      // error-policy:J2 release the hot mic, then rethrow with context
      for (const track of stream.getTracks()) track.stop();
      // error-policy:J6 teardown — the context may already be closed
      await context.close().catch(() => undefined);
      throw new Error("AudioContext could not resume for local ASR capture", {
        cause,
      });
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await context.resume();
      } catch (err) {
        await failResume(err);
      }
      // resume() resolved — but on iOS it may not have actually taken effect.
      // Re-read the LIVE state: the `if (context.state === "suspended")` guard
      // above narrows the literal, but resume() can have flipped it to
      // "running". The cast widens the read back to the full union so the
      // comparison reflects the mutated value instead of the stale narrow.
      const liveState = context.state as AudioContextState;
      if (liveState !== "suspended") {
        voiceCaptureDebug("ctx:resumed", { state: liveState, attempt });
        break;
      }
      if (attempt === 2) {
        // The graph never resumed after the permission dialog — it will record
        // all-zero PCM → SILENT WAV → crickets. Mark it terminally (`!`).
        voiceCaptureDebug("ctx:suspended!", { state: liveState, attempt });
        await failResume(
          new Error("AudioContext stayed suspended after resume"),
        );
      }
      // Yield a frame so a gesture-queued resume can land before the re-check.
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  let analyser: AnalyserNode | null = context.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.8;
  source.connect(analyser);
  const chunks: Float32Array[] = [];
  const preRollChunks: Float32Array[] = [];
  const preRollMaxSamples = Math.round(
    (context.sampleRate * AUTO_STOP_PRE_ROLL_MS) / 1000,
  );
  let stopped = false;
  let autoStopRequested = false;
  let firstChunkTraced = false;
  const autoStopDetector = createLocalAsrAutoStopDetector(options.autoStop);
  let preRollPromoted = !autoStopDetector;

  processor.onaudioprocess = (event) => {
    if (stopped) return;
    const input = event.inputBuffer;
    // First real audio callback: proof the graph is actually delivering frames
    // (not a dead/suspended context that silently never fires onaudioprocess).
    if (!firstChunkTraced) {
      firstChunkTraced = true;
      voiceCaptureDebug("rec:data", { chunk: String(input.length) });
    }
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
      if (!preRollPromoted) {
        chunks.push(...preRollChunks);
        preRollChunks.length = 0;
        preRollPromoted = true;
      }
      chunks.push(mono);
    } else if (!preRollPromoted) {
      appendBoundedPcmFrame(preRollChunks, mono, preRollMaxSamples);
    }
    if (autoStopUpdate.shouldStop && !autoStopRequested && options.onAutoStop) {
      autoStopRequested = true;
      window.setTimeout(options.onAutoStop, 0);
    }
  };

  source.connect(processor);
  processor.connect(context.destination);

  const cleanup = async () => {
    if (stopped) return;
    stopped = true;
    preRollChunks.length = 0;
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
    inputDevice,
    get analyser() {
      return analyser;
    },
    async stop() {
      const sampleRate = context.sampleRate;
      await cleanup();
      const pcm = concatPcm(chunks);
      chunks.length = 0;
      if (pcm.length === 0) {
        throw new Error("No microphone audio was captured for local ASR");
      }
      return encodeMonoPcm16Wav(pcm, sampleRate);
    },
    cancel() {
      chunks.length = 0;
      preRollChunks.length = 0;
      void cleanup();
    },
  };
}
