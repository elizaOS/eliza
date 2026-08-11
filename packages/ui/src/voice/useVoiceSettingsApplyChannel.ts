/**
 * Always-mounted bridge for chat-driven voice preferences.
 *
 * The SETTINGS voice twin persists `messages.voice` through `/api/config`, but
 * the capture hot path (useShellController.startCapture) and ChatView read the
 * localStorage mirrors (loadVadAutoStop / loadContinuousChatMode) that
 * VoiceSectionMount seeds — never the config blob, and only on its own mount.
 * This hook subscribes to the `voice-settings:apply` broadcast the action emits
 * after a successful config write and re-seeds those same mirrors, so a
 * chat-driven change reaches the running shell without a Settings → Voice
 * remount or an app reload. It is the voice twin of useAppearanceApplyChannel.
 *
 * Payload fields are validated before they touch the mirrors: a crafted or
 * partial broadcast can only ever write a known continuous mode or a fully
 * numeric VAD pair, never a malformed value into the capture path.
 */

import {
  VOICE_SETTINGS_APPLY_EVENT,
  type VoiceSettingsApplyPayload,
} from "@elizaos/shared/events";
import { useViewEvent } from "../hooks/useViewEvent";
import {
  loadOsIntentAutoStartConsent,
  saveContinuousChatMode,
  saveOsIntentAutoStartConsent,
  saveVadAutoStop,
  type VadAutoStopValue,
} from "../state/persistence";
import {
  VOICE_CONTINUOUS_MODES,
  type VoiceContinuousMode,
} from "./voice-chat-types";

export type { VoiceSettingsApplyPayload } from "@elizaos/shared/events";
export { VOICE_SETTINGS_APPLY_EVENT };

function readContinuousMode(value: unknown): VoiceContinuousMode | null {
  return typeof value === "string" &&
    VOICE_CONTINUOUS_MODES.includes(value as VoiceContinuousMode)
    ? (value as VoiceContinuousMode)
    : null;
}

function readVadAutoStop(value: unknown): VadAutoStopValue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { silenceMs, speechRmsThreshold } = value as Record<string, unknown>;
  if (
    typeof silenceMs !== "number" ||
    !Number.isFinite(silenceMs) ||
    typeof speechRmsThreshold !== "number" ||
    !Number.isFinite(speechRmsThreshold)
  ) {
    return null;
  }
  return { silenceMs, speechRmsThreshold };
}

export function useVoiceSettingsApplyChannel(): void {
  useViewEvent(VOICE_SETTINGS_APPLY_EVENT, (event) => {
    const payload = event.payload as VoiceSettingsApplyPayload;

    const continuous = readContinuousMode(payload.continuous);
    if (continuous) saveContinuousChatMode(continuous);

    const vadAutoStop = readVadAutoStop(payload.vadAutoStop);
    if (vadAutoStop) saveVadAutoStop(vadAutoStop);

    if (
      typeof payload.osIntentAutoStartVoice === "boolean" ||
      typeof payload.osIntentAutoStartTranscription === "boolean"
    ) {
      const current = loadOsIntentAutoStartConsent();
      saveOsIntentAutoStartConsent({
        voice:
          typeof payload.osIntentAutoStartVoice === "boolean"
            ? payload.osIntentAutoStartVoice
            : current.voice,
        transcription:
          typeof payload.osIntentAutoStartTranscription === "boolean"
            ? payload.osIntentAutoStartTranscription
            : current.transcription,
      });
    }
  });
}
