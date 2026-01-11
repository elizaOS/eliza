/**
 * @fileoverview Ollama Model Provider for Integration Testing
 *
 * Provides real inference through local Ollama instance.
 * This is used when no cloud API keys are configured.
 */

import { z } from "zod";
import { logger } from "../logger";
import type {
  GenerateTextParams,
  IAgentRuntime,
  ModelTypeName,
  ObjectGenerationParams,
  TextEmbeddingParams,
} from "../types";
import { ModelType } from "../types";

/** Default Ollama endpoint */
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

/** Default models for different types */
const DEFAULT_MODELS = {
  text_small: process.env.OLLAMA_SMALL_MODEL || "llama3.2:1b",
  text_large: process.env.OLLAMA_LARGE_MODEL || "llama3.2:3b",
  embedding: process.env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text",
} as const;

/**
 * Schema for Ollama /api/tags response
 */
const ollamaTagsResponseSchema = z.object({
  models: z.array(z.object({ name: z.string() })).optional(),
});

/**
 * Schema for Ollama /api/generate response
 */
const ollamaGenerateResponseSchema = z.object({
  response: z.string(),
});

/**
 * Schema for Ollama /api/embed response
 */
const ollamaEmbedResponseSchema = z.object({
  embeddings: z.array(z.array(z.number())).optional(),
  embedding: z.array(z.number()).optional(),
});

/**
 * Check if Ollama is available and responding
 */
export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * List available models in Ollama
 */
export async function listOllamaModels(): Promise<string[]> {
  const response = await fetch(`${OLLAMA_URL}/api/tags`);
  if (!response.ok) {
    throw new Error(`Ollama returned status ${response.status}`);
  }

  const rawData: unknown = await response.json();
  const parseResult = ollamaTagsResponseSchema.safeParse(rawData);

  if (!parseResult.success) {
    const zodError = parseResult.error as {
      issues?: Array<{ message: string }>;
      toString: () => string;
    };
    throw new Error(
      `Invalid Ollama response: ${zodError.issues?.[0]?.message || zodError.toString() || "Validation failed"}`,
    );
  }

  const parseResultDataModels = parseResult.data.models;
  return parseResultDataModels?.map((m: { name: string }) => m.name) ?? [];
}

/**
 * Options for text generation
 */
interface TextGenerationOptions {
  system?: string;
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
}

/**
 * Generate text using Ollama
 */
async function generateTextWithOllama(
  model: string,
  prompt: string,
  options: TextGenerationOptions = {},
): Promise<string> {
  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      system: options.system,
      options: {
        temperature: options.temperature ?? 0.7,
        num_predict: options.maxTokens ?? 2048,
        stop: options.stopSequences,
      },
      stream: false,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama request failed: ${response.status} ${errorText}`);
  }

  const rawData: unknown = await response.json();
  const parseResult = ollamaGenerateResponseSchema.safeParse(rawData);

  if (!parseResult.success) {
    const zodError = parseResult.error as {
      issues?: Array<{ message: string }>;
      toString: () => string;
    };
    throw new Error(
      `Invalid Ollama response: ${zodError.issues?.map((i: { message: string }) => i.message).join(", ") || zodError.toString() || "Validation failed"}`,
    );
  }

  return parseResult.data.response;
}

/**
 * Generate embeddings using Ollama
 */
async function generateEmbeddingWithOllama(
  model: string,
  text: string,
): Promise<number[]> {
  const response = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: text,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Ollama embedding request failed: ${response.status} ${errorText}`,
    );
  }

  const rawData: unknown = await response.json();
  const parseResult = ollamaEmbedResponseSchema.safeParse(rawData);

  if (!parseResult.success) {
    const zodError = parseResult.error as {
      issues?: Array<{ message: string }>;
      toString: () => string;
    };
    throw new Error(
      `Invalid Ollama embedding response: ${zodError.issues?.map((i: { message: string }) => i.message).join(", ") || zodError.toString() || "Validation failed"}`,
    );
  }

  const parseResultDataEmbeddings = parseResult.data.embeddings;
  const parseResultDataEmbedding = parseResult.data.embedding;
  const embeddings = parseResultDataEmbeddings?.[0] ?? parseResultDataEmbedding;
  if (!embeddings) {
    throw new Error("No embeddings returned from Ollama");
  }

  return embeddings;
}

/**
 * Extract JSON object from a text response that may contain surrounding text
 */
function extractJsonFromResponse(response: string): Record<string, unknown> {
  // Try to find JSON object in the response
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  const textToParse = jsonMatch ? jsonMatch[0] : response;

  try {
    const parsed: unknown = JSON.parse(textToParse);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error(`Expected JSON object but got: ${typeof parsed}`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown parse error";
    throw new Error(
      `Failed to parse JSON from Ollama response: ${message}\nResponse was: ${response.slice(0, 200)}`,
    );
  }
}

/**
 * Handle TEXT_SMALL model requests
 */
async function handleTextSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
): Promise<string> {
  logger.debug(
    { src: "ollama", model: DEFAULT_MODELS.text_small },
    "TEXT_SMALL request",
  );

  return generateTextWithOllama(DEFAULT_MODELS.text_small, params.prompt, {
    system: runtime.character.system ?? undefined,
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    stopSequences: params.stopSequences,
  });
}

/**
 * Handle TEXT_LARGE model requests
 */
async function handleTextLarge(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
): Promise<string> {
  logger.debug(
    { src: "ollama", model: DEFAULT_MODELS.text_large },
    "TEXT_LARGE request",
  );

  return generateTextWithOllama(DEFAULT_MODELS.text_large, params.prompt, {
    system: runtime.character.system ?? undefined,
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    stopSequences: params.stopSequences,
  });
}

/**
 * Handle TEXT_EMBEDDING model requests
 */
async function handleTextEmbedding(
  _runtime: IAgentRuntime,
  params: TextEmbeddingParams,
): Promise<number[]> {
  logger.debug(
    { src: "ollama", model: DEFAULT_MODELS.embedding },
    "TEXT_EMBEDDING request",
  );

  return generateEmbeddingWithOllama(DEFAULT_MODELS.embedding, params.text);
}

/**
 * Generate structured object using Ollama with JSON mode
 */
async function generateObjectWithOllama(
  runtime: IAgentRuntime,
  model: string,
  params: ObjectGenerationParams,
): Promise<Record<string, unknown>> {
  logger.debug({ src: "ollama", model }, "OBJECT generation request");

  const jsonPrompt = `${params.prompt}\n\nRespond with valid JSON only:`;
  const response = await generateTextWithOllama(model, jsonPrompt, {
    system: runtime.character.system ?? undefined,
    temperature: params.temperature ?? 0.3, // Lower temp for structured output
    maxTokens: params.maxTokens,
  });

  return extractJsonFromResponse(response);
}

/**
 * Handle OBJECT_SMALL model requests
 */
async function handleObjectSmall(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
): Promise<Record<string, unknown>> {
  return generateObjectWithOllama(runtime, DEFAULT_MODELS.text_small, params);
}

/**
 * Handle OBJECT_LARGE model requests
 */
async function handleObjectLarge(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
): Promise<Record<string, unknown>> {
  return generateObjectWithOllama(runtime, DEFAULT_MODELS.text_large, params);
}

/**
 * Union type of all model parameter types for Ollama handlers
 */
type OllamaModelParams =
  | GenerateTextParams
  | TextEmbeddingParams
  | ObjectGenerationParams;

/**
 * Union type of all model result types for Ollama handlers
 */
type OllamaModelResult = string | number[] | Record<string, unknown>;

/**
 * Model handler function type
 */
type ModelHandlerFn = (
  runtime: IAgentRuntime,
  params: OllamaModelParams,
) => Promise<OllamaModelResult>;

/**
 * Create all Ollama model handlers for registration
 */
export function createOllamaModelHandlers(): Partial<
  Record<ModelTypeName, ModelHandlerFn>
> {
  return {
    [ModelType.TEXT_SMALL]: handleTextSmall as ModelHandlerFn,
    [ModelType.TEXT_LARGE]: handleTextLarge as ModelHandlerFn,
    [ModelType.TEXT_EMBEDDING]: handleTextEmbedding as ModelHandlerFn,
    [ModelType.OBJECT_SMALL]: handleObjectSmall as ModelHandlerFn,
    [ModelType.OBJECT_LARGE]: handleObjectLarge as ModelHandlerFn,
  };
}
