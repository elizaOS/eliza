import type {
  GenerateTextParams,
  IAgentRuntime,
  ModelTypeName,
  TextStreamResult,
} from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import {
  generateText,
  type JSONSchema7,
  type LanguageModel,
  type ModelMessage,
  streamText,
  type ToolChoice,
  type ToolSet,
  type UserContent,
} from "ai";

import { createOpenRouterProvider } from "../providers";
import {
  getActionPlannerModel,
  getLargeModel,
  getMediumModel,
  getMegaModel,
  getNanoModel,
  getResponseHandlerModel,
  getSmallModel,
} from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";

const RESPONSES_ROUTED_PREFIXES = ["openai/", "anthropic/"] as const;
const NO_SAMPLING_MODEL_PATTERNS = ["o1", "o3", "o4", "gpt-5", "gpt-5-mini"] as const;
const TEXT_NANO_MODEL_TYPE = (ModelType.TEXT_NANO ?? "TEXT_NANO") as ModelTypeName;
const TEXT_MEDIUM_MODEL_TYPE = (ModelType.TEXT_MEDIUM ?? "TEXT_MEDIUM") as ModelTypeName;
const TEXT_MEGA_MODEL_TYPE = (ModelType.TEXT_MEGA ?? "TEXT_MEGA") as ModelTypeName;
const RESPONSE_HANDLER_MODEL_TYPE = (ModelType.RESPONSE_HANDLER ??
  "RESPONSE_HANDLER") as ModelTypeName;
const ACTION_PLANNER_MODEL_TYPE = (ModelType.ACTION_PLANNER ?? "ACTION_PLANNER") as ModelTypeName;
type ChatAttachment = {
  data: string | Uint8Array | URL;
  mediaType: string;
  filename?: string;
};

type GenerateTextParamsWithAttachments = GenerateTextParams & {
  attachments?: ChatAttachment[];
  messages?: ModelMessage[];
  tools?: ToolSet;
  toolChoice?: ToolChoice<ToolSet>;
  responseSchema?: unknown;
};

type NativeOutput = NonNullable<Parameters<typeof generateText<ToolSet>>[0]["output"]>;
type NativeGenerateTextParams = Parameters<typeof generateText<ToolSet, NativeOutput>>[0];
type NativeStreamTextParams = Parameters<typeof streamText<ToolSet, NativeOutput>>[0];
type NativePrompt =
  | { prompt: string; messages?: never }
  | { messages: ModelMessage[]; prompt?: never };
type NativeTextParams = Omit<NativeGenerateTextParams, "messages" | "prompt"> &
  Omit<NativeStreamTextParams, "messages" | "prompt"> &
  NativePrompt;

type NormalizedUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

type NativeGenerateTextResult = {
  text: string;
  toolCalls?: unknown[];
  finishReason?: string;
  usage?: NormalizedUsage;
};

function buildUserContent(params: GenerateTextParamsWithAttachments): UserContent {
  const content: Array<
    | { type: "text"; text: string }
    | {
        type: "file";
        data: string | Uint8Array | URL;
        mediaType: string;
        filename?: string;
      }
  > = [{ type: "text", text: params.prompt }];

  for (const attachment of params.attachments ?? []) {
    content.push({
      type: "file",
      data: attachment.data,
      mediaType: attachment.mediaType,
      ...(attachment.filename ? { filename: attachment.filename } : {}),
    });
  }

  return content;
}

function supportsSamplingParameters(modelName: string): boolean {
  const lowerModelName = modelName.toLowerCase();

  if (RESPONSES_ROUTED_PREFIXES.some((prefix) => lowerModelName.startsWith(prefix))) {
    return false;
  }

  return !NO_SAMPLING_MODEL_PATTERNS.some((pattern) => lowerModelName.includes(pattern));
}

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

function usesNativeTextResult(params: GenerateTextParamsWithAttachments): boolean {
  return Boolean(params.messages || params.tools || params.toolChoice || params.responseSchema);
}

type TextModelType =
  | typeof TEXT_NANO_MODEL_TYPE
  | typeof ModelType.TEXT_SMALL
  | typeof TEXT_MEDIUM_MODEL_TYPE
  | typeof ModelType.TEXT_LARGE
  | typeof TEXT_MEGA_MODEL_TYPE
  | typeof RESPONSE_HANDLER_MODEL_TYPE
  | typeof ACTION_PLANNER_MODEL_TYPE;

function getModelNameForType(runtime: IAgentRuntime, modelType: TextModelType): string {
  switch (modelType) {
    case TEXT_NANO_MODEL_TYPE:
      return getNanoModel(runtime);
    case TEXT_MEDIUM_MODEL_TYPE:
      return getMediumModel(runtime);
    case ModelType.TEXT_SMALL:
      return getSmallModel(runtime);
    case ModelType.TEXT_LARGE:
      return getLargeModel(runtime);
    case TEXT_MEGA_MODEL_TYPE:
      return getMegaModel(runtime);
    case RESPONSE_HANDLER_MODEL_TYPE:
      return getResponseHandlerModel(runtime);
    case ACTION_PLANNER_MODEL_TYPE:
      return getActionPlannerModel(runtime);
    default:
      return getLargeModel(runtime);
  }
}

function getModelLabelForType(modelType: TextModelType): string {
  switch (modelType) {
    case TEXT_NANO_MODEL_TYPE:
      return "TEXT_NANO";
    case TEXT_MEDIUM_MODEL_TYPE:
      return "TEXT_MEDIUM";
    case ModelType.TEXT_SMALL:
      return "TEXT_SMALL";
    case ModelType.TEXT_LARGE:
      return "TEXT_LARGE";
    case TEXT_MEGA_MODEL_TYPE:
      return "TEXT_MEGA";
    case RESPONSE_HANDLER_MODEL_TYPE:
      return "RESPONSE_HANDLER";
    case ACTION_PLANNER_MODEL_TYPE:
      return "ACTION_PLANNER";
    default:
      return String(modelType);
  }
}

function buildGenerateParams(
  runtime: IAgentRuntime,
  modelType: TextModelType,
  params: GenerateTextParams
) {
  const paramsWithAttachments = params as GenerateTextParamsWithAttachments;
  const { prompt } = params;
  const paramsWithMax = params as GenerateTextParams & {
    maxOutputTokens?: number;
    maxTokens?: number;
  };
  const resolvedMaxOutput = paramsWithMax.maxOutputTokens ?? paramsWithMax.maxTokens ?? 8192;

  const openrouter = createOpenRouterProvider(runtime);
  const modelName = getModelNameForType(runtime, modelType);
  const modelLabel = getModelLabelForType(modelType);
  const supportsSampling = supportsSamplingParameters(modelName);
  const stopSequences =
    Array.isArray(params.stopSequences) && params.stopSequences.length > 0
      ? params.stopSequences
      : undefined;
  const userContent =
    (paramsWithAttachments.attachments?.length ?? 0) > 0
      ? buildUserContent(paramsWithAttachments)
      : undefined;
  const temperature = params.temperature ?? 0.7;
  const frequencyPenalty = params.frequencyPenalty ?? 0.7;
  const presencePenalty = params.presencePenalty ?? 0.7;

  const promptOrMessages: NativePrompt = paramsWithAttachments.messages
    ? { messages: paramsWithAttachments.messages }
    : userContent
      ? { messages: [{ role: "user" as const, content: userContent }] }
      : { prompt };
  const generateParams: NativeTextParams = {
    model: openrouter.chat(modelName) as LanguageModel,
    ...promptOrMessages,
    system: runtime.character?.system ?? undefined,
    ...(supportsSampling
      ? {
          temperature: temperature,
          frequencyPenalty: frequencyPenalty,
          presencePenalty: presencePenalty,
          ...(stopSequences ? { stopSequences } : {}),
        }
      : {}),
    maxOutputTokens: resolvedMaxOutput,
    ...(paramsWithAttachments.tools ? { tools: paramsWithAttachments.tools } : {}),
    ...(paramsWithAttachments.toolChoice ? { toolChoice: paramsWithAttachments.toolChoice } : {}),
    ...(paramsWithAttachments.responseSchema
      ? { output: buildStructuredOutput(paramsWithAttachments.responseSchema) }
      : {}),
  };

  return {
    generateParams,
    modelName,
    modelLabel,
    prompt,
    shouldReturnNativeResult: usesNativeTextResult(paramsWithAttachments),
  };
}

type GenerateParams = ReturnType<typeof buildGenerateParams>["generateParams"];

function handleStreamingGeneration(
  runtime: IAgentRuntime,
  modelType: TextModelType,
  generateParams: GenerateParams,
  prompt: string,
  modelName: string,
  modelLabel: string,
  shouldReturnNativeResult: boolean
): TextStreamResult {
  const streamResult = streamText(generateParams);
  const usagePromise = Promise.resolve(streamResult.usage).then((usage) => {
    if (!usage) {
      return undefined;
    }

    return emitModelUsageEvent(runtime, modelType, prompt, usage, modelName, modelLabel);
  });
  const ignoreUsageError = (): undefined => undefined;

  async function* textStreamWithUsage(): AsyncIterable<string> {
    let completed = false;
    try {
      for await (const chunk of streamResult.textStream) {
        yield chunk;
      }
      completed = true;
    } finally {
      if (completed) {
        await usagePromise.catch(ignoreUsageError);
      }
    }
  }

  return {
    textStream: textStreamWithUsage(),
    text: Promise.resolve(streamResult.text).then(async (text) => {
      await usagePromise.catch(ignoreUsageError);
      return text;
    }),
    ...(shouldReturnNativeResult ? { toolCalls: Promise.resolve(streamResult.toolCalls) } : {}),
    usage: usagePromise,
    finishReason: Promise.resolve(streamResult.finishReason) as Promise<string | undefined>,
  };
}

function buildNativeTextResult(result: {
  text: string;
  toolCalls?: unknown[];
  finishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}): NativeGenerateTextResult {
  const inputTokens = result.usage?.inputTokens ?? result.usage?.promptTokens ?? 0;
  const outputTokens = result.usage?.outputTokens ?? result.usage?.completionTokens ?? 0;

  return {
    text: result.text,
    toolCalls: result.toolCalls ?? [],
    finishReason: result.finishReason,
    usage: result.usage
      ? {
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens: result.usage.totalTokens ?? inputTokens + outputTokens,
        }
      : undefined,
  };
}

async function generateTextWithModel(
  runtime: IAgentRuntime,
  modelType: TextModelType,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  const { generateParams, modelName, modelLabel, prompt, shouldReturnNativeResult } =
    buildGenerateParams(runtime, modelType, params);

  if (params.stream) {
    return handleStreamingGeneration(
      runtime,
      modelType,
      generateParams,
      prompt,
      modelName,
      modelLabel,
      shouldReturnNativeResult
    );
  }

  const response = await generateText(generateParams);

  if (response.usage) {
    emitModelUsageEvent(runtime, modelType, prompt, response.usage, modelName, modelLabel);
  }

  if (shouldReturnNativeResult) {
    return buildNativeTextResult(response) as unknown as string;
  }

  return response.text;
}

export async function handleTextSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextWithModel(runtime, ModelType.TEXT_SMALL, params);
}

export async function handleTextNano(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextWithModel(runtime, TEXT_NANO_MODEL_TYPE, params);
}

export async function handleTextMedium(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextWithModel(runtime, TEXT_MEDIUM_MODEL_TYPE, params);
}

export async function handleTextLarge(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextWithModel(runtime, ModelType.TEXT_LARGE, params);
}

export async function handleTextMega(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextWithModel(runtime, TEXT_MEGA_MODEL_TYPE, params);
}

export async function handleResponseHandler(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextWithModel(runtime, RESPONSE_HANDLER_MODEL_TYPE, params);
}

export async function handleActionPlanner(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string | TextStreamResult> {
  return generateTextWithModel(runtime, ACTION_PLANNER_MODEL_TYPE, params);
}
