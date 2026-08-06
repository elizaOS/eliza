import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai, type XaiProvider as NativeXaiProvider } from "@ai-sdk/xai";
import { generateText } from "ai";
import { getReasoningEffortForModel } from "../utils/settings";
import {
  DEFAULT_PROVIDER,
  getEffectiveReasoningEffort,
  getModelInfo,
  getProviderDefinition,
  type ModelDefinition,
  normalizeModelId,
  type ProviderId,
  resolveModelRoute,
} from "./models";

type XaiChatModel = ReturnType<NativeXaiProvider["chat"]>;
type XaiResponsesModel = ReturnType<NativeXaiProvider["responses"]>;
type XaiImageModel = ReturnType<NativeXaiProvider["image"]>;
type XaiVideoModel = ReturnType<NativeXaiProvider["video"]>;

export interface ClawdProvider {
  id: ProviderId;
  name: string;
  baseURL?: string;
  chat: (modelId: string) => XaiChatModel;
  responses?: NativeXaiProvider["responses"];
  image?: (modelId: string) => XaiImageModel;
  video?: (modelId: string) => XaiVideoModel;
  tools?: NativeXaiProvider["tools"];
}

export type { ClawdProvider as XaiProvider };

const DEFAULT_TITLE_MODEL = "grok-4.20-non-reasoning";
const DEFAULT_RECAP_MODEL = "grok-4.20-non-reasoning";
const RETIRED_MODEL_MAP: Record<string, string> = {
  "grok-4-0709": "grok-4.3",
  "grok-code-fast-1": "grok-4.3",
  "grok-4-1-fast-reasoning": "grok-4.3",
  "grok-3": "grok-4.20-non-reasoning",
};

type ProviderReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface ResolvedModelRuntime {
  model: XaiChatModel | XaiResponsesModel;
  modelId: string;
  modelInfo: ModelDefinition | undefined;
  provider: ProviderId;
  providerOptions?: {
    xai?: {
      reasoningEffort?: ProviderReasoningEffort;
    };
  };
}

export function createProvider(
  apiKey: string,
  baseURL?: string,
  providerId: ProviderId = DEFAULT_PROVIDER,
): ClawdProvider {
  const definition = getProviderDefinition(providerId);
  const resolvedBaseURL = baseURL || definition.defaultBaseURL || undefined;

  if (providerId === "xai") {
    const native = createXai({
      apiKey,
      baseURL: resolvedBaseURL || process.env.AI_BASE_URL || process.env.GROK_BASE_URL || "https://api.x.ai/v1",
    });
    return {
      id: "xai",
      name: definition.name,
      baseURL: resolvedBaseURL,
      chat: native.chat.bind(native),
      responses: native.responses.bind(native),
      image: native.image.bind(native),
      video: native.video.bind(native),
      tools: native.tools,
    };
  }

  const compatible = createOpenAICompatible({
    name: providerId,
    apiKey,
    baseURL: resolvedBaseURL ?? "",
    includeUsage: true,
  });

  return {
    id: providerId,
    name: definition.name,
    baseURL: resolvedBaseURL,
    chat: (modelId: string) => compatible.chatModel(modelId) as XaiChatModel,
  };
}

export function resolveModelRuntime(provider: ClawdProvider, modelId: string): ResolvedModelRuntime {
  const routed = resolveModelRoute(RETIRED_MODEL_MAP[modelId] ?? modelId, provider.id);
  const normalizedModelId = normalizeModelId(routed.modelId);
  const info = getModelInfo(normalizedModelId);
  const chatModel = provider.chat(normalizedModelId);
  const normalizedFromAlias = normalizedModelId !== modelId;
  const configuredEffort = getReasoningEffortForModel(normalizedModelId);
  const reasoningEffort = provider.id === "xai" && !normalizedFromAlias
    ? (getEffectiveReasoningEffort(normalizedModelId, configuredEffort) as ProviderReasoningEffort | undefined)
    : undefined;

  return {
    model: chatModel,
    modelId: normalizedModelId,
    modelInfo: info,
    provider: routed.provider,
    providerOptions: reasoningEffort
      ? {
          xai: {
            reasoningEffort,
          },
        }
      : undefined,
  };
}

export function resolveResponsesRuntime(provider: ClawdProvider, modelId: string): ResolvedModelRuntime {
  const runtime = resolveModelRuntime(provider, modelId);
  if (!provider.responses) {
    return runtime;
  }
  const normalizedFromAlias = runtime.modelId !== modelId;
  const configuredEffort = getReasoningEffortForModel(runtime.modelId);
  const reasoningEffort =
    provider.id === "xai" && !normalizedFromAlias
      ? (getEffectiveReasoningEffort(runtime.modelId, configuredEffort) as ProviderReasoningEffort | undefined)
      : undefined;

  return {
    ...runtime,
    model: provider.responses(runtime.modelId),
    providerOptions: reasoningEffort
      ? {
          xai: {
            reasoningEffort,
          },
        }
      : undefined,
  };
}

export interface TitleResult {
  title: string;
  modelId: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

export async function generateTitle(
  provider: ClawdProvider,
  userMessage: string,
  modelId = DEFAULT_TITLE_MODEL,
): Promise<TitleResult> {
  try {
    const result = await generateText({
      model: provider.chat(modelId),
      system: "Generate a short, descriptive title (max 6 words) for this conversation. Return only the title.",
      messages: [{ role: "user", content: userMessage.slice(0, 500) }],
      maxOutputTokens: 32,
    });

    return {
      title: result.text?.trim() || "New session",
      modelId,
      usage: result.usage
        ? {
            inputTokens:
              (result.usage as { inputTokens?: number; promptTokens?: number }).inputTokens ??
              (result.usage as { promptTokens?: number }).promptTokens,
            outputTokens:
              (result.usage as { outputTokens?: number; completionTokens?: number }).outputTokens ??
              (result.usage as { completionTokens?: number }).completionTokens,
            totalTokens: result.usage.totalTokens,
          }
        : undefined,
    };
  } catch {
    return { title: "New session", modelId };
  }
}

export interface RecapResult {
  recap?: string;
  modelId: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

export async function generateRecap(
  provider: ClawdProvider,
  prompt: string,
  signal?: AbortSignal,
  modelId = DEFAULT_RECAP_MODEL,
): Promise<RecapResult> {
  try {
    const result = await generateText({
      model: provider.chat(modelId),
      prompt,
      maxOutputTokens: 120,
      abortSignal: signal,
      system: "You generate concise session recaps. Maximum 3 sentences total. Return only the recap text.",
    });

    return {
      recap: result.text?.trim().replace(/^["']|["']$/g, "") || "",
      modelId,
      usage: result.usage
        ? {
            inputTokens:
              (result.usage as { inputTokens?: number; promptTokens?: number }).inputTokens ??
              (result.usage as { promptTokens?: number }).promptTokens,
            outputTokens:
              (result.usage as { outputTokens?: number; completionTokens?: number }).outputTokens ??
              (result.usage as { completionTokens?: number }).completionTokens,
            totalTokens: result.usage.totalTokens,
          }
        : undefined,
    };
  } catch {
    return { recap: "", modelId };
  }
}
