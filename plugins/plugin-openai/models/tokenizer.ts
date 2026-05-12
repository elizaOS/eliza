import type { DetokenizeTextParams, IAgentRuntime, TokenizeTextParams } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { detokenizeText, tokenizeText } from "../utils/tokenization";

export async function handleTokenizerEncode(
  runtime: IAgentRuntime,
  params: TokenizeTextParams
): Promise<number[]> {
  if (!params.prompt) {
    throw new Error("Tokenization requires a non-empty prompt");
  }
  const modelType = params.modelType ?? ModelType.TEXT_LARGE;
  return tokenizeText(runtime, modelType, params.prompt);
}

export async function handleTokenizerDecode(
  runtime: IAgentRuntime,
  params: DetokenizeTextParams
): Promise<string> {
  if (!params.tokens || !Array.isArray(params.tokens)) {
    throw new Error("Detokenization requires a valid tokens array");
  }
  if (params.tokens.length === 0) {
    return "";
  }
  for (let i = 0; i < params.tokens.length; i++) {
    const token = params.tokens[i];
    if (typeof token !== "number" || !Number.isFinite(token)) {
      throw new Error(`Invalid token at index ${i}: expected number`);
    }
  }
  const modelType = params.modelType ?? ModelType.TEXT_LARGE;
  return detokenizeText(runtime, modelType, params.tokens);
}
