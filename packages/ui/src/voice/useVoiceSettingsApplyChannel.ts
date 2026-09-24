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
} from "@elizaos/shared";
import { useViewEvent } from "../hooks/useViewEvent";
import {
  loadOsIntentAutoStartConsent,
  saveContinuousChatMode,
  saveOsIntentAutoStartConsent,
  saveVadAutoStop,
} from "../state/persistence";
import { readContinuousMode, readVadAutoStop } from "./voice-settings-payload";

export type { VoiceSettingsApplyPayload } from "@elizaos/shared";
export { VOICE_SETTINGS_APPLY_EVENT };

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
