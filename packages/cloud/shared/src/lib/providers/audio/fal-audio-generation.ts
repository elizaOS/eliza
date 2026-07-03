import { falQueueOptionsFromApiKeys, runFalQueueJob } from "../fal-queue";
import type { AudioGenRequest, AudioProvider, GeneratedAudio } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

interface AudioObject {
  url: string;
  fileName?: string;
  fileSize?: number;
  contentType?: string;
}

function normalizeAudioObject(value: unknown): AudioObject | null {
  const directUrl = stringValue(value);
  if (directUrl) {
    return { url: directUrl };
  }
  if (!isRecord(value)) return null;
  const url =
    stringValue(value.url) ??
    stringValue(value.audio_url) ??
    stringValue(value.output_url) ??
    stringValue(value.file_url);
  if (!url) return null;
  return {
    url,
    fileName: stringValue(value.file_name),
    fileSize: numberValue(value.file_size),
    contentType: stringValue(value.content_type),
  };
}

export function normalizeFalAudioResult(
  result: Record<string, unknown>,
  requestId?: string,
): GeneratedAudio {
  const direct =
    normalizeAudioObject(result.audio) ??
    normalizeAudioObject(result.audio_file) ??
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
  if (!audio) {
    throw new Error("fal returned no audio URL");
  }

  return {
    source: "hosted",
    url: audio.url,
    fileName: audio.fileName,
    fileSize: audio.fileSize,
    contentType: audio.contentType,
    requestId: stringValue(result.requestId) ?? stringValue(result.request_id) ?? requestId,
    status: stringValue(result.status),
    raw: result,
  };
}

export function buildFalMusicInput(request: AudioGenRequest): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt: request.prompt };

  if (request.lyrics !== undefined) input.lyrics = request.lyrics;
  if (request.instrumental !== undefined) input.is_instrumental = request.instrumental;
  if (request.lyricsOptimizer !== undefined) {
    input.lyrics_optimizer = request.lyricsOptimizer;
  } else if (!request.lyrics && request.instrumental !== true) {
    input.lyrics_optimizer = true;
  }
  if (request.referenceUrl) {
    input.audio_url = request.referenceUrl;
    input.reference_audio_url = request.referenceUrl;
  }
  if (request.durationSeconds) {
    input.duration = request.durationSeconds;
    input.duration_seconds = request.durationSeconds;
    input.seconds_total = request.durationSeconds;
  }
  if (request.audioSettings) {
    input.audio_setting = {
      ...(request.audioSettings.sampleRate
        ? { sample_rate: request.audioSettings.sampleRate }
        : {}),
      ...(request.audioSettings.bitrate ? { bitrate: request.audioSettings.bitrate } : {}),
      ...(request.audioSettings.format ? { format: request.audioSettings.format } : {}),
    };
  }

  return { ...input, ...(request.extraInput ?? {}) };
}

export function buildFalSfxInput(request: AudioGenRequest): Record<string, unknown> {
  // Stable Audio-style text-to-audio input: prompt + total seconds.
  const input: Record<string, unknown> = { prompt: request.prompt };
  if (request.durationSeconds) {
    input.seconds_total = request.durationSeconds;
  }
  if (request.seed !== undefined) {
    input.seed = request.seed;
  }
  return { ...input, ...(request.extraInput ?? {}) };
}

export async function generateFalAudio(request: AudioGenRequest): Promise<GeneratedAudio> {
  const options = falQueueOptionsFromApiKeys(request.apiKeys);
  const input = request.kind === "sfx" ? buildFalSfxInput(request) : buildFalMusicInput(request);
  const { requestId, payload } = await runFalQueueJob(request.model, input, options);
  return normalizeFalAudioResult(payload, requestId);
}

export const falAudioProvider: AudioProvider = {
  billingSource: "fal",
  generate: generateFalAudio,
};
