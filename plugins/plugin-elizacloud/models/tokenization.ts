import type {
  DetokenizeTextParams,
  IAgentRuntime,
  ModelTypeName,
  TokenizeTextParams,
} from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { DEFAULT_ELIZA_CLOUD_TEXT_MODEL } from "@elizaos/shared";
import { encodingForModel, type TiktokenModel } from "js-tiktoken";

type ProcessEnvLike = Record<string, string | undefined>;

function getProcessEnv(): ProcessEnvLike {
  if (typeof process === "undefined") {
    return {};
  }
  return process.env as ProcessEnvLike;
}

const env = getProcessEnv();

function getConfiguredTokenizerModel(model: ModelTypeName): string {
  return model === ModelType.TEXT_SMALL
    ? (env.ELIZAOS_CLOUD_SMALL_MODEL ?? env.SMALL_MODEL ?? DEFAULT_ELIZA_CLOUD_TEXT_MODEL)
    : (env.ELIZAOS_CLOUD_LARGE_MODEL ?? env.LARGE_MODEL ?? DEFAULT_ELIZA_CLOUD_TEXT_MODEL);
}

function tiktokenCandidates(modelName: string): string[] {
  const slashIndex = modelName.indexOf("/");
  const providerless = slashIndex >= 0 ? modelName.slice(slashIndex + 1) : modelName;
  const baseVariant = providerless.split(":")[0] || providerless;
  return [modelName, providerless, baseVariant, "gpt-4o"];
}

function getEncodingForConfiguredModel(modelName: string) {
  for (const candidate of tiktokenCandidates(modelName)) {
    try {
      return encodingForModel(candidate as TiktokenModel);
    } catch {
      // Try the next compatible tokenizer name.
    }
  }
  return encodingForModel("gpt-4o" as TiktokenModel);
}

async function tokenizeText(model: ModelTypeName, prompt: string): Promise<number[]> {
  const tokens = getEncodingForConfiguredModel(getConfiguredTokenizerModel(model)).encode(prompt);
  return tokens;
}

async function detokenizeText(model: ModelTypeName, tokens: number[]): Promise<string> {
  return getEncodingForConfiguredModel(getConfiguredTokenizerModel(model)).decode(tokens);
}

export async function handleTokenizerEncode(
  _runtime: IAgentRuntime,
  { prompt, modelType = ModelType.TEXT_LARGE }: TokenizeTextParams
): Promise<number[]> {
  return await tokenizeText(modelType ?? ModelType.TEXT_LARGE, prompt);
}

export async function handleTokenizerDecode(
  _runtime: IAgentRuntime,
  { tokens, modelType = ModelType.TEXT_LARGE }: DetokenizeTextParams
): Promise<string> {
  return await detokenizeText(modelType ?? ModelType.TEXT_LARGE, tokens);
}
