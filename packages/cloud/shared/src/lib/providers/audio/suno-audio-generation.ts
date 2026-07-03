import { normalizeAudioResult } from "./normalize";
import type { AudioProvider } from "./types";

function sunoBaseUrl(env: Parameters<AudioProvider["generate"]>[0]["env"]): string {
  const configured =
    typeof env.SUNO_BASE_URL === "string" && env.SUNO_BASE_URL.trim()
      ? env.SUNO_BASE_URL.trim()
      : null;
  return (configured || "https://api.suno.ai/v1").replace(/\/+$/, "");
}

export async function generateSunoAudio(input: Parameters<AudioProvider["generate"]>[0]) {
  const key =
    typeof input.env.SUNO_API_KEY === "string" && input.env.SUNO_API_KEY.trim()
      ? input.env.SUNO_API_KEY.trim()
      : null;
  if (!key) {
    throw new Error("Suno-compatible music generation is not configured");
  }

  const response = await fetch(`${sunoBaseUrl(input.env)}/generate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: input.request.prompt,
      ...(input.request.durationSeconds ? { duration: input.request.durationSeconds } : {}),
      ...(input.request.lyrics ? { lyrics: input.request.lyrics } : {}),
      ...(input.request.instrumental !== undefined
        ? { instrumental: input.request.instrumental }
        : {}),
      ...(input.request.extraInput ?? {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Suno-compatible music generation failed (${response.status})`);
  }
  return normalizeAudioResult(data);
}

export const sunoAudioProvider: AudioProvider = {
  billingSource: "suno",
  generate: generateSunoAudio,
  async healthCheck() {
    return true;
  },
};
