import type { JsonValue } from "@elizaos/electrobun-carrots";
import { VoiceError } from "./errors";
import type { VoiceService } from "./voice-service";
import {
  VOICE_TEST_MODES,
  type VoiceInjectTranscriptParams,
  type VoiceInterruptParams,
  type VoiceSpeakParams,
  type VoiceStartParams,
  type VoiceStopParams,
  type VoiceSynthesizeSpeechParams,
  type VoiceTestMode,
  type VoiceTranscribeAudioParams,
} from "./types";

type JsonRecord = { readonly [key: string]: JsonValue };

export interface VoiceHost {
  status(): Promise<JsonValue>;
  components(): Promise<JsonValue>;
  start(params: JsonValue | undefined): Promise<JsonValue>;
  stop(params: JsonValue | undefined): Promise<JsonValue>;
  interrupt(params: JsonValue | undefined): Promise<JsonValue>;
  injectTranscript(params: JsonValue | undefined): Promise<JsonValue>;
  speak(params: JsonValue | undefined): Promise<JsonValue>;
  transcribeAudio(params: JsonValue | undefined): Promise<JsonValue>;
  synthesizeSpeech(params: JsonValue | undefined): Promise<JsonValue>;
  latency(): Promise<JsonValue>;
  recentTurns(params: JsonValue | undefined): Promise<JsonValue>;
}

function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function requireRecord(
  value: JsonValue | undefined,
  method: string,
): JsonRecord {
  if (!isJsonRecord(value)) {
    throw new VoiceError(
      "VOICE_REQUEST_FAILED",
      `${method}: expected params object.`,
    );
  }
  return value;
}

function optionalRecord(
  value: JsonValue | undefined,
  method: string,
): JsonRecord | undefined {
  if (value === undefined) return undefined;
  return requireRecord(value, method);
}

function readOptionalString(
  record: JsonRecord | undefined,
  key: string,
  method: string,
): string | undefined {
  if (!record) return undefined;
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new VoiceError(
      "VOICE_REQUEST_FAILED",
      `${method}: ${key} must be a non-empty string.`,
    );
  }
  return value.trim();
}

function readString(record: JsonRecord, key: string, method: string): string {
  const value = readOptionalString(record, key, method);
  if (!value) {
    throw new VoiceError(
      "VOICE_REQUEST_FAILED",
      `${method}: ${key} must be a non-empty string.`,
    );
  }
  return value;
}

function readOptionalBoolean(
  record: JsonRecord | undefined,
  key: string,
): boolean | undefined {
  if (!record) return undefined;
  const value = record[key];
  if (value === undefined) return undefined;
  return value === true;
}

function readOptionalNumber(
  record: JsonRecord | undefined,
  key: string,
  method: string,
): number | undefined {
  if (!record) return undefined;
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new VoiceError(
      "VOICE_REQUEST_FAILED",
      `${method}: ${key} must be a finite number.`,
    );
  }
  return value;
}

function readMetadata(
  record: JsonRecord | undefined,
  key: string,
  method: string,
): Record<string, JsonValue> | undefined {
  if (!record) return undefined;
  const value = record[key];
  if (value === undefined) return undefined;
  if (!isJsonRecord(value)) {
    throw new VoiceError(
      "VOICE_REQUEST_FAILED",
      `${method}: ${key} must be an object.`,
    );
  }
  return { ...value };
}

function readMode(
  record: JsonRecord | undefined,
  method: string,
): VoiceTestMode | undefined {
  const value = readOptionalString(record, "mode", method);
  if (value === undefined) return undefined;
  const mode = VOICE_TEST_MODES.find((candidate) => candidate === value);
  if (!mode) {
    throw new VoiceError(
      "VOICE_REQUEST_FAILED",
      `${method}: unsupported mode ${value}.`,
    );
  }
  return mode;
}

function readStartParams(params: JsonValue | undefined): VoiceStartParams {
  const record = optionalRecord(params, "voice-start");
  return {
    mode: readMode(record, "voice-start"),
    asrProvider: readOptionalString(record, "asrProvider", "voice-start"),
    ttsProvider: readOptionalString(record, "ttsProvider", "voice-start"),
    vadProvider: readOptionalString(record, "vadProvider", "voice-start"),
    voiceId: readOptionalString(record, "voiceId", "voice-start"),
    trace: readOptionalBoolean(record, "trace"),
    autoOpenTraceView: readOptionalBoolean(record, "autoOpenTraceView"),
    metadata: readMetadata(record, "metadata", "voice-start"),
  };
}

function readStopParams(params: JsonValue | undefined): VoiceStopParams {
  const record = optionalRecord(params, "voice-stop");
  return {
    reason: readOptionalString(record, "reason", "voice-stop"),
  };
}

function readInterruptParams(
  params: JsonValue | undefined,
): VoiceInterruptParams {
  const record = optionalRecord(params, "voice-interrupt");
  return {
    reason: readOptionalString(record, "reason", "voice-interrupt"),
  };
}

function readInjectParams(
  params: JsonValue | undefined,
): VoiceInjectTranscriptParams {
  const record = requireRecord(params, "voice-inject-transcript");
  return {
    text: readString(record, "text", "voice-inject-transcript"),
    final: readOptionalBoolean(record, "final"),
    trace: readOptionalBoolean(record, "trace"),
  };
}

function readSpeakParams(params: JsonValue | undefined): VoiceSpeakParams {
  const record = requireRecord(params, "voice-speak");
  return {
    text: readString(record, "text", "voice-speak"),
    voiceId: readOptionalString(record, "voiceId", "voice-speak"),
    trace: readOptionalBoolean(record, "trace"),
  };
}

function readTranscribeAudioParams(
  params: JsonValue | undefined,
): VoiceTranscribeAudioParams {
  const record = requireRecord(params, "voice-transcribe-audio");
  return {
    audioBase64: readString(record, "audioBase64", "voice-transcribe-audio"),
    mimeType: readOptionalString(record, "mimeType", "voice-transcribe-audio"),
    trace: readOptionalBoolean(record, "trace"),
    metadata: readMetadata(record, "metadata", "voice-transcribe-audio"),
  };
}

function readSynthesizeSpeechParams(
  params: JsonValue | undefined,
): VoiceSynthesizeSpeechParams {
  const record = requireRecord(params, "voice-synthesize-speech");
  return {
    text: readString(record, "text", "voice-synthesize-speech"),
    voiceId: readOptionalString(record, "voiceId", "voice-synthesize-speech"),
    trace: readOptionalBoolean(record, "trace"),
    metadata: readMetadata(record, "metadata", "voice-synthesize-speech"),
  };
}

export function createVoiceHost(service: VoiceService): VoiceHost {
  return {
    status: async () => service.status() as Promise<JsonValue>,
    components: async () =>
      ({ components: await service.components() }) as JsonValue,
    start: async (params) => service.start(readStartParams(params)) as Promise<JsonValue>,
    stop: async (params) => service.stop(readStopParams(params)) as Promise<JsonValue>,
    interrupt: async (params) =>
      service.interrupt(readInterruptParams(params)) as Promise<JsonValue>,
    injectTranscript: async (params) =>
      service.injectTranscript(readInjectParams(params)) as Promise<JsonValue>,
    speak: async (params) =>
      service.speak(readSpeakParams(params)) as Promise<JsonValue>,
    transcribeAudio: async (params) =>
      service.transcribeAudio(readTranscribeAudioParams(params)) as Promise<JsonValue>,
    synthesizeSpeech: async (params) =>
      service.synthesizeSpeech(readSynthesizeSpeechParams(params)) as Promise<JsonValue>,
    latency: async () => service.latency() as Promise<JsonValue>,
    recentTurns: async (params) => {
      const record = optionalRecord(params, "voice-recent-turns");
      return {
        turns: await service.recentTurns({
          limit: readOptionalNumber(record, "limit", "voice-recent-turns"),
        }),
      } as JsonValue;
    },
  };
}

export const createVoiceHostForRuntime = createVoiceHost;
