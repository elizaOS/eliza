import type { Readable } from "node:stream";
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { OpenAITextToSpeechParams } from "../types";
import { getSetting, isBrowser } from "../utils/config";
import { webStreamToNodeStream } from "../utils/helpers";
import { createElizaCloudClient } from "../utils/sdk-client";

async function fetchTextToSpeech(
  runtime: IAgentRuntime,
  options: OpenAITextToSpeechParams
): Promise<ReadableStream<Uint8Array> | Readable> {
  const defaultModel = getSetting(runtime, "ELIZAOS_CLOUD_TTS_MODEL", "gpt-5-mini-tts");
  const defaultVoice = getSetting(runtime, "ELIZAOS_CLOUD_TTS_VOICE", "nova");

  const model = options.model || (defaultModel as string);
  const voice = options.voice || (defaultVoice as string);
  const format = options.format || "mp3";
  const modelId = model.startsWith("elevenlabs/")
    ? model.split("/").slice(1).join("/")
    : model.startsWith("eleven_")
      ? model
      : undefined;
  const voiceId = voice && voice !== "nova" ? voice : undefined;

  try {
    const res = await createElizaCloudClient(runtime).routes.postApiV1VoiceTts({
      headers: {
        ...(format === "mp3" ? { Accept: "audio/mpeg" } : {}),
      },
      json: {
        text: options.text,
        ...(voiceId ? { voiceId } : {}),
        ...(modelId ? { modelId } : {}),
      },
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`ElizaOS Cloud TTS error ${res.status}: ${err}`);
    }

    if (!res.body) {
      throw new Error("ElizaOS Cloud TTS response body is null");
    }

    if (!isBrowser()) {
      return await webStreamToNodeStream(res.body);
    }

    return res.body;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch speech from ElizaOS Cloud TTS: ${message}`);
  }
}

export async function handleTextToSpeech(
  runtime: IAgentRuntime,
  input: string | OpenAITextToSpeechParams
): Promise<ReadableStream<Uint8Array> | Readable> {
  const options: OpenAITextToSpeechParams =
    typeof input === "string" ? { text: input } : (input as OpenAITextToSpeechParams);

  const resolvedModel =
    options.model || (getSetting(runtime, "ELIZAOS_CLOUD_TTS_MODEL", "gpt-5-mini-tts") as string);
  logger.log(`[ELIZAOS_CLOUD] Using TEXT_TO_SPEECH model: ${resolvedModel}`);
  try {
    const speechStream = await fetchTextToSpeech(runtime, options);
    return speechStream;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Error in TEXT_TO_SPEECH: ${message}`);
    throw error;
  }
}

export { fetchTextToSpeech };
