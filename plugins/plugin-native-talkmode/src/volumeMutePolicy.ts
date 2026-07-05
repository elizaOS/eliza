/**
 * Headless TalkMode audio policy for the boundary between input capture and
 * platform output mute/volume state. Native implementations still own real
 * audio routing; this module gives UI and tests one deterministic contract for
 * whether capture, indicators, and in-flight TTS should continue under mute.
 */

export type TalkModeAudioPlatform =
  | "ios"
  | "android"
  | "electrobun"
  | "browser";

export type TalkModeCaptureIndicator = "recording" | "idle";

export type TalkModeTtsAudibility =
  | "audible"
  | "silent-by-output-policy"
  | "not-speaking";

export type TalkModeTtsProgressPolicy = "continue";

export type TalkModeTtsOutputChannel =
  | "ios-play-and-record-voice-chat"
  | "android-voice-communication"
  | "desktop-system-output"
  | "browser-speech-synthesis-output";

export interface VolumeMutePolicy {
  platform: TalkModeAudioPlatform;
  /** Voice capture is input-side state and does not stop because output is muted or at volume 0. */
  captureContinuesWhenOutputMuted: true;
  /** UI affordance to keep showing while capture stays live under ringer/media mute. */
  captureIndicatorWhenOutputMuted: "recording";
  /** TTS follows the platform output lane listed here instead of inventing an app-local mute lane. */
  ttsOutputChannel: TalkModeTtsOutputChannel;
  /** Muting or setting output volume to 0 makes TTS inaudible but does not pause or cancel playback. */
  ttsProgressWhenOutputMuted: TalkModeTtsProgressPolicy;
  /** Hardware/device validation is required because simulators and headless tests cannot prove real audio routing. */
  requiresDeviceAudioVerification: boolean;
}

export interface TalkModeAudioState {
  captureActive: boolean;
  captureIndicator: TalkModeCaptureIndicator;
  ttsUtteranceId: string | null;
  ttsProgress: TalkModeTtsProgressPolicy | "idle";
  ttsAudibility: TalkModeTtsAudibility;
  outputMuted: boolean;
  outputVolume: number;
}

export type TalkModeAudioPolicyEvent =
  | { type: "capture-started" }
  | { type: "capture-stopped" }
  | { type: "tts-started"; utteranceId: string }
  | { type: "tts-finished"; utteranceId: string }
  | { type: "output-mute-changed"; muted: boolean }
  | { type: "output-volume-changed"; volume: number };

const TTS_OUTPUT_CHANNEL_BY_PLATFORM = {
  ios: "ios-play-and-record-voice-chat",
  android: "android-voice-communication",
  electrobun: "desktop-system-output",
  browser: "browser-speech-synthesis-output",
} as const satisfies Record<TalkModeAudioPlatform, TalkModeTtsOutputChannel>;

export function getVolumeMutePolicy(
  platform: TalkModeAudioPlatform,
): VolumeMutePolicy {
  return {
    platform,
    captureContinuesWhenOutputMuted: true,
    captureIndicatorWhenOutputMuted: "recording",
    ttsOutputChannel: TTS_OUTPUT_CHANNEL_BY_PLATFORM[platform],
    ttsProgressWhenOutputMuted: "continue",
    requiresDeviceAudioVerification: platform !== "browser",
  };
}

export function createTalkModeAudioState(options?: {
  outputMuted?: boolean;
  outputVolume?: number;
}): TalkModeAudioState {
  const outputMuted = options?.outputMuted ?? false;
  const outputVolume = normalizeOutputVolume(options?.outputVolume ?? 1);

  return deriveTalkModeAudioState({
    captureActive: false,
    captureIndicator: "idle",
    ttsUtteranceId: null,
    ttsProgress: "idle",
    ttsAudibility: "not-speaking",
    outputMuted,
    outputVolume,
  });
}

export function reduceTalkModeAudioPolicy(
  state: TalkModeAudioState,
  event: TalkModeAudioPolicyEvent,
): TalkModeAudioState {
  switch (event.type) {
    case "capture-started":
      return deriveTalkModeAudioState({
        ...state,
        captureActive: true,
        captureIndicator: "recording",
      });
    case "capture-stopped":
      return deriveTalkModeAudioState({
        ...state,
        captureActive: false,
        captureIndicator: "idle",
      });
    case "tts-started":
      return deriveTalkModeAudioState({
        ...state,
        ttsUtteranceId: event.utteranceId,
        ttsProgress: "continue",
      });
    case "tts-finished":
      if (event.utteranceId !== state.ttsUtteranceId) {
        return state;
      }
      return deriveTalkModeAudioState({
        ...state,
        ttsUtteranceId: null,
        ttsProgress: "idle",
      });
    case "output-mute-changed":
      return deriveTalkModeAudioState({
        ...state,
        outputMuted: event.muted,
      });
    case "output-volume-changed":
      return deriveTalkModeAudioState({
        ...state,
        outputVolume: normalizeOutputVolume(event.volume),
      });
  }
}

function deriveTalkModeAudioState(
  state: TalkModeAudioState,
): TalkModeAudioState {
  const ttsAudibility = getTtsAudibility(state);
  const captureIndicator = state.captureActive ? "recording" : "idle";
  const ttsProgress = state.ttsUtteranceId ? "continue" : "idle";

  return {
    ...state,
    captureIndicator,
    ttsProgress,
    ttsAudibility,
  };
}

function getTtsAudibility(state: TalkModeAudioState): TalkModeTtsAudibility {
  if (!state.ttsUtteranceId) {
    return "not-speaking";
  }
  if (state.outputMuted || state.outputVolume === 0) {
    return "silent-by-output-policy";
  }
  return "audible";
}

function normalizeOutputVolume(volume: number): number {
  if (!Number.isFinite(volume)) {
    return 1;
  }
  return Math.min(1, Math.max(0, volume));
}
