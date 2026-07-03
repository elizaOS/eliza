import { createFalClient } from "@fal-ai/client";
import { getAiProviderConfigurationError } from "../language-model";
import { normalizeAudioResult } from "./normalize";
import type { AudioGenerationRequest, AudioProvider } from "./types";

function buildFalInput(request: AudioGenerationRequest): Record<string, unknown> {
  const input: Record<string, unknown> = {
    prompt: request.prompt,
  };

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
  if (request.audio) {
    input.audio_setting = {
      ...(request.audio.sampleRate ? { sample_rate: request.audio.sampleRate } : {}),
      ...(request.audio.bitrate ? { bitrate: request.audio.bitrate } : {}),
      ...(request.audio.format ? { format: request.audio.format } : {}),
    };
  }

  return {
    ...input,
    ...(request.extraInput ?? {}),
  };
}

export async function generateFalAudio(input: Parameters<AudioProvider["generate"]>[0]) {
  const key =
    typeof input.env.FAL_KEY === "string" && input.env.FAL_KEY.trim()
      ? input.env.FAL_KEY.trim()
      : typeof input.env.FAL_API_KEY === "string" && input.env.FAL_API_KEY.trim()
        ? input.env.FAL_API_KEY.trim()
        : null;
  if (!key) {
    throw new Error(getAiProviderConfigurationError());
  }

  let requestId: string | undefined;
  const fal = createFalClient({
    credentials: key,
    suppressLocalCredentialsWarning: true,
  });
  const result = await fal.subscribe(input.request.model, {
    input: buildFalInput(input.request),
    onEnqueue: (id) => {
      requestId = id;
    },
  });
  return normalizeAudioResult(result, requestId);
}

export const falAudioProvider: AudioProvider = {
  billingSource: "fal",
  generate: generateFalAudio,
  async healthCheck() {
    return true;
  },
};
