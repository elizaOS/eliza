import type {
  GenerateTextParams,
  IAgentRuntime,
  RecordLlmCallDetails,
} from "@elizaos/core";
import * as ElizaCore from "@elizaos/core";
import {
  buildCanonicalSystemPrompt,
  logger,
  recordLlmCall,
  renderChatMessagesForPrompt,
  resolveEffectiveSystemPrompt,
} from "@elizaos/core";
import {
  createGoogleGenAI,
  getActionPlannerModel,
  getLargeModel,
  getMediumModel,
  getMegaModel,
  getNanoModel,
  getResponseHandlerModel,
  getSafetySettings,
  getSmallModel,
} from "../utils/config";
import { emitModelUsageEvent } from "../utils/events";
import { countTokens } from "../utils/tokenization";

const CORE_MODEL_TYPES =
  (ElizaCore as { ModelType?: Record<string, string> }).ModelType ?? {};
const TEXT_NANO_MODEL_TYPE = (CORE_MODEL_TYPES.TEXT_NANO ??
  "TEXT_NANO") as string;
const TEXT_MEDIUM_MODEL_TYPE = (CORE_MODEL_TYPES.TEXT_MEDIUM ??
  "TEXT_MEDIUM") as string;
const TEXT_SMALL_MODEL_TYPE = (CORE_MODEL_TYPES.TEXT_SMALL ??
  "TEXT_SMALL") as string;
const TEXT_LARGE_MODEL_TYPE = (CORE_MODEL_TYPES.TEXT_LARGE ??
  "TEXT_LARGE") as string;
const TEXT_MEGA_MODEL_TYPE = (CORE_MODEL_TYPES.TEXT_MEGA ??
  "TEXT_MEGA") as string;
const RESPONSE_HANDLER_MODEL_TYPE = (CORE_MODEL_TYPES.RESPONSE_HANDLER ??
  "RESPONSE_HANDLER") as string;
const ACTION_PLANNER_MODEL_TYPE = (CORE_MODEL_TYPES.ACTION_PLANNER ??
  "ACTION_PLANNER") as string;

type ChatAttachment = {
  data: string | Uint8Array | URL;
  mediaType: string;
  filename?: string;
};

/**
 * Native Google GenAI tool input. Each function declaration carries a name,
 * description, and JSON Schema parameters object that the model can choose to
 * invoke.
 */
type GoogleFunctionDeclaration = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

type GoogleToolDeclaration = {
  functionDeclarations?: GoogleFunctionDeclaration[];
};

type GenericToolDescriptor = {
  name?: string;
  description?: string;
  parameters?: unknown;
  inputSchema?: unknown;
  function?: { name?: string; description?: string; parameters?: unknown };
};

type GenerateTextParamsWithAttachments = GenerateTextParams & {
  attachments?: ChatAttachment[];
  /** Native or generic tool definitions; converted to Google functionDeclarations. */
  tools?: GenericToolDescriptor[] | GoogleToolDeclaration[] | Record<string, GenericToolDescriptor>;
  /** Tool selection hint: "auto" | "required" | "none" | { type: "tool"; toolName }. */
  toolChoice?:
    | "auto"
    | "required"
    | "none"
    | { type: "tool"; toolName?: string; name?: string };
  /** JSON Schema for structured output; routes through responseJsonSchema. */
  responseSchema?: Record<string, unknown> | { schema: Record<string, unknown> };
};
type GoogleGenAIClient = NonNullable<ReturnType<typeof createGoogleGenAI>>;
type GenerateContentParams = Parameters<
  GoogleGenAIClient["models"]["generateContent"]
>[0];

function normalizeToolsForGoogle(
  tools: GenerateTextParamsWithAttachments["tools"],
): GoogleToolDeclaration[] | undefined {
  if (!tools) return undefined;

  // Already-shaped Google tools: array of { functionDeclarations: [...] }.
  if (
    Array.isArray(tools) &&
    tools.length > 0 &&
    typeof tools[0] === "object" &&
    tools[0] !== null &&
    "functionDeclarations" in (tools[0] as object)
  ) {
    return tools as GoogleToolDeclaration[];
  }

  const flat: GenericToolDescriptor[] = Array.isArray(tools)
    ? (tools as GenericToolDescriptor[])
    : Object.entries(tools).map(([name, value]) => ({ name, ...value }));

  const declarations: GoogleFunctionDeclaration[] = [];
  for (const tool of flat) {
    const name = tool.name ?? tool.function?.name;
    if (!name) {
      throw new Error("[GoogleGenAI] Tool definition is missing a name.");
    }
    const description = tool.description ?? tool.function?.description;
    const parameters = (tool.parameters ??
      tool.inputSchema ??
      tool.function?.parameters ??
      { type: "object", properties: {} }) as Record<string, unknown>;
    declarations.push({
      name,
      ...(description ? { description } : {}),
      parameters,
    });
  }

  return declarations.length > 0 ? [{ functionDeclarations: declarations }] : undefined;
}

function normalizeToolConfigForGoogle(
  toolChoice: GenerateTextParamsWithAttachments["toolChoice"],
): { functionCallingConfig: { mode: "AUTO" | "ANY" | "NONE"; allowedFunctionNames?: string[] } } | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice === "auto") {
    return { functionCallingConfig: { mode: "AUTO" } };
  }
  if (toolChoice === "required") {
    return { functionCallingConfig: { mode: "ANY" } };
  }
  if (toolChoice === "none") {
    return { functionCallingConfig: { mode: "NONE" } };
  }
  const toolName = toolChoice.toolName ?? toolChoice.name;
  if (toolName) {
    return {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [toolName],
      },
    };
  }
  return undefined;
}

function resolveResponseJsonSchema(
  responseSchema: GenerateTextParamsWithAttachments["responseSchema"],
): Record<string, unknown> | undefined {
  if (!responseSchema) return undefined;
  if ("schema" in responseSchema && responseSchema.schema) {
    return responseSchema.schema as Record<string, unknown>;
  }
  return responseSchema as Record<string, unknown>;
}

function buildPromptParts(prompt: string, attachments?: ChatAttachment[]) {
  const parts: Array<
    | { text: string }
    | { fileData: { mimeType: string; fileUri: string } }
    | { inlineData: { mimeType: string; data: string } }
  > = [{ text: prompt }];

  for (const attachment of attachments ?? []) {
    if (attachment.data instanceof URL) {
      parts.push({
        fileData: {
          mimeType: attachment.mediaType,
          fileUri: attachment.data.toString(),
        },
      });
      continue;
    }

    if (
      typeof attachment.data === "string" &&
      /^https?:\/\//i.test(attachment.data)
    ) {
      parts.push({
        fileData: {
          mimeType: attachment.mediaType,
          fileUri: attachment.data,
        },
      });
      continue;
    }

    if (typeof attachment.data === "string") {
      const dataUrlMatch = attachment.data.match(
        /^data:([^;,]+);base64,(.+)$/i,
      );
      parts.push({
        inlineData: {
          mimeType: dataUrlMatch?.[1] ?? attachment.mediaType,
          data: dataUrlMatch?.[2] ?? attachment.data,
        },
      });
      continue;
    }

    parts.push({
      inlineData: {
        mimeType: attachment.mediaType,
        data: Buffer.from(attachment.data).toString("base64"),
      },
    });
  }

  return parts;
}

function resolveGoogleSystemInstruction(
  runtime: IAgentRuntime,
  params: GenerateTextParamsWithAttachments,
): string | undefined {
  return resolveEffectiveSystemPrompt({
    params,
    fallback: buildCanonicalSystemPrompt({ character: runtime.character }),
  });
}

function resolveGooglePrompt(
  params: GenerateTextParamsWithAttachments,
  systemInstruction: string | undefined,
): string {
  return (
    renderChatMessagesForPrompt(params.messages, {
      omitDuplicateSystem: systemInstruction,
    }) ?? params.prompt
  );
}

function getModelNameForType(
  runtime: IAgentRuntime,
  modelType: string,
): string {
  switch (modelType) {
    case TEXT_NANO_MODEL_TYPE:
      return getNanoModel(runtime);
    case TEXT_MEDIUM_MODEL_TYPE:
      return getMediumModel(runtime);
    case TEXT_SMALL_MODEL_TYPE:
      return getSmallModel(runtime);
    case TEXT_LARGE_MODEL_TYPE:
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

function buildGoogleGenerationConfig(
  params: GenerateTextParamsWithAttachments,
  systemInstruction: string | undefined,
  temperature: number,
  maxTokens: number,
  stopSequences: string[],
): NonNullable<GenerateContentParams["config"]> {
  const tools = normalizeToolsForGoogle(params.tools);
  const toolConfig = normalizeToolConfigForGoogle(params.toolChoice);
  const responseJsonSchema = resolveResponseJsonSchema(params.responseSchema);

  const baseConfig: Record<string, unknown> = {
    temperature,
    topK: 40,
    topP: 0.95,
    maxOutputTokens: maxTokens,
    stopSequences,
    safetySettings: getSafetySettings(),
    ...(systemInstruction && { systemInstruction }),
    ...(tools ? { tools } : {}),
    ...(toolConfig ? { toolConfig } : {}),
    ...(responseJsonSchema
      ? {
          responseMimeType: "application/json",
          responseJsonSchema,
        }
      : {}),
  };

  return baseConfig as NonNullable<GenerateContentParams["config"]>;
}

function createLlmCallDetails(
  modelName: string,
  modelType: string,
  prompt: string,
  systemInstruction: string | undefined,
  temperature: number,
  maxTokens: number,
): RecordLlmCallDetails {
  return {
    model: modelName,
    systemPrompt: systemInstruction ?? "",
    userPrompt: prompt,
    temperature,
    maxTokens,
    purpose: "external_llm",
    actionType: `google-genai.${modelType}.generateContent`,
  };
}

async function generateContentWithTrajectory(
  runtime: IAgentRuntime,
  genAI: GoogleGenAIClient,
  modelName: string,
  modelType: string,
  prompt: string,
  systemInstruction: string | undefined,
  temperature: number,
  maxTokens: number,
  request: GenerateContentParams,
): Promise<string> {
  const details = createLlmCallDetails(
    modelName,
    modelType,
    prompt,
    systemInstruction,
    temperature,
    maxTokens,
  );
  const response = await recordLlmCall(runtime, details, async () => {
    const result = await genAI.models.generateContent(request);
    const text = result.text || "";
    details.response = text;
    details.promptTokens = await countTokens(prompt);
    details.completionTokens = await countTokens(text);
    return result;
  });

  const text = response.text || "";
  const promptTokens = details.promptTokens ?? (await countTokens(prompt));
  const completionTokens =
    details.completionTokens ?? (await countTokens(text));

  emitModelUsageEvent(runtime, modelType, prompt, {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  });

  return text;
}

export async function handleTextSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParamsWithAttachments,
): Promise<string> {
  const {
    stopSequences = [],
    maxTokens = 8192,
    temperature = 0.7,
    attachments,
  } = params;
  const genAI = createGoogleGenAI(runtime);
  if (!genAI) {
    throw new Error("Google Generative AI client not initialized");
  }

  const modelName = getModelNameForType(runtime, TEXT_SMALL_MODEL_TYPE);

  logger.log(`[TEXT_SMALL] Using model: ${modelName}`);

  try {
    const systemInstruction = resolveGoogleSystemInstruction(runtime, params);
    const promptText = resolveGooglePrompt(params, systemInstruction);
    return await generateContentWithTrajectory(
      runtime,
      genAI,
      modelName,
      TEXT_SMALL_MODEL_TYPE,
      promptText,
      systemInstruction,
      temperature,
      maxTokens,
      {
        model: modelName,
        contents:
          (attachments?.length ?? 0) > 0
            ? [
                {
                  role: "user",
                  parts: buildPromptParts(promptText, attachments),
                },
              ]
            : promptText,
        config: buildGoogleGenerationConfig(
          params,
          systemInstruction,
          temperature,
          maxTokens,
          stopSequences,
        ),
      },
    );
  } catch (error) {
    logger.error(
      `[TEXT_SMALL] Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

export async function handleTextLarge(
  runtime: IAgentRuntime,
  params: GenerateTextParamsWithAttachments,
): Promise<string> {
  const {
    stopSequences = [],
    maxTokens = 8192,
    temperature = 0.7,
    attachments,
  } = params;
  const genAI = createGoogleGenAI(runtime);
  if (!genAI) {
    throw new Error("Google Generative AI client not initialized");
  }

  const modelName = getModelNameForType(runtime, TEXT_LARGE_MODEL_TYPE);

  logger.log(`[TEXT_LARGE] Using model: ${modelName}`);

  try {
    const systemInstruction = resolveGoogleSystemInstruction(runtime, params);
    const promptText = resolveGooglePrompt(params, systemInstruction);
    return await generateContentWithTrajectory(
      runtime,
      genAI,
      modelName,
      TEXT_LARGE_MODEL_TYPE,
      promptText,
      systemInstruction,
      temperature,
      maxTokens,
      {
        model: modelName,
        contents:
          (attachments?.length ?? 0) > 0
            ? [
                {
                  role: "user",
                  parts: buildPromptParts(promptText, attachments),
                },
              ]
            : promptText,
        config: buildGoogleGenerationConfig(
          params,
          systemInstruction,
          temperature,
          maxTokens,
          stopSequences,
        ),
      },
    );
  } catch (error) {
    logger.error(
      `[TEXT_LARGE] Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

export async function handleTextNano(
  runtime: IAgentRuntime,
  params: GenerateTextParamsWithAttachments,
): Promise<string> {
  return handleTextWithType(runtime, TEXT_NANO_MODEL_TYPE, params);
}

export async function handleTextMedium(
  runtime: IAgentRuntime,
  params: GenerateTextParamsWithAttachments,
): Promise<string> {
  return handleTextWithType(runtime, TEXT_MEDIUM_MODEL_TYPE, params);
}

export async function handleTextMega(
  runtime: IAgentRuntime,
  params: GenerateTextParamsWithAttachments,
): Promise<string> {
  return handleTextWithType(runtime, TEXT_MEGA_MODEL_TYPE, params);
}

export async function handleResponseHandler(
  runtime: IAgentRuntime,
  params: GenerateTextParamsWithAttachments,
): Promise<string> {
  return handleTextWithType(runtime, RESPONSE_HANDLER_MODEL_TYPE, params);
}

export async function handleActionPlanner(
  runtime: IAgentRuntime,
  params: GenerateTextParamsWithAttachments,
): Promise<string> {
  return handleTextWithType(runtime, ACTION_PLANNER_MODEL_TYPE, params);
}

async function handleTextWithType(
  runtime: IAgentRuntime,
  modelType: string,
  params: GenerateTextParamsWithAttachments,
): Promise<string> {
  const {
    stopSequences = [],
    maxTokens = 8192,
    temperature = 0.7,
    attachments,
  } = params;
  const genAI = createGoogleGenAI(runtime);
  if (!genAI) {
    throw new Error("Google Generative AI client not initialized");
  }

  const modelName = getModelNameForType(runtime, modelType);

  logger.log(`[${modelType}] Using model: ${modelName}`);

  try {
    const systemInstruction = resolveGoogleSystemInstruction(runtime, params);
    const promptText = resolveGooglePrompt(params, systemInstruction);
    return await generateContentWithTrajectory(
      runtime,
      genAI,
      modelName,
      modelType,
      promptText,
      systemInstruction,
      temperature,
      maxTokens,
      {
        model: modelName,
        contents:
          (attachments?.length ?? 0) > 0
            ? [
                {
                  role: "user",
                  parts: buildPromptParts(promptText, attachments),
                },
              ]
            : promptText,
        config: buildGoogleGenerationConfig(
          params,
          systemInstruction,
          temperature,
          maxTokens,
          stopSequences,
        ),
      },
    );
  } catch (error) {
    logger.error(
      `[${modelType}] Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}
