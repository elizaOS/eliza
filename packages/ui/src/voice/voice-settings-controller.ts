/**
 * Coordinates the device-local mirrors shared by full-shell and Cloud voice
 * settings while leaving each surface's remote persistence policy independent.
 */

import {
  saveContinuousChatMode,
  saveOsIntentAutoStartConsent,
  saveVadAutoStop,
} from "../state/persistence";
import type { VoiceContinuousMode } from "./voice-chat-types";

export interface VoiceDeviceSettings {
  continuous: VoiceContinuousMode;
  osIntentAutoStartVoice: boolean;
  osIntentAutoStartTranscription: boolean;
  vadAutoStop?: {
    silenceMs: number;
    speechRmsThreshold: number;
  };
}

export interface VoiceSettingsController {
  applyDeviceSettings(settings: VoiceDeviceSettings): void;
}

/** Create the shared controller used by every voice-settings host. */
export function createVoiceSettingsController(): VoiceSettingsController {
  return {
    applyDeviceSettings(settings) {
      if (settings.vadAutoStop) saveVadAutoStop(settings.vadAutoStop);
      saveContinuousChatMode(settings.continuous);
      saveOsIntentAutoStartConsent({
        voice: settings.osIntentAutoStartVoice,
        transcription: settings.osIntentAutoStartTranscription,
      });
    },
  };
}

export const voiceSettingsController = createVoiceSettingsController();
