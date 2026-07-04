/**
 * Default voice-preference values for VoiceSection: continuous-chat mode and the
 * VAD auto-stop thresholds, sourced from the voice capture defaults so the
 * settings UI and the capture pipeline agree.
 */

import { DEFAULT_LOCAL_ASR_AUTO_STOP } from "../../voice/local-asr-capture";
import { DEFAULT_VOICE_CONTINUOUS_MODE } from "../../voice/voice-chat-types";
import type { VadAutoStopPrefs, VoiceSectionPrefs } from "./VoiceSection";

export const DEFAULT_VAD_AUTO_STOP_PREFS: VadAutoStopPrefs = {
  silenceMs: DEFAULT_LOCAL_ASR_AUTO_STOP.silenceMs,
  speechRmsThreshold: DEFAULT_LOCAL_ASR_AUTO_STOP.speechRmsThreshold,
};

export const DEFAULT_VOICE_SECTION_PREFS: VoiceSectionPrefs = {
  continuous: DEFAULT_VOICE_CONTINUOUS_MODE,
  vadAutoStop: DEFAULT_VAD_AUTO_STOP_PREFS,
};
