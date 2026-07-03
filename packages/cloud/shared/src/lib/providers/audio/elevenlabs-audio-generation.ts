import { putPublicObject } from "../../storage/r2-public-object";
import { normalizeAudioResult } from "./normalize";
import type { AudioProvider } from "./types";

function contentTypeForOutputFormat(outputFormat: string | undefined): string {
  if (!outputFormat) return "audio/mpeg";
  if (outputFormat.startsWith("pcm_")) return "audio/L16";
  if (outputFormat.startsWith("ulaw_")) return "audio/basic";
  if (outputFormat.startsWith("wav_")) return "audio/wav";
  if (outputFormat.startsWith("mp3_")) return "audio/mpeg";
  return "application/octet-stream";
}

function extensionForContentType(contentType: string): string {
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("L16") || contentType.includes("pcm")) return "pcm";
  if (contentType.includes("basic")) return "ulaw";
  return "mp3";
}

export async function generateElevenLabsAudio(input: Parameters<AudioProvider["generate"]>[0]) {
  const key = input.env.ELEVENLABS_API_KEY;
  if (!key) {
    throw new Error("ElevenLabs music generation is not configured");
  }
  if (!input.env.BLOB) {
    throw new Error("R2 storage is not configured");
  }

  const outputFormat = input.request.outputFormat ?? "mp3_44100_128";
  const url = new URL("https://api.elevenlabs.io/v1/music");
  url.searchParams.set("output_format", outputFormat);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": key,
    },
    body: JSON.stringify({
      prompt: input.request.prompt,
      ...(input.request.durationSeconds
        ? { music_length_ms: input.request.durationSeconds * 1000 }
        : {}),
      model_id: input.request.model.replace(/^elevenlabs\//, ""),
      ...(input.request.seed !== undefined ? { seed: input.request.seed } : {}),
      ...(input.request.extraInput ?? {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`ElevenLabs music generation failed (${response.status}): ${text}`);
  }

  const contentType =
    response.headers.get("content-type") ?? contentTypeForOutputFormat(outputFormat);
  const bytes = await response.arrayBuffer();
  const ext = extensionForContentType(contentType);
  const organizationId = input.user.organization_id ?? "unknown";
  const keyPath = `generations/music/${organizationId}/${input.user.id}/${crypto.randomUUID()}.${ext}`;
  const stored = await putPublicObject(input.env, {
    key: keyPath,
    body: bytes,
    contentType,
    customMetadata: {
      userId: input.user.id,
      organizationId,
      model: input.request.model,
      source: "generate-music",
    },
  });

  return normalizeAudioResult({
    audio: {
      url: stored.url,
      file_name: keyPath.split("/").at(-1),
      file_size: bytes.byteLength,
      content_type: contentType,
    },
    raw: { r2Key: stored.key },
  });
}

export const elevenLabsAudioProvider: AudioProvider = {
  billingSource: "elevenlabs",
  generate: generateElevenLabsAudio,
  async healthCheck() {
    return true;
  },
};
