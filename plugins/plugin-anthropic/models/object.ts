import type { IAgentRuntime, ModelTypeName, ObjectGenerationParams } from "@elizaos/core";
import {
  buildCanonicalSystemPrompt,
  logger,
  ModelType,
  resolveEffectiveSystemPrompt,
} from "@elizaos/core";
import { generateText, type JSONSchema7, type ModelMessage, type ToolSet } from "ai";
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
  messages?: ModelMessage[];
  responseSchema?: unknown;
}

type NativeOutput = NonNullable<Parameters<typeof generateText<ToolSet>>[0]["output"]>;
type NativePrompt =
  | { prompt: string; messages?: never }
  | { messages: ModelMessage[]; prompt?: never };
type NativeGenerateTextParams = Omit<
  Parameters<typeof generateText<ToolSet, NativeOutput>>[0],
  "messages" | "prompt"
> &
  NativePrompt;
type NativeProviderOptions = NativeGenerateTextParams["providerOptions"];

function buildStructuredOutput(responseSchema: unknown): NativeOutput {
  if (
    responseSchema &&
    typeof responseSchema === "object" &&
    "responseFormat" in responseSchema &&
    "parseCompleteOutput" in responseSchema
  ) {
    return responseSchema as NativeOutput;
  }

  const schemaOptions =
    responseSchema && typeof responseSchema === "object" && "schema" in responseSchema
      ? (responseSchema as { schema: unknown; name?: string; description?: string })
      : { schema: responseSchema };

  return {
    name: "object",
    responseFormat: Promise.resolve({
      type: "json" as const,
      schema: schemaOptions.schema as JSONSchema7,
      ...(schemaOptions.name ? { name: schemaOptions.name } : {}),
      ...(schemaOptions.description ? { description: schemaOptions.description } : {}),
    }),
    async parseCompleteOutput({ text }: { text: string }) {
      return JSON.parse(text);
    },
    async parsePartialOutput(): Promise<undefined> {
      return undefined;
    },
    createElementStreamTransform(): undefined {
      return undefined;
    },
  } satisfies NativeOutput;
}

function resolveResponseSchema(params: ObjectGenerationParamsWithProviderOptions): unknown {
  const responseSchema = params.responseSchema ?? params.schema;
  if (responseSchema && typeof responseSchema === "object" && "schema" in responseSchema) {
    return (responseSchema as { schema: unknown }).schema;
  }
  return responseSchema;
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
  const characterSystem = resolveEffectiveSystemPrompt({
    params,
    fallback: buildCanonicalSystemPrompt({ character: runtime.character }),
  });
  const systemPrompt = buildSystemPrompt(characterSystem, isReflection);
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
  const responseSchema = resolveResponseSchema(params as ObjectGenerationParamsWithProviderOptions);

  let text: string;
  let usage: AnthropicUsageWithCache | undefined;

  try {
    const promptOrMessages: NativePrompt = (params as ObjectGenerationParamsWithProviderOptions)
      .messages
      ? { messages: (params as ObjectGenerationParamsWithProviderOptions).messages }
      : { messages: [{ role: "user" as const, content: jsonPrompt }] };
    const generateParams: NativeGenerateTextParams = {
      model: anthropic(modelName),
      ...promptOrMessages,
      system: systemPrompt,
      temperature,
      ...(responseSchema ? { output: buildStructuredOutput(responseSchema) } : {}),
      ...(anthropicProviderOptions
        ? { providerOptions: anthropicProviderOptions as NativeProviderOptions }
        : {}),
    };
    const response = await executeWithRetry(operationName, () => generateText(generateParams));

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
