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

type SupportedEncoding = "cl100k_base" | "o200k_base";

function resolveTokenizerEncoding(modelName: string): Tiktoken {
  const normalized = modelName.toLowerCase();
  const fallbackEncoding: SupportedEncoding = normalized.includes("4o")
    ? "o200k_base"
    : "cl100k_base";
  try {
    return encodingForModel(modelName as TiktokenModel);
  } catch {
    return getEncoding(fallbackEncoding as TiktokenEncoding);
  }
}

function getModelName(runtime: IAgentRuntime, modelType: ModelTypeName): string {
  if (modelType === ModelType.TEXT_SMALL) {
    return getSmallModel(runtime);
  }
  return getLargeModel(runtime);
}

export function tokenizeText(
  runtime: IAgentRuntime,
  modelType: ModelTypeName,
  text: string
): number[] {
  const modelName = getModelName(runtime, modelType);
  const encoder = resolveTokenizerEncoding(modelName);
  return encoder.encode(text);
}

export function detokenizeText(
  runtime: IAgentRuntime,
  modelType: ModelTypeName,
  tokens: number[]
): string {
  const modelName = getModelName(runtime, modelType);
  const encoder = resolveTokenizerEncoding(modelName);
  return encoder.decode(tokens);
}

function _countTokens(runtime: IAgentRuntime, modelType: ModelTypeName, text: string): number {
  const tokens = tokenizeText(runtime, modelType, text);
  return tokens.length;
}
