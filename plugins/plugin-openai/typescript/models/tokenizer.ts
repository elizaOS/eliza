/**
 * Tokenizer model handlers
 *
 * Provides text tokenization and detokenization functionality.
 */

import type {
  DetokenizeTextParams,
  IAgentRuntime,
  TokenizeTextParams,
} from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { detokenizeText, tokenizeText } from "../utils/tokenization";

// ============================================================================
// Public Handlers
// ============================================================================

/**
 * Handles TEXT_TOKENIZER_ENCODE requests.
 *
 * Tokenizes text into an array of token IDs using the appropriate
 * tokenizer for the specified model type.
 *
 * @param runtime - The agent runtime
 * @param params - Tokenization parameters
 * @returns Array of token IDs
 * @throws Error if tokenization fails
 */
export async function handleTokenizerEncode(
  runtime: IAgentRuntime,
  params: TokenizeTextParams
): Promise<number[]> {
  // Validate prompt
  if (!params.prompt) {
    throw new Error("Tokenization requires a non-empty prompt");
  }

  const modelType = params.modelType ?? ModelType.TEXT_LARGE;
  return tokenizeText(runtime, modelType, params.prompt);
}

/**
 * Handles TEXT_TOKENIZER_DECODE requests.
 *
 * Decodes an array of token IDs back into text using the appropriate
 * tokenizer for the specified model type.
 *
 * @param runtime - The agent runtime
 * @param params - Detokenization parameters
 * @returns The decoded text
 * @throws Error if detokenization fails
 */
export async function handleTokenizerDecode(
  runtime: IAgentRuntime,
  params: DetokenizeTextParams
): Promise<string> {
  // Validate tokens
  if (!params.tokens || !Array.isArray(params.tokens)) {
    throw new Error("Detokenization requires a valid tokens array");
  }

  if (params.tokens.length === 0) {
    return "";
  }

  // Validate all elements are numbers
  for (let i = 0; i < params.tokens.length; i++) {
    const token = params.tokens[i];
    if (typeof token !== "number" || !Number.isFinite(token)) {
      throw new Error(`Invalid token at index ${i}: expected number`);
    }
  }

  const modelType = params.modelType ?? ModelType.TEXT_LARGE;
  return detokenizeText(runtime, modelType, params.tokens);
}
