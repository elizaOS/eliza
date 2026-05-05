import type { IAgentRuntime, ModelTypeName, ObjectGenerationParams } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { generateText } from "ai";
import { createAnthropicClient } from "../providers";
import type {
  ExtractedJSON,
  JsonSchema,
  JsonValue,
  ModelName,
  ModelSize,
  ProviderOptions,
} from "../types";
import { isReflectionSchema } from "../types";
import { getLargeModel, getSmallModel } from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import { ensureReflectionProperties, extractAndParseJSON } from "../utils/json";
import { executeWithRetry, formatModelError } from "../utils/retry";

type AnthropicCacheControl = NonNullable<NonNullable<ProviderOptions["anthropic"]>["cacheControl"]>;

interface AnthropicUsageWithCache {
  promptTokens?: number;
  completionTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

interface ObjectGenerationParamsWithProviderOptions extends ObjectGenerationParams {
  providerOptions?: ProviderOptions;
}

function getRuntimeCacheControl(runtime: IAgentRuntime): AnthropicCacheControl | undefined {
  const ttlSetting = runtime.getSetting("ANTHROPIC_PROMPT_CACHE_TTL");
  if (typeof ttlSetting === "string") {
    const ttl = ttlSetting.trim().toLowerCase();
    if (ttl === "5m" || ttl === "1h") {
      return { type: "ephemeral", ttl };
    }
  }
  return undefined;
}

function buildSystemPrompt(characterSystem: string | undefined, isReflection: boolean): string {
  let systemPrompt = characterSystem
    ? `${characterSystem}\nYou must respond with valid JSON only.`
    : "You must respond with valid JSON only.";

  if (isReflection) {
    systemPrompt +=
      " Ensure your response includes 'thought', 'facts', and 'relationships' properties exactly as specified in the prompt.";
  } else {
    systemPrompt += " No markdown, no code blocks, no explanation text.";
  }

  return systemPrompt;
}

function buildJsonPrompt(prompt: string): string {
  if (prompt.includes("```json") || prompt.includes("respond with valid JSON")) {
    return prompt;
  }

  return `${prompt}
Please respond with valid JSON only, without any explanations, markdown formatting, or additional text.`;
}

async function generateObjectByModelType(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
  modelType: ModelTypeName,
  modelName: ModelName,
  _modelSize: ModelSize
): Promise<Record<string, JsonValue>> {
  const anthropic = createAnthropicClient(runtime);
  const operationName = `${modelType} request using ${modelName}`;

  logger.log(`[Anthropic] Using ${modelType} model: ${modelName}`);

  const schema = params.schema as JsonSchema | undefined;
  const isReflection = isReflectionSchema(schema);
  const jsonPrompt = buildJsonPrompt(params.prompt);
  const systemPrompt = buildSystemPrompt(runtime.character.system, isReflection);
  const temperature = params.temperature ?? 0.2;
  const runtimeCacheControl = getRuntimeCacheControl(runtime);
  const rawProviderOptions = (params as ObjectGenerationParamsWithProviderOptions).providerOptions;
  const baseProviderOptions: ProviderOptions = rawProviderOptions
    ? {
        ...rawProviderOptions,
        anthropic: rawProviderOptions.anthropic ? { ...rawProviderOptions.anthropic } : undefined,
      }
    : {};
  const providerOptions: ProviderOptions = {
    ...baseProviderOptions,
    anthropic: {
      ...(baseProviderOptions.anthropic ?? {}),
      ...(!baseProviderOptions.anthropic?.cacheControl && runtimeCacheControl
        ? { cacheControl: runtimeCacheControl }
        : {}),
    },
  };
  const anthropicProviderOptions = providerOptions.anthropic
    ? { anthropic: providerOptions.anthropic }
    : undefined;

  let text: string;
  let usage: AnthropicUsageWithCache | undefined;

  try {
    const response = await executeWithRetry(operationName, () =>
      generateText({
        model: anthropic(modelName),
        messages: [{ role: "user" as const, content: jsonPrompt }],
        system: systemPrompt,
        temperature,
        ...(anthropicProviderOptions ? { providerOptions: anthropicProviderOptions } : {}),
      })
    );

    text = response.text;
    usage = response.usage as AnthropicUsageWithCache | undefined;
  } catch (error) {
    throw formatModelError(operationName, error);
  }

  if (usage) {
    emitModelUsageEvent(runtime, modelType, params.prompt, usage, modelName);
  }

  logger.debug("Attempting to parse response from Anthropic model");
  const jsonObject: ExtractedJSON = extractAndParseJSON(text);

  if (
    typeof jsonObject === "object" &&
    jsonObject !== null &&
    "type" in jsonObject &&
    jsonObject.type === "unstructured_response"
  ) {
    logger.error(`Failed to parse JSON from Anthropic response`);
    logger.error(`Raw response: ${text}`);
    throw new Error("Invalid JSON returned from Anthropic model: could not extract valid JSON");
  }

  const processedObject = ensureReflectionProperties(jsonObject, isReflection);

  return processedObject as Record<string, JsonValue>;
}

export async function handleObjectSmall(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams
): Promise<Record<string, JsonValue>> {
  const modelName = getSmallModel(runtime);
  return generateObjectByModelType(runtime, params, ModelType.OBJECT_SMALL, modelName, "small");
}

export async function handleObjectLarge(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams
): Promise<Record<string, JsonValue>> {
  const modelName = getLargeModel(runtime);
  return generateObjectByModelType(runtime, params, ModelType.OBJECT_LARGE, modelName, "large");
}
