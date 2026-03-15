/**
 * @fileoverview MiniMax Chat Completion Handlers
 *
 * Implements text generation and structured output using MiniMax's
 * OpenAI-compatible chat completion API.
 *
 * Supported models:
 * - MiniMax-M2.5: Peak performance, 204K context, default model
 * - MiniMax-M2.5-highspeed: Same performance, faster and more agile
 *
 * API constraints:
 * - Temperature must be in (0.0, 1.0], zero is rejected
 * - response_format is not supported
 *
 * @see https://platform.minimax.io/docs/api-reference/text-openai-api
 */

import type {
  GenerateTextParams,
  IAgentRuntime,
  ObjectGenerationParams,
} from "@elizaos/core";
import { logger } from "@elizaos/core";

/** Default MiniMax API base URL (international) */
const DEFAULT_BASE_URL = "https://api.minimax.io/v1";

/** MiniMax model IDs */
const MODELS = {
  /** Peak Performance. Ultimate Value. Master the Complex */
  LARGE: "MiniMax-M2.5",
  /** Same performance, faster and more agile */
  SMALL: "MiniMax-M2.5-highspeed",
} as const;

/**
 * Get MiniMax API configuration from runtime settings or environment
 */
function getConfig(runtime: IAgentRuntime): {
  apiKey: string;
  baseUrl: string;
} {
  const apiKey =
    runtime.getSetting("MINIMAX_API_KEY") ||
    process.env.MINIMAX_API_KEY ||
    "";

  const baseUrl =
    runtime.getSetting("MINIMAX_BASE_URL") ||
    process.env.MINIMAX_BASE_URL ||
    DEFAULT_BASE_URL;

  return { apiKey, baseUrl };
}

/**
 * Clamp temperature to MiniMax's valid range (0.0, 1.0].
 * MiniMax rejects temperature=0, so we use a small epsilon instead.
 */
function clampTemperature(temperature?: number): number {
  if (temperature === undefined || temperature === null) {
    return 1.0; // MiniMax recommended default
  }
  if (temperature <= 0) {
    return 0.01; // Minimum allowed (cannot be exactly 0)
  }
  if (temperature > 1.0) {
    return 1.0;
  }
  return temperature;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Call MiniMax chat completion API
 */
async function callChatCompletion(
  config: { apiKey: string; baseUrl: string },
  model: string,
  messages: ChatMessage[],
  options: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    stop?: string[];
  } = {}
): Promise<ChatCompletionResponse> {
  const url = `${config.baseUrl}/chat/completions`;

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: clampTemperature(options.temperature),
  };

  if (options.maxTokens) {
    body.max_tokens = options.maxTokens;
  }
  if (options.topP !== undefined) {
    body.top_p = options.topP;
  }
  if (options.frequencyPenalty !== undefined) {
    body.frequency_penalty = options.frequencyPenalty;
  }
  if (options.presencePenalty !== undefined) {
    body.presence_penalty = options.presencePenalty;
  }
  if (options.stop && options.stop.length > 0) {
    body.stop = options.stop;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `MiniMax API request failed (${response.status}): ${errorText}`
    );
  }

  return (await response.json()) as ChatCompletionResponse;
}

/**
 * Generate text using MiniMax chat completion
 */
async function generateText(
  runtime: IAgentRuntime,
  model: string,
  params: GenerateTextParams
): Promise<string> {
  const config = getConfig(runtime);

  if (!config.apiKey) {
    throw new Error(
      "MINIMAX_API_KEY is not set. Please set it in your environment or character settings."
    );
  }

  const messages: ChatMessage[] = [];

  // Add system message from character if available
  const systemMessage = runtime.character?.system;
  if (systemMessage) {
    messages.push({ role: "system", content: systemMessage });
  }

  // Add the prompt as user message
  messages.push({ role: "user", content: params.prompt });

  logger.debug({ src: "minimax", model }, "Chat completion request");

  const response = await callChatCompletion(config, model, messages, {
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    topP: params.topP,
    frequencyPenalty: params.frequencyPenalty,
    presencePenalty: params.presencePenalty,
    stop: params.stopSequences,
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("MiniMax API returned empty response");
  }

  return content;
}

/**
 * Generate structured JSON object using MiniMax
 */
async function generateObject(
  runtime: IAgentRuntime,
  model: string,
  params: ObjectGenerationParams
): Promise<Record<string, unknown>> {
  const config = getConfig(runtime);

  if (!config.apiKey) {
    throw new Error(
      "MINIMAX_API_KEY is not set. Please set it in your environment or character settings."
    );
  }

  // Since MiniMax doesn't support response_format, use prompt engineering
  const jsonPrompt = `${params.prompt}\n\nYou MUST respond with valid JSON only. No additional text, no markdown code blocks, just the raw JSON object.`;

  const messages: ChatMessage[] = [];
  const systemMessage = runtime.character?.system;
  if (systemMessage) {
    messages.push({ role: "system", content: systemMessage });
  }
  messages.push({ role: "user", content: jsonPrompt });

  logger.debug({ src: "minimax", model }, "Object generation request");

  const response = await callChatCompletion(config, model, messages, {
    temperature: params.temperature ?? 0.3,
    maxTokens: params.maxTokens,
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("MiniMax API returned empty response");
  }

  // Extract JSON from response (handle potential surrounding text)
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  const textToParse = jsonMatch ? jsonMatch[0] : content;

  try {
    const parsed: unknown = JSON.parse(textToParse);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Expected JSON object but got: ${typeof parsed}`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown parse error";
    throw new Error(
      `Failed to parse JSON from MiniMax response: ${message}\nResponse was: ${content.slice(0, 200)}`
    );
  }
}

/**
 * Handle TEXT_SMALL model requests using MiniMax-M2.5-highspeed
 */
export async function handleTextSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string> {
  return generateText(runtime, MODELS.SMALL, params);
}

/**
 * Handle TEXT_LARGE model requests using MiniMax-M2.5
 */
export async function handleTextLarge(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string> {
  return generateText(runtime, MODELS.LARGE, params);
}

/**
 * Handle OBJECT_SMALL model requests using MiniMax-M2.5-highspeed
 */
export async function handleObjectSmall(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams
): Promise<Record<string, unknown>> {
  return generateObject(runtime, MODELS.SMALL, params);
}

/**
 * Handle OBJECT_LARGE model requests using MiniMax-M2.5
 */
export async function handleObjectLarge(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams
): Promise<Record<string, unknown>> {
  return generateObject(runtime, MODELS.LARGE, params);
}
