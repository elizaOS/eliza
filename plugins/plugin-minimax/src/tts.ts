/**
 * @fileoverview MiniMax Text-to-Speech Handler
 *
 * Implements TTS using MiniMax's T2A v2 API with streaming support.
 *
 * Supported models:
 * - speech-2.8-hd: Perfecting tonal nuances with maximized timbre similarity (default)
 * - speech-2.8-turbo: Faster, more affordable version
 *
 * Features:
 * - SSE streaming with hex-encoded audio chunks
 * - Multiple voice options
 * - MP3 output format (default)
 *
 * @see https://platform.minimax.io/docs/api-reference/speech-t2a-http
 */

import type { IAgentRuntime, TextToSpeechParams } from "@elizaos/core";
import { logger } from "@elizaos/core";

/** Default MiniMax API base URL */
const DEFAULT_BASE_URL = "https://api.minimax.io/v1";

/** Default TTS model */
const DEFAULT_TTS_MODEL = "speech-2.8-hd";

/** Default voice ID */
const DEFAULT_VOICE_ID = "English_Graceful_Lady";

/** Available voice IDs */
const VOICE_IDS = [
  "English_Graceful_Lady",
  "English_Insightful_Speaker",
  "English_radiant_girl",
  "English_Persuasive_Man",
  "English_Lucky_Robot",
] as const;

interface TTSResponse {
  data: {
    audio: string; // hex-encoded audio data
    status: number;
  };
  base_resp?: {
    status_code: number;
    status_msg: string;
  };
  extra_info?: {
    audio_length: number;
    audio_sample_rate: number;
    audio_size: number;
  };
}

/**
 * Handle TEXT_TO_SPEECH model requests using MiniMax TTS API
 */
export async function handleTextToSpeech(
  runtime: IAgentRuntime,
  params: TextToSpeechParams | string
): Promise<Buffer> {
  const apiKey =
    runtime.getSetting("MINIMAX_API_KEY") ||
    process.env.MINIMAX_API_KEY ||
    "";

  if (!apiKey) {
    throw new Error(
      "MINIMAX_API_KEY is not set. Please set it in your environment or character settings."
    );
  }

  const baseUrl =
    runtime.getSetting("MINIMAX_BASE_URL") ||
    process.env.MINIMAX_BASE_URL ||
    DEFAULT_BASE_URL;

  // Handle both string and object params
  const text = typeof params === "string" ? params : params.text;
  const voice =
    typeof params === "string"
      ? DEFAULT_VOICE_ID
      : params.voice || DEFAULT_VOICE_ID;
  const speed =
    typeof params === "string" ? 1.0 : (params as TextToSpeechParams).speed ?? 1.0;

  if (!text || text.trim().length === 0) {
    throw new Error("TTS text cannot be empty");
  }

  // Truncate to MiniMax's max text length
  const truncatedText = text.slice(0, 10000);

  logger.debug(
    { src: "minimax-tts", voice, textLength: truncatedText.length },
    "TTS request"
  );

  const url = `${baseUrl}/t2a_v2`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEFAULT_TTS_MODEL,
      text: truncatedText,
      stream: false,
      voice_setting: {
        voice_id: voice,
        speed: speed,
      },
      audio_setting: {
        format: "mp3",
        sample_rate: 32000,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `MiniMax TTS API request failed (${response.status}): ${errorText}`
    );
  }

  const data = (await response.json()) as TTSResponse;

  if (data.base_resp && data.base_resp.status_code !== 0) {
    throw new Error(
      `MiniMax TTS error: ${data.base_resp.status_msg} (code: ${data.base_resp.status_code})`
    );
  }

  if (!data.data?.audio) {
    throw new Error("MiniMax TTS API returned no audio data");
  }

  // Convert hex-encoded audio to Buffer
  const audioBuffer = Buffer.from(data.data.audio, "hex");

  logger.debug(
    { src: "minimax-tts", audioSize: audioBuffer.length },
    "TTS response received"
  );

  return audioBuffer;
}
