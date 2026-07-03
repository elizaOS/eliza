import type { AudioGenRequest, AudioProvider, GeneratedAudio } from "./types";

const DEFAULT_BASE_URL = "https://api.elevenlabs.io";
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

export function contentTypeForOutputFormat(outputFormat: string | undefined): string {
  if (!outputFormat) return "audio/mpeg";
  if (outputFormat.startsWith("pcm_")) return "audio/L16";
  if (outputFormat.startsWith("ulaw_")) return "audio/basic";
  if (outputFormat.startsWith("wav_")) return "audio/wav";
  if (outputFormat.startsWith("mp3_")) return "audio/mpeg";
  return "application/octet-stream";
}

function resolveConfig(apiKeys: Record<string, string | undefined>): {
  apiKey: string;
  baseUrl: string;
} {
  const apiKey = apiKeys.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error("ElevenLabs is not configured: missing ELEVENLABS_API_KEY");
  }
  const baseUrl = (apiKeys.ELEVENLABS_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  return { apiKey, baseUrl };
}

async function readAudioBody(response: Response, label: string): Promise<Uint8Array> {
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) {
    throw new Error(`ElevenLabs ${label} returned an empty audio body`);
  }
  if (buffer.byteLength > MAX_AUDIO_BYTES) {
    throw new Error(`ElevenLabs ${label} response exceeded maximum size`);
  }
  return new Uint8Array(buffer);
}

async function throwUpstreamError(response: Response, label: string): Promise<never> {
  const text = await response.text().catch(() => "");
  throw new Error(`ElevenLabs ${label} failed (${response.status}): ${text}`);
}

async function generateElevenLabsMusic(request: AudioGenRequest): Promise<GeneratedAudio> {
  const { apiKey, baseUrl } = resolveConfig(request.apiKeys);
  const outputFormat = request.outputFormat ?? "mp3_44100_128";
  const url = new URL(`${baseUrl}/v1/music`);
  url.searchParams.set("output_format", outputFormat);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
    },
    body: JSON.stringify({
      prompt: request.prompt,
      ...(request.durationSeconds ? { music_length_ms: request.durationSeconds * 1000 } : {}),
      model_id: request.model.replace(/^elevenlabs\//, ""),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      ...(request.extraInput ?? {}),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    await throwUpstreamError(response, "music generation");
  }

  const contentType =
    response.headers.get("content-type") ?? contentTypeForOutputFormat(outputFormat);
  return {
    source: "bytes",
    bytes: await readAudioBody(response, "music generation"),
    contentType,
  };
}

async function generateElevenLabsSfx(request: AudioGenRequest): Promise<GeneratedAudio> {
  const { apiKey, baseUrl } = resolveConfig(request.apiKeys);
  const outputFormat = request.outputFormat ?? "mp3_44100_128";
  const url = new URL(`${baseUrl}/v1/sound-generation`);
  url.searchParams.set("output_format", outputFormat);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
    },
    body: JSON.stringify({
      text: request.prompt,
      model_id: "eleven_text_to_sound_v2",
      ...(request.durationSeconds ? { duration_seconds: request.durationSeconds } : {}),
      ...(request.promptInfluence !== undefined
        ? { prompt_influence: request.promptInfluence }
        : {}),
      ...(request.extraInput ?? {}),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    await throwUpstreamError(response, "sound-effect generation");
  }

  const contentType =
    response.headers.get("content-type") ?? contentTypeForOutputFormat(outputFormat);
  return {
    source: "bytes",
    bytes: await readAudioBody(response, "sound-effect generation"),
    contentType,
  };
}

export async function generateElevenLabsAudio(request: AudioGenRequest): Promise<GeneratedAudio> {
  return request.kind === "sfx"
    ? await generateElevenLabsSfx(request)
    : await generateElevenLabsMusic(request);
}

export const elevenLabsAudioProvider: AudioProvider = {
  billingSource: "elevenlabs",
  generate: generateElevenLabsAudio,
};
