/**
 * Bot-free meeting capture for browser/desktop renderers.
 *
 * Captures the local microphone and tab/system audio as separate PCM streams
 * when browser policy allows `getDisplayMedia({ audio: true })`. The caller
 * must invoke `startBotFreeMeetingAudioCapture()` from an explicit user action:
 * browsers intentionally prompt every display-audio capture request.
 */
import {
  encodeMonoPcm16Wav,
  measurePcmAudio,
  type PcmAudioStats,
} from "./local-asr-capture";

export const BOT_FREE_MEETING_AUDIO_SAMPLE_RATE = 16_000;
const PROCESSOR_BUFFER_SIZE = 4096;

type AudioContextConstructor = typeof AudioContext;

type WindowWithAudioContext = Window & {
  AudioContext?: AudioContextConstructor;
  webkitAudioContext?: AudioContextConstructor;
};

type DisplayAudioConstraints = MediaTrackConstraints & {
  systemAudio?: "include" | "exclude";
  windowAudio?: "exclude" | "window" | "system";
  suppressLocalAudioPlayback?: boolean;
};

type BotFreeDisplayMediaOptions = DisplayMediaStreamOptions & {
  audio?: boolean | DisplayAudioConstraints;
};

type MediaDevicesWithDisplayMedia = MediaDevices & {
  getDisplayMedia?: (
    constraints?: BotFreeDisplayMediaOptions,
  ) => Promise<MediaStream>;
};

export type BotFreeMeetingAudioSourceKind =
  | "local_mic"
  | "remote_tab_or_system"
  | "mixed_fallback";

export type BotFreeMeetingAudioSourceStatus =
  | "requested"
  | "capturing"
  | "captured"
  | "unavailable"
  | "denied"
  | "error";

export type BotFreeMeetingAudioCaptureMode =
  | "separate"
  | "mixed_fallback"
  | "local_only"
  | "remote_only"
  | "unavailable";

export interface BotFreeMeetingAudioSupport {
  audioContext: boolean;
  microphone: boolean;
  displayAudio: boolean;
  /** `null` outside browsers that expose the User Activation API. */
  userActivationActive: boolean | null;
}

export interface BotFreeMeetingAudioSourceMetadata {
  id: string;
  kind: BotFreeMeetingAudioSourceKind;
  label: string;
  status: BotFreeMeetingAudioSourceStatus;
  requested: boolean;
  audioTrackCount: number;
  videoTrackCount: number;
  channelCount: number;
  sampleRateHz: number;
  sampleCount: number;
  durationMs: number;
  peak: number;
  rms: number;
  syncOffsetMs?: number;
  displaySurface?: string;
  deviceId?: string;
  groupId?: string;
  errorName?: string;
  errorMessage?: string;
}

export interface BotFreeMeetingAudioArtifact {
  sourceId: string;
  kind: BotFreeMeetingAudioSourceKind;
  mimeType: "audio/wav";
  sampleRateHz: number;
  durationMs: number;
  byteLength: number;
  audio: Uint8Array;
  metadata: BotFreeMeetingAudioSourceMetadata;
}

export interface BotFreeMeetingAudioCaptureResult {
  mode: BotFreeMeetingAudioCaptureMode;
  startedAtUnixMs: number;
  endedAtUnixMs: number;
  durationMs: number;
  userActivationAtStart: boolean | null;
  sources: BotFreeMeetingAudioSourceMetadata[];
  artifacts: BotFreeMeetingAudioArtifact[];
}

export interface BotFreeMeetingAudioCaptureOptions {
  captureLocalMic?: boolean;
  captureRemoteAudio?: boolean;
  includeMixedFallbackArtifact?: boolean;
  stopDisplayVideoTracks?: boolean;
  localMicConstraints?: MediaTrackConstraints;
  remoteAudioConstraints?: DisplayAudioConstraints;
  now?: () => number;
}

export interface BotFreeMeetingAudioCaptureHandle {
  stop(): Promise<BotFreeMeetingAudioCaptureResult>;
  cancel(): void;
  snapshot(): BotFreeMeetingAudioSourceMetadata[];
}

export class BotFreeMeetingAudioCaptureError extends Error {
  readonly sources: BotFreeMeetingAudioSourceMetadata[];

  constructor(message: string, sources: BotFreeMeetingAudioSourceMetadata[]) {
    super(message);
    this.name = "BotFreeMeetingAudioCaptureError";
    this.sources = sources;
  }
}

export interface BotFreeMeetingCapturedPcm {
  sourceId: string;
  kind: Exclude<BotFreeMeetingAudioSourceKind, "mixed_fallback">;
  label: string;
  pcm: Float32Array;
  sampleRateHz: number;
  channelCount: number;
  firstFrameContextTime?: number;
  displaySurface?: string;
  deviceId?: string;
  groupId?: string;
}

interface SourceRecorder {
  metadata: BotFreeMeetingAudioSourceMetadata;
  stop(): BotFreeMeetingCapturedPcm;
  cancel(): void;
}

function getAudioContextCtor(): AudioContextConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  const win = window as WindowWithAudioContext;
  return win.AudioContext ?? win.webkitAudioContext;
}

function getMediaDevices(): MediaDevicesWithDisplayMedia | null {
  if (typeof navigator === "undefined") return null;
  return (navigator.mediaDevices ??
    null) as MediaDevicesWithDisplayMedia | null;
}

function currentUserActivation(): boolean | null {
  if (typeof navigator === "undefined") return null;
  const activation = navigator.userActivation;
  return activation ? activation.isActive : null;
}

function emptyMetadata(
  id: string,
  kind: BotFreeMeetingAudioSourceKind,
  label: string,
  status: BotFreeMeetingAudioSourceStatus,
  requested = true,
): BotFreeMeetingAudioSourceMetadata {
  return {
    id,
    kind,
    label,
    status,
    requested,
    audioTrackCount: 0,
    videoTrackCount: 0,
    channelCount: 0,
    sampleRateHz: BOT_FREE_MEETING_AUDIO_SAMPLE_RATE,
    sampleCount: 0,
    durationMs: 0,
    peak: 0,
    rms: 0,
  };
}

function captureErrorMetadata(
  id: string,
  kind: BotFreeMeetingAudioSourceKind,
  label: string,
  err: unknown,
): BotFreeMeetingAudioSourceMetadata {
  const domName =
    err instanceof DOMException
      ? err.name
      : err instanceof Error
        ? err.name
        : "";
  const status: BotFreeMeetingAudioSourceStatus =
    domName === "NotAllowedError" || domName === "SecurityError"
      ? "denied"
      : "error";
  const message = err instanceof Error ? err.message : String(err);
  return {
    ...emptyMetadata(id, kind, label, status),
    ...(domName ? { errorName: domName } : {}),
    errorMessage: message,
  };
}

function trackSetting(
  track: MediaStreamTrack | undefined,
  key: keyof MediaTrackSettings,
): string | undefined {
  if (!track) return undefined;
  const value = track.getSettings()[key];
  return typeof value === "string" ? value : undefined;
}

function displaySurface(
  track: MediaStreamTrack | undefined,
): string | undefined {
  if (!track) return undefined;
  const settings = track.getSettings() as MediaTrackSettings & {
    displaySurface?: string;
  };
  return settings.displaySurface;
}

export function getBotFreeMeetingAudioSupport(): BotFreeMeetingAudioSupport {
  const mediaDevices = getMediaDevices();
  return {
    audioContext: !!getAudioContextCtor(),
    microphone: typeof mediaDevices?.getUserMedia === "function",
    displayAudio: typeof mediaDevices?.getDisplayMedia === "function",
    userActivationActive: currentUserActivation(),
  };
}

export function classifyBotFreeMeetingAudioCaptureMode(
  sources: ReadonlyArray<BotFreeMeetingAudioSourceMetadata>,
): BotFreeMeetingAudioCaptureMode {
  const active = (kind: BotFreeMeetingAudioSourceKind): boolean =>
    sources.some(
      (source) =>
        source.kind === kind &&
        (source.status === "capturing" || source.status === "captured") &&
        source.sampleCount > 0,
    );

  const local = active("local_mic");
  const remote = active("remote_tab_or_system");
  const mixed = active("mixed_fallback");
  if (local && remote) return "separate";
  if (mixed) return "mixed_fallback";
  if (local) return "local_only";
  if (remote) return "remote_only";
  return "unavailable";
}

export function mixBotFreeMeetingPcm(
  sources: ReadonlyArray<Float32Array>,
): Float32Array {
  const maxLength = sources.reduce(
    (max, source) => Math.max(max, source.length),
    0,
  );
  const mixed = new Float32Array(maxLength);
  for (const source of sources) {
    for (let index = 0; index < source.length; index += 1) {
      const sum = mixed[index] + source[index];
      mixed[index] = Math.max(-1, Math.min(1, sum));
    }
  }
  return mixed;
}

export function buildBotFreeMeetingAudioArtifacts(
  captured: ReadonlyArray<BotFreeMeetingCapturedPcm>,
  includeMixedFallbackArtifact = true,
): BotFreeMeetingAudioArtifact[] {
  const capturedWithAudio = captured.filter((source) => source.pcm.length > 0);
  const artifacts: BotFreeMeetingAudioArtifact[] = capturedWithAudio.map(
    (source) => {
      const metadata = capturedMetadata(source, "captured");
      const audio = encodeMonoPcm16Wav(source.pcm, source.sampleRateHz);
      return {
        sourceId: source.sourceId,
        kind: source.kind,
        mimeType: "audio/wav" as const,
        sampleRateHz: source.sampleRateHz,
        durationMs: metadata.durationMs,
        byteLength: audio.byteLength,
        audio,
        metadata,
      };
    },
  );

  if (includeMixedFallbackArtifact && capturedWithAudio.length > 1) {
    const sampleRateHz =
      capturedWithAudio[0]?.sampleRateHz ?? BOT_FREE_MEETING_AUDIO_SAMPLE_RATE;
    const mixed = mixBotFreeMeetingPcm(
      capturedWithAudio.map((source) => source.pcm),
    );
    const stats = measurePcmAudio(mixed);
    const durationMs = Math.round((mixed.length / sampleRateHz) * 1000);
    const metadata: BotFreeMeetingAudioSourceMetadata = {
      ...emptyMetadata(
        "mixed-fallback",
        "mixed_fallback",
        "Mixed local + remote fallback",
        "captured",
      ),
      audioTrackCount: capturedWithAudio.length,
      channelCount: 1,
      sampleRateHz,
      sampleCount: mixed.length,
      durationMs,
      ...stats,
    };
    const audio = encodeMonoPcm16Wav(mixed, sampleRateHz);
    artifacts.push({
      sourceId: metadata.id,
      kind: "mixed_fallback",
      mimeType: "audio/wav",
      sampleRateHz,
      durationMs,
      byteLength: audio.byteLength,
      audio,
      metadata,
    });
  }

  return artifacts;
}

function capturedMetadata(
  source: BotFreeMeetingCapturedPcm,
  status: BotFreeMeetingAudioSourceStatus,
): BotFreeMeetingAudioSourceMetadata {
  const stats: PcmAudioStats = measurePcmAudio(source.pcm);
  const durationMs = Math.round(
    (source.pcm.length / source.sampleRateHz) * 1000,
  );
  return {
    ...emptyMetadata(source.sourceId, source.kind, source.label, status),
    audioTrackCount: 1,
    channelCount: source.channelCount,
    sampleRateHz: source.sampleRateHz,
    sampleCount: source.pcm.length,
    durationMs,
    ...stats,
    ...(source.displaySurface ? { displaySurface: source.displaySurface } : {}),
    ...(source.deviceId ? { deviceId: source.deviceId } : {}),
    ...(source.groupId ? { groupId: source.groupId } : {}),
  };
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

function ignoreAudioGraphTeardownError(_err: unknown): void {
  // WebAudio nodes may already be disconnected when a track ends during stop().
}

function createSourceRecorder(
  context: AudioContext,
  stream: MediaStream,
  sourceId: string,
  kind: Exclude<BotFreeMeetingAudioSourceKind, "mixed_fallback">,
  label: string,
): SourceRecorder {
  const audioTracks = stream.getAudioTracks();
  const videoTracks = stream.getVideoTracks();
  const primaryAudio = audioTracks[0];
  const primaryVideo = videoTracks[0];
  const chunks: Float32Array[] = [];
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 2, 1);
  const gain = context.createGain();
  gain.gain.value = 0;

  let channelCount = primaryAudio?.getSettings().channelCount ?? 1;
  let firstFrameContextTime: number | undefined;
  let sumSquares = 0;
  let peak = 0;
  let stopped = false;

  const metadata: BotFreeMeetingAudioSourceMetadata = {
    ...emptyMetadata(sourceId, kind, label, "capturing"),
    audioTrackCount: audioTracks.length,
    videoTrackCount: videoTracks.length,
    channelCount,
    sampleRateHz: context.sampleRate,
    ...(displaySurface(primaryVideo)
      ? { displaySurface: displaySurface(primaryVideo) }
      : {}),
    ...(trackSetting(primaryAudio, "deviceId")
      ? { deviceId: trackSetting(primaryAudio, "deviceId") }
      : {}),
    ...(trackSetting(primaryAudio, "groupId")
      ? { groupId: trackSetting(primaryAudio, "groupId") }
      : {}),
  };

  processor.onaudioprocess = (event: AudioProcessingEvent) => {
    if (stopped) return;
    const input = event.inputBuffer;
    const frameCount = input.length;
    channelCount = Math.max(1, input.numberOfChannels);
    if (firstFrameContextTime === undefined) {
      firstFrameContextTime = event.playbackTime;
    }
    const mono = new Float32Array(frameCount);
    for (let channel = 0; channel < channelCount; channel += 1) {
      const data = input.getChannelData(channel);
      for (let index = 0; index < frameCount; index += 1) {
        mono[index] += (data[index] ?? 0) / channelCount;
      }
    }
    chunks.push(mono);
    for (const sample of mono) {
      const value = Number.isFinite(sample) ? sample : 0;
      const abs = Math.abs(value);
      sumSquares += value * value;
      if (abs > peak) peak = abs;
    }
    metadata.channelCount = channelCount;
    metadata.sampleCount += mono.length;
    metadata.durationMs = Math.round(
      (metadata.sampleCount / context.sampleRate) * 1000,
    );
    metadata.rms =
      metadata.sampleCount > 0
        ? Math.sqrt(sumSquares / metadata.sampleCount)
        : 0;
    metadata.peak = peak;
  };

  source.connect(processor);
  processor.connect(gain);
  gain.connect(context.destination);

  const disconnect = () => {
    stopped = true;
    processor.onaudioprocess = null;
    try {
      source.disconnect();
    } catch (err) {
      ignoreAudioGraphTeardownError(err);
    }
    try {
      processor.disconnect();
    } catch (err) {
      ignoreAudioGraphTeardownError(err);
    }
    try {
      gain.disconnect();
    } catch (err) {
      ignoreAudioGraphTeardownError(err);
    }
    for (const track of stream.getTracks()) {
      track.stop();
    }
  };

  return {
    metadata,
    stop() {
      disconnect();
      const pcm = concatPcm(chunks);
      return {
        sourceId,
        kind,
        label,
        pcm,
        sampleRateHz: context.sampleRate,
        channelCount,
        ...(firstFrameContextTime !== undefined
          ? { firstFrameContextTime }
          : {}),
        ...(metadata.displaySurface
          ? { displaySurface: metadata.displaySurface }
          : {}),
        ...(metadata.deviceId ? { deviceId: metadata.deviceId } : {}),
        ...(metadata.groupId ? { groupId: metadata.groupId } : {}),
      };
    },
    cancel: disconnect,
  };
}

async function openLocalMic(
  devices: MediaDevicesWithDisplayMedia,
  constraints?: MediaTrackConstraints,
): Promise<MediaStream> {
  return devices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: BOT_FREE_MEETING_AUDIO_SAMPLE_RATE,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...constraints,
    },
    video: false,
  });
}

async function openRemoteDisplayAudio(
  devices: MediaDevicesWithDisplayMedia,
  constraints?: DisplayAudioConstraints,
): Promise<MediaStream> {
  if (typeof devices.getDisplayMedia !== "function") {
    throw new Error("Display audio capture is not available in this renderer");
  }
  return devices.getDisplayMedia({
    audio: {
      channelCount: 2,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      systemAudio: "include",
      windowAudio: "system",
      suppressLocalAudioPlayback: false,
      ...constraints,
    },
    video: true,
  });
}

export async function startBotFreeMeetingAudioCapture(
  options: BotFreeMeetingAudioCaptureOptions = {},
): Promise<BotFreeMeetingAudioCaptureHandle> {
  const AudioContextCtor = getAudioContextCtor();
  if (!AudioContextCtor) {
    throw new BotFreeMeetingAudioCaptureError(
      "AudioContext is not available for bot-free meeting capture",
      [],
    );
  }
  const devices = getMediaDevices();
  if (!devices) {
    throw new BotFreeMeetingAudioCaptureError(
      "Media devices are not available for bot-free meeting capture",
      [],
    );
  }

  const captureLocalMic = options.captureLocalMic ?? true;
  const captureRemoteAudio = options.captureRemoteAudio ?? true;
  const includeMixedFallbackArtifact =
    options.includeMixedFallbackArtifact ?? true;
  const stopDisplayVideoTracks = options.stopDisplayVideoTracks ?? true;
  const now = options.now ?? Date.now;
  const userActivationAtStart = currentUserActivation();
  const startedAtUnixMs = now();
  const context = new AudioContextCtor({
    sampleRate: BOT_FREE_MEETING_AUDIO_SAMPLE_RATE,
  });
  if (context.state === "suspended") {
    await context.resume().catch(() => {});
  }

  const recorders: SourceRecorder[] = [];
  const sourceMetadata: BotFreeMeetingAudioSourceMetadata[] = [];

  if (captureRemoteAudio) {
    try {
      const stream = await openRemoteDisplayAudio(
        devices,
        options.remoteAudioConstraints,
      );
      if (stopDisplayVideoTracks) {
        for (const track of stream.getVideoTracks()) {
          track.stop();
        }
      }
      if (stream.getAudioTracks().length === 0) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        sourceMetadata.push({
          ...emptyMetadata(
            "remote-tab-or-system",
            "remote_tab_or_system",
            "Tab/system audio",
            "unavailable",
          ),
          videoTrackCount: stream.getVideoTracks().length,
          errorMessage:
            "The selected display surface did not expose an audio track.",
        });
      } else {
        const recorder = createSourceRecorder(
          context,
          stream,
          "remote-tab-or-system",
          "remote_tab_or_system",
          "Tab/system audio",
        );
        recorders.push(recorder);
        sourceMetadata.push(recorder.metadata);
      }
    } catch (err) {
      sourceMetadata.push(
        captureErrorMetadata(
          "remote-tab-or-system",
          "remote_tab_or_system",
          "Tab/system audio",
          err,
        ),
      );
    }
  }

  if (captureLocalMic) {
    try {
      const stream = await openLocalMic(devices, options.localMicConstraints);
      const recorder = createSourceRecorder(
        context,
        stream,
        "local-mic",
        "local_mic",
        "Local microphone",
      );
      recorders.push(recorder);
      sourceMetadata.push(recorder.metadata);
    } catch (err) {
      sourceMetadata.push(
        captureErrorMetadata("local-mic", "local_mic", "Local microphone", err),
      );
    }
  }

  if (recorders.length === 0) {
    await context.close().catch(() => {});
    throw new BotFreeMeetingAudioCaptureError(
      "No meeting audio source could be captured",
      sourceMetadata,
    );
  }

  let stopped = false;
  let cachedResult: BotFreeMeetingAudioCaptureResult | null = null;

  const stop = async (): Promise<BotFreeMeetingAudioCaptureResult> => {
    if (cachedResult) return cachedResult;
    stopped = true;
    const captured = recorders.map((recorder) => recorder.stop());
    await context.close().catch(() => {});
    const artifacts = buildBotFreeMeetingAudioArtifacts(
      captured,
      includeMixedFallbackArtifact,
    );
    const artifactMetadata = artifacts.map((artifact) => artifact.metadata);
    const endedAtUnixMs = now();
    const sources = [
      ...sourceMetadata.filter(
        (source) =>
          !artifactMetadata.some((artifact) => artifact.id === source.id),
      ),
      ...artifactMetadata,
    ];
    const remoteFirst = captured.find(
      (source) => source.kind === "remote_tab_or_system",
    )?.firstFrameContextTime;
    const localFirst = captured.find(
      (source) => source.kind === "local_mic",
    )?.firstFrameContextTime;
    if (remoteFirst !== undefined && localFirst !== undefined) {
      const syncOffsetMs = Math.round((localFirst - remoteFirst) * 1000);
      for (const source of sources) {
        if (
          source.kind === "local_mic" ||
          source.kind === "remote_tab_or_system"
        ) {
          source.syncOffsetMs = syncOffsetMs;
        }
      }
    }
    cachedResult = {
      mode: classifyBotFreeMeetingAudioCaptureMode(sources),
      startedAtUnixMs,
      endedAtUnixMs,
      durationMs: Math.max(0, endedAtUnixMs - startedAtUnixMs),
      userActivationAtStart,
      sources,
      artifacts,
    };
    return cachedResult;
  };

  const cancel = (): void => {
    if (stopped) return;
    stopped = true;
    for (const recorder of recorders) {
      recorder.cancel();
    }
    void context.close().catch(() => {});
  };

  return {
    stop,
    cancel,
    snapshot: () => sourceMetadata.map((source) => ({ ...source })),
  };
}
