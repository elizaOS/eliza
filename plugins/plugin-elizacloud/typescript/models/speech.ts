import type { Readable } from "node:stream";
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { OpenAITextToSpeechParams } from "../types";
import {
  getAuthHeader,
  getBaseURL,
  getSetting,
  isBrowser,
} from "../utils/config";
import { webStreamToNodeStream } from "../utils/helpers";

async function fetchTextToSpeech(
  runtime: IAgentRuntime,
  options: OpenAITextToSpeechParams,
): Promise<ReadableStream<Uint8Array> | Readable> {
  const defaultModel = getSetting(
    runtime,
    "ELIZAOS_CLOUD_TTS_MODEL",
    "gpt-5-mini-tts",
  );
  const defaultVoice = getSetting(runtime, "ELIZAOS_CLOUD_TTS_VOICE", "nova");
  const defaultInstructions = getSetting(
    runtime,
    "ELIZAOS_CLOUD_TTS_INSTRUCTIONS",
    "",
  );
  const baseURL = getBaseURL(runtime);

  const model = options.model || (defaultModel as string);
  const voice = options.voice || (defaultVoice as string);
  const instructions = options.instructions ?? (defaultInstructions as string);
  const format = options.format || "mp3";

  try {
    const res = await fetch(`${baseURL}/audio/speech`, {
      method: "POST",
      headers: {
        ...getAuthHeader(runtime),
        "Content-Type": "application/json",
        ...(format === "mp3" ? { Accept: "audio/mpeg" } : {}),
      },
      body: JSON.stringify({
        model,
        voice,
        input: options.text,
        format,
        ...(instructions && { instructions }),
      }),
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
    throw new Error(
      `Failed to fetch speech from ElizaOS Cloud TTS: ${message}`,
    );
  }
}

export async function handleTextToSpeech(
  runtime: IAgentRuntime,
  input: string | OpenAITextToSpeechParams,
): Promise<ReadableStream<Uint8Array> | Readable> {
  const options: OpenAITextToSpeechParams =
    typeof input === "string"
      ? { text: input }
      : (input as OpenAITextToSpeechParams);

  const resolvedModel =
    options.model ||
    (getSetting(
      runtime,
      "ELIZAOS_CLOUD_TTS_MODEL",
      "gpt-5-mini-tts",
    ) as string);
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
