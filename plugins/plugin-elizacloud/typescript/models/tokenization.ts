import type {
  DetokenizeTextParams,
  IAgentRuntime,
  ModelTypeName,
  TokenizeTextParams,
} from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { encodingForModel, type TiktokenModel } from "js-tiktoken";

async function tokenizeText(
  model: ModelTypeName,
  prompt: string,
): Promise<number[]> {
  const modelName =
    model === ModelType.TEXT_SMALL
      ? (process.env.ELIZAOS_CLOUD_SMALL_MODEL ??
        process.env.SMALL_MODEL ??
        "gpt-5-nano")
      : (process.env.LARGE_MODEL ?? "gpt-5-mini");
  const tokens = encodingForModel(modelName as TiktokenModel).encode(prompt);
  return tokens;
}

async function detokenizeText(
  model: ModelTypeName,
  tokens: number[],
): Promise<string> {
  const modelName =
    model === ModelType.TEXT_SMALL
      ? (process.env.ELIZAOS_CLOUD_SMALL_MODEL ??
        process.env.SMALL_MODEL ??
        "gpt-5-nano")
      : (process.env.ELIZAOS_CLOUD_LARGE_MODEL ??
        process.env.LARGE_MODEL ??
        "gpt-5-mini");
  return encodingForModel(modelName as TiktokenModel).decode(tokens);
}

export async function handleTokenizerEncode(
  _runtime: IAgentRuntime,
  { prompt, modelType = ModelType.TEXT_LARGE }: TokenizeTextParams,
): Promise<number[]> {
  return await tokenizeText(modelType ?? ModelType.TEXT_LARGE, prompt);
}

export async function handleTokenizerDecode(
  _runtime: IAgentRuntime,
  { tokens, modelType = ModelType.TEXT_LARGE }: DetokenizeTextParams,
): Promise<string> {
  return await detokenizeText(modelType ?? ModelType.TEXT_LARGE, tokens);
}
