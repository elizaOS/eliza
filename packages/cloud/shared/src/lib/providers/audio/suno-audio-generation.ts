// Defines cloud shared suno audio generation behavior for backend service consumers.
import type { AudioGenRequest, AudioProvider, GeneratedAudio } from "./types";

const DEFAULT_BASE_URL = "https://api.suno.ai/v1";
const REQUEST_TIMEOUT_MS = 120_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractAudioUrl(record: Record<string, unknown>): string | undefined {
  return (
    stringValue(record.url) ??
    stringValue(record.audio_url) ??
    stringValue(record.output_url) ??
    stringValue(record.file_url)
  );
}

export async function generateSunoAudio(request: AudioGenRequest): Promise<GeneratedAudio> {
  if (request.kind !== "music") {
    throw new Error("Suno-compatible providers only support music generation");
  }
  const apiKey = request.apiKeys.SUNO_API_KEY;
  if (!apiKey) {
    throw new Error("Suno-compatible music generation is not configured");
  }
  const baseUrl = (request.apiKeys.SUNO_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

  const response = await fetch(`${baseUrl}/generate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: request.prompt,
      ...(request.durationSeconds ? { duration: request.durationSeconds } : {}),
      ...(request.lyrics ? { lyrics: request.lyrics } : {}),
      ...(request.instrumental !== undefined ? { instrumental: request.instrumental } : {}),
      ...(request.extraInput ?? {}),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const data = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    throw new Error(`Suno-compatible music generation failed (${response.status})`);
  }
  if (!isRecord(data)) {
    throw new Error("Suno-compatible provider returned an invalid response");
  }

  const candidates: Record<string, unknown>[] = [
    ...(isRecord(data.audio) ? [data.audio] : []),
    ...(isRecord(data.music) ? [data.music] : []),
    ...(isRecord(data.file) ? [data.file] : []),
    ...(isRecord(data.output) ? [data.output] : []),
    data,
    ...(Array.isArray(data.audios) && isRecord(data.audios[0]) ? [data.audios[0]] : []),
    ...(Array.isArray(data.data) && isRecord(data.data[0]) ? [data.data[0]] : []),
  ];
  for (const candidate of candidates) {
    const url = extractAudioUrl(candidate);
    if (url) {
      return {
        source: "hosted",
        url,
        fileName: stringValue(candidate.file_name),
        fileSize: numberValue(candidate.file_size),
        contentType: stringValue(candidate.content_type),
        requestId: stringValue(data.request_id) ?? stringValue(data.id),
        status: stringValue(data.status),
        raw: data,
      };
    }
  }
  throw new Error("Suno-compatible provider returned no audio URL");
}

export const sunoAudioProvider: AudioProvider = {
  billingSource: "suno",
  generate: generateSunoAudio,
};
