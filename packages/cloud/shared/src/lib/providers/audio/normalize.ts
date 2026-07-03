import type { AudioGenerationResult, AudioObject } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeAudioObject(value: unknown): AudioObject | null {
  if (!isRecord(value)) return null;
  const url =
    stringValue(value.url) ??
    stringValue(value.audio_url) ??
    stringValue(value.output_url) ??
    stringValue(value.file_url);
  if (!url) return null;
  return {
    url,
    file_name: stringValue(value.file_name),
    file_size: numberValue(value.file_size),
    content_type: stringValue(value.content_type),
  };
}

export function normalizeAudioResult(result: unknown, requestId?: string): AudioGenerationResult {
  if (!isRecord(result)) {
    throw new Error("Audio provider returned an invalid response");
  }

  const direct =
    normalizeAudioObject(result.audio) ??
    normalizeAudioObject(result.music) ??
    normalizeAudioObject(result.file) ??
    normalizeAudioObject(result.output) ??
    normalizeAudioObject(result);
  const fromArray = Array.isArray(result.audios)
    ? normalizeAudioObject(result.audios[0])
    : Array.isArray(result.data)
      ? normalizeAudioObject(result.data[0])
      : null;
  const audio = direct ?? fromArray;
  if (!audio?.url) {
    throw new Error("Audio provider returned no audio URL");
  }

  return {
    requestId:
      stringValue(result.requestId) ??
      stringValue(result.request_id) ??
      stringValue(result.id) ??
      requestId,
    status: stringValue(result.status),
    audio,
    raw: result,
  };
}
