import type { JsonValue } from "@elizaos/plugin-remote-manifest";

export type VoiceErrorCode =
  | "VOICE_COMPONENT_MISSING"
  | "VOICE_LOCAL_INFERENCE_UNAVAILABLE"
  | "VOICE_AUDIO_INPUT_UNAVAILABLE"
  | "VOICE_AUDIO_OUTPUT_UNAVAILABLE"
  | "VOICE_ASR_UNAVAILABLE"
  | "VOICE_TTS_UNAVAILABLE"
  | "VOICE_VAD_UNAVAILABLE"
  | "VOICE_PIPELINE_NOT_RUNNING"
  | "VOICE_TURN_NOT_FOUND"
  | "VOICE_REQUEST_FAILED"
  | "VOICE_UNKNOWN";

export class VoiceError extends Error {
  readonly code: VoiceErrorCode;
  readonly details?: JsonValue;

  constructor(code: VoiceErrorCode, message: string, details?: JsonValue) {
    super(message);
    this.name = "VoiceError";
    this.code = code;
    this.details = details;
  }

  toJSON(): JsonValue {
    return {
      code: this.code,
      message: this.message,
      details: this.details ?? null,
    };
  }
}

export function voiceErrorToJson(error: Error): JsonValue {
  if (error instanceof VoiceError) return error.toJSON();
  return {
    code: "VOICE_UNKNOWN",
    message: error.message,
  };
}
