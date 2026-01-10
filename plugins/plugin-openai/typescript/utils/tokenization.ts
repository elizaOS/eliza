/**
 * Tokenization utilities for OpenAI plugin
 *
 * Provides text tokenization and detokenization using tiktoken.
 */

import type { IAgentRuntime, ModelTypeName } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import {
  encodingForModel,
  getEncoding,
  type Tiktoken,
  type TiktokenEncoding,
  type TiktokenModel,
} from "js-tiktoken";
import { getLargeModel, getSmallModel } from "./config";

// ============================================================================
// Types
// ============================================================================

/**
 * Supported tokenizer encoding names
 */
type SupportedEncoding = "cl100k_base" | "o200k_base";

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Determines the appropriate tokenizer encoding for a model.
 *
 * Falls back to appropriate default encoding if the model isn't recognized:
 * - Models containing "4o" use o200k_base (GPT-4o encoding)
 * - Other models use cl100k_base (GPT-3.5/GPT-4 encoding)
 *
 * @param modelName - The name of the model
 * @returns The tiktoken encoder for the model
 */
function resolveTokenizerEncoding(modelName: string): Tiktoken {
  const normalized = modelName.toLowerCase();

  // Determine fallback encoding based on model name
  const fallbackEncoding: SupportedEncoding = normalized.includes("4o")
    ? "o200k_base"
    : "cl100k_base";

  try {
    // Try to get the exact encoder for the model
    return encodingForModel(modelName as TiktokenModel);
  } catch {
    // Fall back to encoding by name
    return getEncoding(fallbackEncoding as TiktokenEncoding);
  }
}

/**
 * Gets the model name for a given model type.
 *
 * @param runtime - The agent runtime
 * @param modelType - The type of model
 * @returns The model name
 */
function getModelName(runtime: IAgentRuntime, modelType: ModelTypeName): string {
  if (modelType === ModelType.TEXT_SMALL) {
    return getSmallModel(runtime);
  }
  return getLargeModel(runtime);
}

// ============================================================================
// Public Functions
// ============================================================================

/**
 * Tokenizes text into an array of token IDs.
 *
 * Uses the appropriate tokenizer based on the model type.
 *
 * @param runtime - The agent runtime
 * @param modelType - The type of model to use for tokenization
 * @param text - The text to tokenize
 * @returns Array of token IDs
 */
export function tokenizeText(
  runtime: IAgentRuntime,
  modelType: ModelTypeName,
  text: string
): number[] {
  const modelName = getModelName(runtime, modelType);
  const encoder = resolveTokenizerEncoding(modelName);
  return encoder.encode(text);
}

/**
 * Detokenizes an array of token IDs back into text.
 *
 * Uses the appropriate tokenizer based on the model type.
 *
 * @param runtime - The agent runtime
 * @param modelType - The type of model to use for detokenization
 * @param tokens - The tokens to decode
 * @returns The decoded text
 */
export function detokenizeText(
  runtime: IAgentRuntime,
  modelType: ModelTypeName,
  tokens: number[]
): string {
  const modelName = getModelName(runtime, modelType);
  const encoder = resolveTokenizerEncoding(modelName);
  return encoder.decode(tokens);
}

/**
 * Counts the number of tokens in a text string.
 *
 * @param runtime - The agent runtime
 * @param modelType - The type of model
 * @param text - The text to count tokens for
 * @returns The token count
 */
export function countTokens(
  runtime: IAgentRuntime,
  modelType: ModelTypeName,
  text: string
): number {
  const tokens = tokenizeText(runtime, modelType, text);
  return tokens.length;
}

/**
 * Truncates text to fit within a token limit.
 *
 * @param runtime - The agent runtime
 * @param modelType - The type of model
 * @param text - The text to truncate
 * @param maxTokens - Maximum number of tokens
 * @returns The truncated text
 */
export function truncateToTokenLimit(
  runtime: IAgentRuntime,
  modelType: ModelTypeName,
  text: string,
  maxTokens: number
): string {
  const tokens = tokenizeText(runtime, modelType, text);
  if (tokens.length <= maxTokens) {
    return text;
  }
  const truncatedTokens = tokens.slice(0, maxTokens);
  return detokenizeText(runtime, modelType, truncatedTokens);
}
