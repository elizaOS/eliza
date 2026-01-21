import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { ModelType, logger } from "@elizaos/core";

function isBrowser(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { document?: Document }).document !== "undefined"
  );
}

function getSetting(
  runtime: IAgentRuntime,
  key: string,
  fallback: string,
): string {
  const value = runtime.getSetting(key);
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function getBooleanSetting(
  runtime: IAgentRuntime,
  key: string,
  fallback: boolean,
): boolean {
  const value = runtime.getSetting(key);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes")
      return true;
    if (normalized === "false" || normalized === "0" || normalized === "no")
      return false;
  }
  return fallback;
}

function getBaseURL(runtime: IAgentRuntime): string {
  // In browsers, always prefer a proxy URL (so secrets never leave the server).
  const browserURL = runtime.getSetting("ELEVENLABS_BROWSER_URL");
  if (typeof browserURL === "string" && browserURL.length > 0)
    return browserURL;
  return "https://api.elevenlabs.io/v1";
}

function getApiKey(runtime: IAgentRuntime): string {
  // By default, do NOT send a real API key from the browser.
  // If you have a local demo and understand the risk, explicitly opt in.
  if (
    isBrowser() &&
    !getBooleanSetting(runtime, "ELEVENLABS_ALLOW_BROWSER_API_KEY", false)
  ) {
    return "sk-proxy";
  }
  const key = runtime.getSetting("ELEVENLABS_API_KEY");
  return typeof key === "string" ? key : "";
}

type VoiceSettings = {
  apiKey: string;
  voiceId: string;
  model: string;
  stability: string;
  latency: string;
  outputFormat: string;
  similarity: string;
  style: string;
  speakerBoost: boolean;
};

function getVoiceSettings(runtime: IAgentRuntime): VoiceSettings {
  return {
    apiKey: getApiKey(runtime),
    voiceId: getSetting(runtime, "ELEVENLABS_VOICE_ID", "EXAVITQu4vr4xnSDxMaL"),
    model: getSetting(runtime, "ELEVENLABS_MODEL_ID", "eleven_monolingual_v1"),
    stability: getSetting(runtime, "ELEVENLABS_VOICE_STABILITY", "0.5"),
    latency: getSetting(runtime, "ELEVENLABS_OPTIMIZE_STREAMING_LATENCY", "0"),
    outputFormat: getSetting(
      runtime,
      "ELEVENLABS_OUTPUT_FORMAT",
      "mp3_44100_128",
    ),
    similarity: getSetting(
      runtime,
      "ELEVENLABS_VOICE_SIMILARITY_BOOST",
      "0.75",
    ),
    style: getSetting(runtime, "ELEVENLABS_VOICE_STYLE", "0"),
    speakerBoost: getBooleanSetting(
      runtime,
      "ELEVENLABS_VOICE_USE_SPEAKER_BOOST",
      true,
    ),
  };
}

async function fetchSpeech(
  runtime: IAgentRuntime,
  params: {
    text: string;
    voiceId: string;
    modelId: string;
    outputFormat: string;
    stability: string;
    similarity: string;
    style: string;
    speakerBoost: boolean;
    latency: string;
  },
): Promise<ReadableStream<Uint8Array>> {
  const baseUrl = getBaseURL(runtime);
  const apiKey = getApiKey(runtime);
  const url = `${baseUrl}/text-to-speech/${params.voiceId}/stream?optimize_streaming_latency=${params.latency}&output_format=${params.outputFormat}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
    },
    body: JSON.stringify({
      text: params.text,
      model_id: params.modelId,
      voice_settings: {
        stability: Number(params.stability) || 0.5,
        similarity_boost: Number(params.similarity) || 0.75,
        style: Number(params.style) || 0,
        use_speaker_boost: params.speakerBoost,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`ElevenLabs API error ${response.status}: ${errorText}`);
  }

  if (!response.body) {
    throw new Error("Empty response body from ElevenLabs API");
  }

  return response.body;
}

async function readStreamToUint8Array(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      totalLength += value.length;
    }
  }

  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export const elevenLabsPlugin: Plugin = {
  name: "elevenLabs",
  description:
    "ElevenLabs TTS (browser-safe build; use ELEVENLABS_BROWSER_URL proxy by default)",
  async init(_config, _runtime): Promise<void> {
    logger.debug("[plugin-elevenlabs] browser build initialized");
  },
  models: {
    [ModelType.TEXT_TO_SPEECH]: async (
      runtime: IAgentRuntime,
      input: string | { text: string; voice?: string },
    ): Promise<Uint8Array> => {
      const options = typeof input === "string" ? { text: input } : input;
      const settings = getVoiceSettings(runtime);
      const voiceId = options.voice ?? settings.voiceId;
      const stream = await fetchSpeech(runtime, {
        text: options.text,
        voiceId,
        modelId: settings.model,
        outputFormat: settings.outputFormat,
        stability: settings.stability,
        similarity: settings.similarity,
        style: settings.style,
        speakerBoost: settings.speakerBoost,
        latency: settings.latency,
      });
      return await readStreamToUint8Array(stream);
    },
    [ModelType.TRANSCRIPTION]: async () => {
      throw new Error(
        "ElevenLabs TRANSCRIPTION is not supported in the browser build. Use a server proxy.",
      );
    },
  },
};

export default elevenLabsPlugin;
