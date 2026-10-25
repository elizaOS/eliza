/** Validates voice preference broadcast fields shared by the shell and mounted settings projection. Invalid or absent fields retain the current value. */
import type { VadAutoStopValue } from "../state/persistence";
import {
  VOICE_CONTINUOUS_MODES,
  type VoiceContinuousMode,
} from "./voice-chat-types";

export function readContinuousMode(value: unknown): VoiceContinuousMode | null {
  return typeof value === "string" &&
    VOICE_CONTINUOUS_MODES.includes(value as VoiceContinuousMode)
    ? (value as VoiceContinuousMode)
    : null;
}

export function readVadAutoStop(value: unknown): VadAutoStopValue | null {
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
