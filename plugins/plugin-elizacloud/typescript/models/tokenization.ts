import type {
  DetokenizeTextParams,
  IAgentRuntime,
  ModelTypeName,
  TokenizeTextParams,
} from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { encodingForModel, type TiktokenModel } from "js-tiktoken";

type ProcessEnvLike = Record<string, string | undefined>;

function getProcessEnv(): ProcessEnvLike {
  if (typeof process === "undefined") {
    return {};
  }
  return process.env as ProcessEnvLike;
}

const env = getProcessEnv();

async function tokenizeText(
  model: ModelTypeName,
  prompt: string,
): Promise<number[]> {
  const modelName =
    model === ModelType.TEXT_SMALL
      ? (env.ELIZAOS_CLOUD_SMALL_MODEL ?? env.SMALL_MODEL ?? "gpt-5-nano")
      : (env.LARGE_MODEL ?? "gpt-5-mini");
  const tokens = encodingForModel(modelName as TiktokenModel).encode(prompt);
  return tokens;
}

async function detokenizeText(
  model: ModelTypeName,
  tokens: number[],
): Promise<string> {
  const modelName =
    model === ModelType.TEXT_SMALL
      ? (env.ELIZAOS_CLOUD_SMALL_MODEL ?? env.SMALL_MODEL ?? "gpt-5-nano")
      : (env.ELIZAOS_CLOUD_LARGE_MODEL ?? env.LARGE_MODEL ?? "gpt-5-mini");
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
