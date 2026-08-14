/** Content-free browser media diagnostics for realtime voice evaluation. */

import type {
  VoiceGrantedCaptureSettings,
  VoiceRequestedCaptureSettings,
} from "@elizaos/shared";

export type VoiceBrowserAudioBackend = "audioworklet" | "scriptprocessor";

export interface VoiceCaptureDiagnostics {
  readonly backend: VoiceBrowserAudioBackend;
  readonly frameDurationMs: number;
  readonly audioContextSampleRateHz: number;
  readonly requested: VoiceRequestedCaptureSettings;
  readonly granted: VoiceGrantedCaptureSettings;
}

export interface VoicePlaybackDiagnostics {
  readonly backend: VoiceBrowserAudioBackend;
  readonly requestedSampleRateHz: number;
  readonly actualSampleRateHz: number;
  readonly sampleRateConversion: "not_required" | "streaming_linear";
}

interface VoiceSessionClientDiagnosticBase {
  readonly atMs: number;
  readonly traceId: string | null;
}

export type VoiceSessionClientDiagnosticEvent =
  | (VoiceSessionClientDiagnosticBase & {
      readonly type: "capture_ready";
      readonly capture: VoiceCaptureDiagnostics;
    })
  | (VoiceSessionClientDiagnosticBase & {
      readonly type: "playback_ready";
      readonly playback: VoicePlaybackDiagnostics;
    })
  | (VoiceSessionClientDiagnosticBase & {
      readonly type: "playback_started" | "playback_drained";
      readonly sequence: number;
    });

function positiveNumberOrUnknown(value: unknown): number | "unknown" {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : "unknown";
}

function booleanOrUnknown(value: unknown): boolean | "unknown" {
  return typeof value === "boolean" ? value : "unknown";
}

/**
 * Copies only evaluation-safe constraint fields. Device ids, group ids,
 * labels, and any vendor-specific settings are deliberately excluded.
 */
export function redactGrantedVoiceCaptureSettings(
  settings: MediaTrackSettings | undefined,
): VoiceGrantedCaptureSettings {
  return {
    sampleRateHz: positiveNumberOrUnknown(settings?.sampleRate),
    channelCount: positiveNumberOrUnknown(settings?.channelCount),
    echoCancellation: booleanOrUnknown(settings?.echoCancellation),
    noiseSuppression: booleanOrUnknown(settings?.noiseSuppression),
    autoGainControl: booleanOrUnknown(settings?.autoGainControl),
  };
}
