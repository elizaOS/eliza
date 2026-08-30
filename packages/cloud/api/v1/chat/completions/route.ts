/** Implements the OpenAI-compatible chat-completions boundary and its streaming accounting. */
import { Hono } from "hono";
import { resolveInferenceAuthStandingDenial } from "@/api-app/lib/generative-route-auth";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * OpenAI-compatible chat completions endpoint.
 *
 * Uses AI SDK with AI Gateway for all LLM calls.
 * Real-time usage data from SDK responses for accurate billing.
 * Includes 20% platform markup on all costs.
 *
 * IMPORTANT: Do NOT call provider APIs directly. Always use AI SDK.
 */

import {
  APICallError,
  generateText,
  jsonSchema,
  type ModelMessage,
  RetryError,
  type StepResult,
  streamText,
  type ToolSet,
} from "ai";
import { getErrorStatusCode } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { createPreflightResponse } from "@/lib/middleware/cors-apps";
import {
  enforceOrgRateLimit,
  OrgRateLimitCacheNotReadyError,
} from "@/lib/middleware/rate-limit";
import { recordCloudStreamMilestones } from "@/lib/observability/cloud-backend-observability";
import {
  bindGatewayHandoffTelemetry,
  type GatewayHandoffTelemetry,
  type GatewayPreforwardTiming,
  invokeAtGatewayHandoff,
  resolveElizaTraceId,
  snapshotGatewayPreforwardTiming,
  withGatewayPreforwardTelemetry,
  withInferenceAuthTelemetry,
} from "@/lib/observability/http-telemetry";
import {
  calculateCost,
  estimateTokens,
  getProviderFromModel,
  getSafeModelParams,
  modelUsesReasoningTokens,
  normalizeModelName,
} from "@/lib/pricing";
import {
  mergeAnthropicCotProviderOptions,
  resolveAnthropicThinkingBudgetTokens,
} from "@/lib/providers/anthropic-thinking";
import {
  ANTHROPIC_WEB_SEARCH_INPUT_TOKEN_BUFFER,
  buildProviderNativeWebSearchTools,
  isAnthropicWebSearchEnabled,
} from "@/lib/providers/anthropic-web-search";
import {
  canonicalizeCerebrasModelId,
  getAiProviderConfigurationError,
  getLanguageModel,
  hasLanguageModelProviderConfigured,
  isProviderConfigurationError,
  type PooledLanguageModelCredential,
  resolveAiProviderSource,
  resolvePassthroughUpstreamForModel,
  resolvePooledDirectProviderForModel,
} from "@/lib/providers/language-model";
import {
  type AIUsage,
  type BillingContext,
  billUsage,
  estimateInputTokens,
  InsufficientCreditsError,
  recordUsageAnalytics,
} from "@/lib/services/ai-billing";
import { aiBillingRecordsService } from "@/lib/services/ai-billing-records";
import {
  AiPricingCacheUnavailableError,
  AiPricingCacheWarmingError,
} from "@/lib/services/ai-pricing/cache";
import type { PricingBillingSource } from "@/lib/services/ai-pricing-definitions";
import { appCreditsService } from "@/lib/services/app-credits";
import {
  admitAppInferenceCacheOnly,
  assertInferenceAppAffiliateSupported,
  InferenceAppAffiliateUnsupportedError,
} from "@/lib/services/app-inference-admission";
import { appsService } from "@/lib/services/apps";
import { contentModerationService } from "@/lib/services/content-moderation";
import type {
  CreditReconciliationResult,
  CreditReservation,
} from "@/lib/services/credits";
import { isInferenceAdmissionDispatchMarkError } from "@/lib/services/inference-admission-gate";
import { inferenceRateLimitConfig } from "@/lib/services/inference-admission-snapshot";
import type { InferenceAdmissionSnapshot } from "@/lib/services/inference-auth-cache";
import {
  type InferenceAuthTelemetry,
  resolveInferenceAuthContext,
} from "@/lib/services/inference-auth-context";
import { InferenceBalanceCacheWarmingError } from "@/lib/services/inference-billing-fast-path";
import {
  assertInferenceCredentialActive,
  type InferenceCredentialCheck,
  InferenceCredentialRevokedError,
  inferenceCredentialRevocationReason,
  isInferenceStrongRevocationEnabled,
} from "@/lib/services/inference-credential-revocation";
import {
  createPassthroughStreamMeter,
  isPassthroughStreamingEnabled,
  type PassthroughStreamTail,
} from "@/lib/services/inference-passthrough";
import {
  isKnownUnacceptedProviderError,
  isKnownUnacceptedProviderStatus,
} from "@/lib/services/inference-provider-outcome";
import {
  getCachedGatewayModelById,
  getGatewayModelByIdCacheOnly,
} from "@/lib/services/model-catalog";
import { admitOrganizationInference } from "@/lib/services/organization-inference-admission";
import {
  getTeamPoolRegistry,
  type SelectedPooledCredential,
} from "@/lib/services/team-credential-pool";
import { createCreditReservationSettler } from "@/lib/utils/credit-reservation";
import { logger } from "@/lib/utils/logger";
import { getRouteTimeoutMs } from "@/lib/utils/request-timeout";
import { settleOffResponsePath } from "@/lib/utils/settle-off-response-path";

const ROUTE_MAX_DURATION = 800;

interface PooledInferenceCredential extends PooledLanguageModelCredential {
  organizationId: string;
  credentialId: string;
  label: string;
}

type PooledInferenceCredentialResolution =
  | { kind: "ready"; credential: PooledInferenceCredential | null }
  | { kind: "warming" | "unavailable" };

function buildProviderReconciliationMetadata(
  provider: string,
  model: string,
  streaming: boolean,
  appId?: string | null,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    route: "chat_completions",
    streaming,
    appId: appId ?? null,
  };
  if (provider === "vast" || model.startsWith("vast/")) {
    metadata.vastEndpointName = process.env.VAST_ENDPOINT_NAME ?? null;
    metadata.vastTemplateId = process.env.VAST_TEMPLATE_ID ?? null;
    metadata.vastWorkergroupId = process.env.VAST_WORKERGROUP_ID ?? null;
  }
  return metadata;
}

function buildProviderBillingFields(
  provider: string,
  model: string,
): {
  providerInstanceId?: string | null;
  providerEndpoint?: string | null;
} {
  if (provider !== "vast" && !model.startsWith("vast/")) {
    return {};
  }
  return {
    providerInstanceId:
      process.env.VAST_PROVIDER_INSTANCE_ID ??
      process.env.VAST_INSTANCE_ID ??
      null,
    providerEndpoint:
      process.env.VAST_PROVIDER_ENDPOINT ??
      process.env.VAST_ENDPOINT_URL ??
      process.env.VAST_BASE_URL ??
      null,
  };
}

function buildChatBillingContext(params: {
  user: { id: string; organization_id: string };
  apiKey: { id: string } | null;
  model: string;
  provider: string;
  billingSource: PricingBillingSource;
  requestId: string;
  appId: string | null;
  affiliateCode: string | null;
  streaming: boolean;
}): BillingContext {
  return {
    organizationId: params.user.organization_id,
    userId: params.user.id,
    apiKeyId: params.apiKey?.id,
    model: params.model,
    provider: params.provider,
    billingSource: params.billingSource,
    requestId: params.requestId,
    metadata: buildProviderReconciliationMetadata(
      params.provider,
      params.model,
      params.streaming,
      params.appId,
    ),
    affiliateCode: params.affiliateCode,
    ...buildProviderBillingFields(params.provider, params.model),
  };
}

function buildChatPromptForBilling(request: ChatRequest): string {
  return request.messages
    .map((m) => `[${m.role}] ${getMessageContent(m)}`)
    .join("\n");
}

type ReasoningEffort = "none" | "low" | "medium" | "high";

const CEREBRAS_REASONING_EFFORTS = {
  "gemma-4-31b": ["none", "low", "medium", "high"],
  "gpt-oss-120b": ["low", "medium", "high"],
  "zai-glm-4.7": ["none"],
} as const satisfies Record<string, readonly ReasoningEffort[]>;

type ReasoningEffortValidation =
  | { ok: true; value: ReasoningEffort | undefined }
  | { ok: false; message: string };

/**
 * Validate the OpenAI-compatible reasoning knob against Cerebras's per-model
 * contract before reserving credits or contacting the provider.
 *
 * Cerebras intentionally exposes different values for each served model:
 * Gemma can toggle reasoning, GPT-OSS always reasons at a selected effort, and
 * GLM accepts only `none` as an explicit override (omission enables reasoning).
 * Treat `null` like omission, matching the nullable upstream API field.
 * Source: https://inference-docs.cerebras.ai/capabilities/reasoning
 */
function validateCerebrasReasoningEffort(
  model: string,
  value: unknown,
): ReasoningEffortValidation {
  if (value == null) return { ok: true, value: undefined };

  const modelId = canonicalizeCerebrasModelId(model);
  const allowed =
    CEREBRAS_REASONING_EFFORTS[
      modelId as keyof typeof CEREBRAS_REASONING_EFFORTS
    ];
  if (!allowed) {
    return {
      ok: false,
      message: `reasoning_effort is not supported for model '${model}'`,
    };
  }
  if (
    typeof value !== "string" ||
    !(allowed as readonly string[]).includes(value)
  ) {
    return {
      ok: false,
      message: `reasoning_effort for model '${modelId}' must be one of: ${allowed.join(", ")}`,
    };
  }
  return { ok: true, value: value as ReasoningEffort };
}

/** AI SDK's OpenAI provider maps this option to wire `reasoning_effort`. */
function buildReasoningEffortProviderOptions(
  reasoningEffort: ReasoningEffort | undefined,
): Record<string, unknown> {
  return reasoningEffort
    ? {
        providerOptions: {
          openai: { reasoningEffort },
        },
      }
    : {};
}

/**
 * Merges spreadable `{ providerOptions }` fragments (Anthropic CoT +
 * prompt-cache-key, OpenAI-style reasoning effort) into one spread so a naive
 * `...a, ...b` cannot clobber the earlier fragment's `providerOptions` key.
 * Merge each provider namespace one level deeper as well: prompt caching and
 * reasoning effort both target `openai`, so replacing that namespace would
 * silently discard whichever option was added first.
 */
function combineProviderOptions(
  ...parts: ReadonlyArray<Record<string, unknown>>
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const providerOptions: Record<string, unknown> = {};
  let hasProviderOptions = false;
  for (const part of parts) {
    for (const [key, value] of Object.entries(part)) {
      if (key === "providerOptions" && value && typeof value === "object") {
        for (const [provider, options] of Object.entries(
          value as Record<string, unknown>,
        )) {
          const existing = providerOptions[provider];
          providerOptions[provider] =
            existing &&
            typeof existing === "object" &&
            !Array.isArray(existing) &&
            options &&
            typeof options === "object" &&
            !Array.isArray(options)
              ? {
                  ...(existing as Record<string, unknown>),
                  ...(options as Record<string, unknown>),
                }
              : options;
        }
        hasProviderOptions = true;
      } else {
        merged[key] = value;
      }
    }
  }
  return hasProviderOptions ? { ...merged, providerOptions } : merged;
}

/** Preserves the caller's explicit output ceiling without inventing one. */
function computeEffectiveMaxTokens(
  requestMaxTokens: number | undefined,
  _cotBudget: number | null,
  _model: string,
  _supportedParameters?: readonly string[],
  _reasoningEffort?: ReasoningEffort,
): number | undefined {
  return requestMaxTokens;
}

// ============================================================================
// Types
// ============================================================================

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content:
    | null
    | string
    | Array<{
        type: string;
        text?: string;
        image_url?: { url: string } | string;
        file?: { filename?: string; file_data?: string; file_id?: string };
      }>;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  /** Cerebras prompt-cache routing hint (camelCase accepted for compatibility). */
  prompt_cache_key?: unknown;
  promptCacheKey?: unknown;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  /** Cerebras model-specific control for hidden reasoning generation. */
  reasoning_effort?: ReasoningEffort | null;
  stream?: boolean;
  /**
   * OpenAI `stream_options`: when `include_usage` is true the stream carries
   * `usage: null` on every chunk and one extra terminal chunk (empty `choices`)
   * with the real token usage, before `data: [DONE]` — this is how streaming
   * clients meter token spend (plugin-elizacloud requests it on every
   * streamed call).
   */
  stream_options?: { include_usage?: boolean };
  stop?: string | string[];
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  }>;
  tool_choice?:
    | "auto"
    | "none"
    | "required"
    | { type: "function"; function: { name: string } };
  response_format?:
    | { type: "json_object" | "text" }
    | {
        type: "json_schema";
        json_schema: {
          name?: string;
          description?: string;
          schema?: Record<string, unknown>;
          strict?: boolean;
        };
      };
  /** Enable provider-native web search. Defaults to false. */
  webSearchEnabled?: boolean;
  /** Optional max search budget for provider-native web search. */
  webSearchMaxUses?: number;
}

function resolvePromptCacheKey(
  request: ChatRequest,
): { key?: string } | { error: string } {
  const hasCanonical = Object.hasOwn(request, "prompt_cache_key");
  const value = hasCanonical
    ? request.prompt_cache_key
    : request.promptCacheKey;
  if (value === undefined && !hasCanonical) return {};
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    return {
      error:
        "prompt_cache_key must be a nonempty string of at most 1024 characters",
    };
  }
  return { key: value };
}

function mergePromptCacheProviderOptions(
  base: ReturnType<typeof mergeAnthropicCotProviderOptions>,
  key: string | undefined,
): ReturnType<typeof mergeAnthropicCotProviderOptions> {
  if (!key) return base;
  const providerOptions =
    "providerOptions" in base && base.providerOptions
      ? { ...base.providerOptions }
      : {};
  providerOptions.openai = {
    ...(providerOptions.openai ?? {}),
    promptCacheKey: key,
  };
  providerOptions.cerebras = {
    ...(providerOptions.cerebras ?? {}),
    prompt_cache_key: key,
    promptCacheKey: key,
  };
  providerOptions.eliza = {
    ...(providerOptions.eliza ?? {}),
    promptCacheKey: key,
  };
  return { ...base, providerOptions };
}

function redactPromptCacheKey(value: string, key: string | undefined): string {
  return key ? value.replaceAll(key, "[REDACTED_PROMPT_CACHE_KEY]") : value;
}

// ============================================================================
// CORS
// ============================================================================

async function __next_OPTIONS(request: Request) {
  const origin = request.headers.get("origin");
  return createPreflightResponse(origin, ["POST", "OPTIONS"]);
}

function addCorsHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-API-Key, X-App-Id, X-Request-ID",
  );
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ============================================================================
// Message Conversion
// ============================================================================

/**
 * Infer image media type from URL
 */
function inferImageMediaType(url: string): string {
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.includes(".png") || lowerUrl.includes("image/png"))
    return "image/png";
  if (lowerUrl.includes(".gif") || lowerUrl.includes("image/gif"))
    return "image/gif";
  if (lowerUrl.includes(".webp") || lowerUrl.includes("image/webp"))
    return "image/webp";
  if (lowerUrl.includes(".svg") || lowerUrl.includes("image/svg"))
    return "image/svg+xml";
  // Default to JPEG for .jpg, .jpeg, or unknown
  return "image/jpeg";
}

function getImageUrl(imageUrl: { url: string } | string): string | null {
  if (typeof imageUrl === "string") {
    return imageUrl || null;
  }
  return imageUrl.url || null;
}

function inferFileMediaType(
  fileData: string | undefined,
  filename: string | undefined,
): string {
  const dataUrlMatch = fileData?.match(/^data:([^;,]+)[;,]/i);
  if (dataUrlMatch?.[1]) {
    return dataUrlMatch[1];
  }

  const lowerFilename = filename?.toLowerCase() ?? "";
  if (lowerFilename.endsWith(".pdf")) return "application/pdf";
  if (lowerFilename.endsWith(".png")) return "image/png";
  if (lowerFilename.endsWith(".gif")) return "image/gif";
  if (lowerFilename.endsWith(".webp")) return "image/webp";
  if (lowerFilename.endsWith(".jpg") || lowerFilename.endsWith(".jpeg")) {
    return "image/jpeg";
  }

  return "application/octet-stream";
}

function parseToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toOpenAIArguments(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return "{}";
  }
}

function toModelContentParts(
  content: Exclude<ChatMessage["content"], string | null>,
) {
  return content
    .map((part) => {
      if (part.image_url) {
        const imageUrl = getImageUrl(part.image_url);
        if (!imageUrl) {
          logger.warn("[chat/completions] Ignoring image part without url");
          return null;
        }
        return {
          type: "file" as const,
          data: imageUrl,
          mediaType: inferImageMediaType(imageUrl),
        };
      }
      if (part.file) {
        const fileUrl = part.file.file_data;
        if (!fileUrl) {
          logger.warn(
            "[chat/completions] Ignoring file part without file_data",
            {
              filename: part.file.filename,
              hasFileId: typeof part.file.file_id === "string",
            },
          );
          return null;
        }
        return {
          type: "file" as const,
          data: fileUrl,
          filename: part.file.filename,
          mediaType: inferFileMediaType(fileUrl, part.file.filename),
        };
      }
      if (part.text) {
        return { type: "text" as const, text: part.text };
      }
      return null;
    })
    .filter((part): part is NonNullable<typeof part> => part !== null);
}

function convertToModelMessagesFromOpenAI(
  messages: ChatMessage[],
): ModelMessage[] {
  const modelMessages: ModelMessage[] = [];
  const toolNames = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      for (const toolCall of msg.tool_calls) {
        toolNames.set(toolCall.id, toolCall.function.name);
      }
    }
  }

  for (const msg of messages) {
    // Handle simple string content
    if (msg.role === "system") {
      modelMessages.push({ role: "system", content: getMessageContent(msg) });
      continue;
    }

    if (msg.role === "tool") {
      modelMessages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: msg.tool_call_id ?? crypto.randomUUID(),
            toolName: toolNames.get(msg.tool_call_id ?? "") ?? "unknown_tool",
            output: { type: "text", value: getMessageContent(msg) },
          },
        ],
      } as ModelMessage);
      continue;
    }

    const parts =
      typeof msg.content === "string" || msg.content == null
        ? msg.content
          ? [{ type: "text" as const, text: msg.content }]
          : []
        : toModelContentParts(msg.content);

    if (msg.role === "assistant") {
      const assistantParts = [
        ...parts,
        ...(msg.tool_calls ?? []).map((toolCall) => ({
          type: "tool-call" as const,
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          input: parseToolArguments(toolCall.function.arguments),
        })),
      ];
      modelMessages.push({
        role: "assistant",
        content:
          assistantParts.length > 0
            ? assistantParts
            : [{ type: "text", text: "" }],
      } as ModelMessage);
      continue;
    }

    modelMessages.push({
      role: "user",
      content: parts.length > 0 ? parts : [{ type: "text", text: "" }],
    } as ModelMessage);
  }

  return modelMessages;
}

function convertTools(tools: ChatRequest["tools"]) {
  if (!tools?.length) return undefined;

  return Object.fromEntries(
    tools.map((tool) => [
      tool.function.name,
      {
        ...(tool.function.description
          ? { description: tool.function.description }
          : {}),
        inputSchema: jsonSchema(tool.function.parameters ?? { type: "object" }),
        outputSchema: jsonSchema({
          type: "object",
          additionalProperties: true,
        }),
      },
    ]),
  );
}

function mapToolChoice(
  toolChoice: ChatRequest["tool_choice"],
):
  | "auto"
  | "none"
  | "required"
  | { type: "tool"; toolName: string }
  | undefined {
  if (!toolChoice) return undefined;
  if (
    toolChoice === "auto" ||
    toolChoice === "none" ||
    toolChoice === "required"
  ) {
    return toolChoice;
  }
  return { type: "tool", toolName: toolChoice.function.name };
}

function mapResponseFormat(responseFormat: ChatRequest["response_format"]) {
  if (!responseFormat || responseFormat.type === "text") return undefined;
  const schema =
    responseFormat.type === "json_schema"
      ? (responseFormat.json_schema.schema ?? { type: "object" })
      : { type: "object", additionalProperties: true };
  const name =
    responseFormat.type === "json_schema"
      ? responseFormat.json_schema.name
      : undefined;
  const description =
    responseFormat.type === "json_schema"
      ? responseFormat.json_schema.description
      : undefined;

  const output = {
    name: "object",
    responseFormat: Promise.resolve({
      type: "json" as const,
      schema,
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    }),
    async parseCompleteOutput({ text }: { text: string }) {
      return JSON.parse(text);
    },
    async parsePartialOutput({ text }: { text: string }) {
      try {
        return { partial: JSON.parse(text) };
      } catch {
        return undefined;
      }
    },
    createElementStreamTransform() {
      return undefined;
    },
  };

  if (responseFormat.type === "json_object") {
    return output;
  }
  return output;
}

function formatOpenAIUsage(
  billing: { inputTokens: number; outputTokens: number; totalTokens: number },
  usage: unknown,
) {
  const record =
    usage && typeof usage === "object"
      ? (usage as Record<string, unknown>)
      : {};
  const inputTokenDetails =
    record.inputTokenDetails && typeof record.inputTokenDetails === "object"
      ? (record.inputTokenDetails as Record<string, unknown>)
      : {};
  const promptTokenDetails =
    record.prompt_tokens_details &&
    typeof record.prompt_tokens_details === "object"
      ? (record.prompt_tokens_details as Record<string, unknown>)
      : {};
  const cacheReadInputTokens = firstNumber(
    record.cacheReadInputTokens,
    record.cachedInputTokens,
    inputTokenDetails.cacheReadTokens,
    inputTokenDetails.cachedInputTokens,
    inputTokenDetails.cachedTokens,
    promptTokenDetails.cached_tokens,
  );
  const cacheCreationInputTokens = firstNumber(
    record.cacheCreationInputTokens,
    record.cacheWriteInputTokens,
    inputTokenDetails.cacheCreationInputTokens,
    inputTokenDetails.cacheCreationTokens,
    inputTokenDetails.cacheWriteTokens,
  );
  const out: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  } = {
    prompt_tokens: billing.inputTokens,
    completion_tokens: billing.outputTokens,
    total_tokens: billing.totalTokens,
  };
  if (
    cacheReadInputTokens !== undefined ||
    cacheCreationInputTokens !== undefined
  ) {
    out.prompt_tokens_details = {
      ...(cacheReadInputTokens !== undefined
        ? {
            cached_tokens: cacheReadInputTokens,
            cache_read_input_tokens: cacheReadInputTokens,
          }
        : {}),
      ...(cacheCreationInputTokens !== undefined
        ? { cache_creation_input_tokens: cacheCreationInputTokens }
        : {}),
    };
    if (cacheReadInputTokens !== undefined) {
      out.cache_read_input_tokens = cacheReadInputTokens;
    }
    if (cacheCreationInputTokens !== undefined) {
      out.cache_creation_input_tokens = cacheCreationInputTokens;
    }
  }
  return out;
}

/**
 * Normalize an SDK usage record into the token triple the OpenAI response
 * shape requires — identical to what billUsage normalizes (inputTokens ??
 * promptTokens, etc.), so client-visible usage always matches billed usage.
 */
function normalizeUsageTokens(usage: unknown): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  const record = (usage ?? {}) as {
    inputTokens?: number;
    promptTokens?: number;
    outputTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  const inputTokens = firstNumber(record.inputTokens, record.promptTokens) ?? 0;
  const outputTokens =
    firstNumber(record.outputTokens, record.completionTokens) ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: firstNumber(record.totalTokens) ?? inputTokens + outputTokens,
  };
}

function isEmptyButBilled(
  visibleText: string,
  hasToolCalls: boolean,
  usage: unknown,
  providerFinishReason?: string,
): boolean {
  return (
    !visibleText &&
    !hasToolCalls &&
    providerFinishReason !== "content-filter" &&
    providerFinishReason !== "content_filter" &&
    normalizeUsageTokens(usage).outputTokens > 0
  );
}

function hasReportedUsageTokens(usage: unknown): boolean {
  const record = (usage ?? {}) as {
    inputTokens?: number;
    promptTokens?: number;
    outputTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  return (
    firstNumber(
      record.inputTokens,
      record.promptTokens,
      record.outputTokens,
      record.completionTokens,
      record.totalTokens,
    ) !== undefined
  );
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function getMessageContent(msg: ChatMessage): string {
  if (msg.content == null) return "";
  if (typeof msg.content === "string") return msg.content;
  return msg.content.map((p) => p.text || "").join("");
}

function getObjectValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function parseJsonObject(value: string | undefined): unknown {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function getProviderErrorCode(value: unknown): string | null {
  const errorValue = getObjectValue(value, "error");
  const source =
    errorValue && typeof errorValue === "object" ? errorValue : value;
  const code = getObjectValue(source, "code");
  const type = getObjectValue(source, "type");

  if (typeof code === "string" && code.trim()) {
    return code;
  }
  if (typeof type === "string" && type.trim()) {
    return type;
  }
  return null;
}

function unwrapProviderError(error: unknown): unknown {
  if (RetryError.isInstance(error)) {
    return error.lastError;
  }
  return error;
}

function getProviderCallerFaultStatus(error: unknown): number | null {
  if (!(error instanceof Error)) {
    return null;
  }
  const statusCode = getObjectValue(error, "statusCode");
  const status = getObjectValue(error, "status");
  const candidate =
    typeof statusCode === "number"
      ? statusCode
      : typeof status === "number"
        ? status
        : null;
  if (candidate === 400 || candidate === 404 || candidate === 429) {
    return candidate;
  }
  return null;
}

function getRecoverableProviderErrorStatus(error: unknown): number | null {
  const providerError = unwrapProviderError(error);
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  const providerCallerFaultStatus = getProviderCallerFaultStatus(providerError);
  if (providerCallerFaultStatus !== null) {
    return providerCallerFaultStatus;
  }

  if (APICallError.isInstance(providerError)) {
    const providerCode =
      getProviderErrorCode(providerError.data) ??
      getProviderErrorCode(parseJsonObject(providerError.responseBody));
    const providerMessage = providerError.message.toLowerCase();

    if (
      providerError.statusCode === 429 ||
      providerCode === "insufficient_quota" ||
      providerCode === "rate_limit_exceeded" ||
      providerMessage.includes("insufficient_quota") ||
      (providerMessage.includes("quota") &&
        providerMessage.includes("exceeded")) ||
      message.includes("insufficient_quota")
    ) {
      return 429;
    }

    if (providerError.statusCode === 402) {
      return 402;
    }

    // A provider 400 is the CALLER's fault (invalid parameters / a response
    // schema the provider's strict validator rejects) — pass it through so
    // the client sees 400 invalid_request_error instead of the generic 500
    // fallback, which both mislabels the failure and (in the streaming error
    // chunk) invites pointless retries of a request that can never succeed.
    if (providerError.statusCode === 400) {
      return 400;
    }

    if (providerError.statusCode && providerError.statusCode >= 500) {
      return 503;
    }

    // Upstream auth/forbidden failures (e.g. invalid provider API key) are not
    // the caller's fault — surface as service unavailable so we don't leak
    // upstream auth state to authenticated callers.
    if (providerError.statusCode === 401 || providerError.statusCode === 403) {
      return 503;
    }
  }

  if (
    message.includes("insufficient_quota") ||
    message.includes("quota exceeded") ||
    (message.includes("quota") && message.includes("exceeded"))
  ) {
    return 429;
  }

  return null;
}

function toPooledInferenceCredential(
  organizationId: string,
  selected: SelectedPooledCredential,
): PooledInferenceCredential {
  return {
    organizationId,
    credentialId: selected.credentialId,
    providerId: selected.providerId,
    apiKey: selected.apiKey,
    label: selected.label,
  };
}

async function selectPooledInferenceCredential(params: {
  model: string;
  organizationId: string;
  sessionKey: string;
  requirePooledCredential: boolean;
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
}): Promise<PooledInferenceCredentialResolution> {
  const providerId = resolvePooledDirectProviderForModel(params.model);
  if (!providerId) return { kind: "ready", credential: null };
  const selectionParams = {
    organizationId: params.organizationId,
    providerId,
    sessionKey: params.sessionKey,
    ...(params.executionCtx
      ? {
          defer: (task: Promise<void>) => params.executionCtx?.waitUntil(task),
        }
      : {}),
  };
  if (params.executionCtx) {
    const resolution = await getTeamPoolRegistry().selectCredentialCacheOnly(
      selectionParams,
      { executionCtx: params.executionCtx },
    );
    if (resolution.kind !== "ready") {
      // Pooled credentials are additive. A cold optional pool hydrates under
      // waitUntil while this request uses the configured platform credential;
      // only deployments with no platform fallback must wait for the pool.
      return params.requirePooledCredential
        ? resolution
        : { kind: "ready", credential: null };
    }
    return {
      kind: "ready",
      credential: resolution.credential
        ? toPooledInferenceCredential(
            params.organizationId,
            resolution.credential,
          )
        : null,
    };
  }
  const selected =
    await getTeamPoolRegistry().selectCredential(selectionParams);
  return {
    kind: "ready",
    credential: selected
      ? toPooledInferenceCredential(params.organizationId, selected)
      : null,
  };
}

async function recordPooledInferenceSuccess(
  pooledCredential: PooledInferenceCredential | null,
  userId: string,
  executionCtx?: { waitUntil(promise: Promise<unknown>): void },
): Promise<void> {
  if (!pooledCredential) return;
  const write = getTeamPoolRegistry().recordUse({
    organizationId: pooledCredential.organizationId,
    credentialId: pooledCredential.credentialId,
    userId,
  });
  if (executionCtx) {
    executionCtx.waitUntil(write);
    return;
  }
  await write;
}

async function recordPooledInferenceFailure(
  pooledCredential: PooledInferenceCredential | null,
  error: unknown,
  promptCacheKey?: string,
  executionCtx?: { waitUntil(promise: Promise<unknown>): void },
): Promise<void> {
  if (!pooledCredential) return;
  const status =
    getRecoverableProviderErrorStatus(error) ?? getErrorStatusCode(error);
  if (![401, 403, 429].includes(status)) return;
  const write = getTeamPoolRegistry().recordProviderFailure({
    organizationId: pooledCredential.organizationId,
    credentialId: pooledCredential.credentialId,
    providerId: pooledCredential.providerId,
    status,
    detail: redactPromptCacheKey(
      error instanceof Error ? error.message : String(error),
      promptCacheKey,
    ),
  });
  if (executionCtx) {
    executionCtx.waitUntil(write);
    return;
  }
  await write;
}

function shouldUsePooledNoopReservation(params: {
  pooledCredential: PooledInferenceCredential | null;
  useMonetizedAppBilling: boolean;
}): boolean {
  return Boolean(params.pooledCredential && !params.useMonetizedAppBilling);
}

// ============================================================================
// Main Handler
// ============================================================================

interface ChatCompletionsHandlerOptions {
  skipOrgRateLimit?: boolean;
  /** Require this app scope and bill through its app accounting policy. */
  requiredAppId?: string;
  /** Stable application trace id supplied by the outer Worker middleware. */
  traceId?: string;
  /**
   * Cloudflare ExecutionContext. When present, positive inference-auth cache
   * population and the post-response billing/settlement chain are registered
   * with `waitUntil`; neither optimization write blocks the model response.
   * The writes still begin immediately and their promises remain observable to
   * the Worker runtime. Callers without an execution context preserve inline
   * awaiting, which keeps non-Worker and test behavior deterministic.
   */
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
}

export async function handleChatCompletionsPOST(
  req: Request,
  options: ChatCompletionsHandlerOptions = {},
) {
  const startTime = Date.now();
  const telemetryStartedAt = performance.now();
  const traceId = options.traceId ?? resolveElizaTraceId(req.headers);
  let preforwardTiming: GatewayPreforwardTiming | undefined;
  let authTelemetry: InferenceAuthTelemetry | undefined;
  const attachPreforwardTelemetry = (response: Response): Response => {
    const withAuth = authTelemetry
      ? withInferenceAuthTelemetry(response, traceId, authTelemetry)
      : response;
    return preforwardTiming
      ? withGatewayPreforwardTelemetry(withAuth, traceId, preforwardTiming)
      : withAuth;
  };
  // #11588: the billing requestId feeds the affiliate-earnings dedupe sourceId
  // (getAffiliateEarningsSourceId → `ai_billing:<op>:<requestId>`, deduped on
  // addEarnings) while the org charge is unconditional. It MUST NOT be
  // client-controllable, or a caller pinning `x-request-id` across two billed
  // requests could suppress the second affiliate credit while still being
  // charged the markup. Server-generate it (stable for this request, so the
  // #11460/#11472 abort-vs-finish single-flight dedupe is preserved). The
  // client's retry-idempotency mechanism stays the explicit `idempotency-key`
  // header.
  const requestId = crypto.randomUUID();
  const idempotencyKey = req.headers.get("idempotency-key") || requestId;
  const routeTimeoutMs = getRouteTimeoutMs(ROUTE_MAX_DURATION);
  let settleReservation:
    | ((actualCost: number) => Promise<CreditReconciliationResult | null>)
    | null = null;
  let settleUnknown: (() => Promise<CreditReconciliationResult | null>) | null =
    null;
  let markProviderDispatched: (() => Promise<void>) | undefined;
  let billingReservation: CreditReservation | undefined;
  let providerDispatched = false;
  // Hoisted so the catch below can echo the requested model in the sanitized
  // provider-configuration error; set right after the body parses.
  let model = "";
  let promptCacheKeyForRedaction: string | undefined;

  try {
    // 1. Authenticate (+ moderation). API-key and Steward-session requests
    // resolve auth + org + moderation from a combined cache decision. On one
    // true cold miss, Workers may consume the retained authoritative decision
    // under a bounded deadline; its cache projection remains off-path.
    let user: { id: string; organization_id: string };
    let apiKey: { id: string } | null;
    let moderationAlreadyChecked = false;
    let admissionSnapshot: InferenceAdmissionSnapshot | undefined;
    let admissionCredential: InferenceCredentialCheck | undefined;
    let appScopeId: string | null = null;

    const deferStrongCredentialCheck =
      Boolean(options.executionCtx) && isInferenceStrongRevocationEnabled();
    const resolution = await resolveInferenceAuthContext(req, {
      traceId,
      executionCtx: options.executionCtx,
      cacheOnly: Boolean(options.executionCtx),
      deferStrongCredentialCheck,
      onTelemetry: (telemetry) => {
        authTelemetry = telemetry;
      },
    });
    if (resolution.kind === "warming") {
      return attachPreforwardTelemetry(
        addCorsHeaders(
          Response.json(
            {
              error: {
                message: "Authorization cache is warming. Retry shortly.",
                type: "service_unavailable",
                code: "auth_cache_warming",
              },
            },
            { status: 503 },
          ),
        ),
      );
    }
    if (resolution.kind === "suspended") {
      const denial = resolveInferenceAuthStandingDenial(resolution, {
        route: "chat_completions",
        traceId,
      });
      return attachPreforwardTelemetry(
        addCorsHeaders(
          Response.json(
            {
              error: {
                message: denial.message,
                type: denial.type,
                code: denial.code,
                details: { reason: denial.reason },
              },
            },
            { status: denial.status },
          ),
        ),
      );
    }
    if (resolution.kind === "rejected") {
      const denial = resolveInferenceAuthStandingDenial(resolution, {
        route: "chat_completions",
        traceId,
      });
      return attachPreforwardTelemetry(
        addCorsHeaders(
          Response.json(
            {
              error: {
                message: denial.message,
                type: denial.type,
                code: denial.code,
                details: { reason: denial.reason },
              },
            },
            {
              status: denial.status,
              headers: denial.retryAfterSeconds
                ? { "Retry-After": String(denial.retryAfterSeconds) }
                : undefined,
            },
          ),
        ),
      );
    }
    if (resolution.kind === "authorized") {
      user = {
        id: resolution.ctx.userId,
        organization_id: resolution.ctx.orgId,
      };
      apiKey = resolution.ctx.apiKeyId ? { id: resolution.ctx.apiKeyId } : null;
      admissionSnapshot = resolution.ctx.admission;
      admissionCredential = resolution.credential;
      appScopeId =
        "appScopeId" in resolution.ctx ? resolution.ctx.appScopeId : null;
      // The resolver already verified not-suspended (cache hit = at populate;
      // origin miss = just now), so the synchronous moderation read is skipped.
      moderationAlreadyChecked = true;
    } else {
      if (options.executionCtx) {
        return attachPreforwardTelemetry(
          addCorsHeaders(
            Response.json(
              {
                error: {
                  message: "Authentication required.",
                  type: "authentication_error",
                  code: "authentication_required",
                },
              },
              { status: 401 },
            ),
          ),
        );
      }
      const authed = await requireAuthOrApiKeyWithOrg(req);
      user = authed.user;
      apiKey = authed.apiKey ? { id: authed.apiKey.id } : null;
    }
    // Pre-forward latency instrumentation (#9899): measured TTFT through this
    // route is ~6.5s while cerebras-direct is ~0.24s — 100% of the overhead is
    // pre-forward work, not the model. These marks split it (auth vs the
    // cache-only dependency decisions vs admission) so production telemetry
    // catches any regression before a provider invocation.
    const tAuth = performance.now();

    // 1b. Per-org tier rate limit. Start it beside body parsing: rate-limit
    // still wins over malformed bodies, matching the pre-existing gate order.
    const orgRateLimitPromise =
      user.organization_id && !options.skipOrgRateLimit
        ? enforceOrgRateLimit(user.organization_id, "completions", {
            cacheOnly: Boolean(options.executionCtx),
            executionCtx: options.executionCtx,
            config: inferenceRateLimitConfig(admissionSnapshot, "completions"),
          })
        : Promise.resolve(null);
    const requestPromise = req
      .json()
      // error-policy:J3 malformed JSON becomes the same typed invalid request path as a missing body.
      .catch(() => null) as Promise<ChatRequest | null>;

    let orgRateLimited: Response | null;
    try {
      orgRateLimited = await orgRateLimitPromise;
    } catch (error) {
      if (error instanceof OrgRateLimitCacheNotReadyError) {
        return attachPreforwardTelemetry(
          addCorsHeaders(
            Response.json(
              {
                error: {
                  message:
                    "Rate-limit authorization cache is warming. Retry shortly.",
                  type: "service_unavailable",
                  code: "rate_limit_cache_warming",
                },
              },
              { status: 503, headers: { "Retry-After": "1" } },
            ),
          ),
        );
      }
      throw error;
    }
    if (orgRateLimited) return orgRateLimited;

    // 2. Prepare app monetization lookup
    const requestedAppId = options.requiredAppId ?? req.headers.get("X-App-Id");
    if (requestedAppId && appScopeId && appScopeId !== requestedAppId) {
      return addCorsHeaders(
        Response.json(
          {
            error: {
              message: "Access denied to this app",
              type: "invalid_request_error",
              code: "access_denied",
            },
          },
          { status: 403 },
        ),
      );
    }
    let appId: string | null = null;
    let useAppCredits = false;
    let monetizedApp: Awaited<ReturnType<typeof appsService.getById>> | null =
      null;

    // 3. Parse request — guard a malformed/empty body to a 400 instead of a 500.
    // An unguarded parse throws a SyntaxError that the outer catch maps to 500
    // (and echoes the raw parse text); the sibling agents routes already guard
    // this. Also require `messages` to be an ARRAY so a non-array value can't
    // slip past the length check and TypeError later in `messages.filter(...)`.
    const request = await requestPromise;

    // 4. Validate
    if (
      !request?.model ||
      !Array.isArray(request.messages) ||
      !request.messages.length
    ) {
      return attachPreforwardTelemetry(
        addCorsHeaders(
          Response.json(
            {
              error: {
                message: "Missing required fields: model and messages",
                type: "invalid_request_error",
                code: "missing_required_parameter",
              },
            },
            { status: 400 },
          ),
        ),
      );
    }

    // Collapse decorated Cerebras ids (e.g. "openai/gpt-oss-120b:nitro" emitted
    // by dedicated agents) to the bare Cerebras id so pricing, routing, and
    // billing all agree and route to cerebras-direct instead of OpenRouter.
    model = canonicalizeCerebrasModelId(request.model);
    const reasoningEffortValidation = validateCerebrasReasoningEffort(
      model,
      request.reasoning_effort,
    );
    if (!reasoningEffortValidation.ok) {
      return addCorsHeaders(
        Response.json(
          {
            error: {
              message: reasoningEffortValidation.message,
              type: "invalid_request_error",
              code: "invalid_reasoning_effort",
            },
          },
          { status: 400 },
        ),
      );
    }
    const reasoningEffort = reasoningEffortValidation.value;
    // Normalize nullable omission once so every downstream path (passthrough,
    // SDK streaming, and SDK generation) observes the same validated value.
    request.reasoning_effort = reasoningEffort;
    const provider = getProviderFromModel(model);
    const promptCacheKeyResult = resolvePromptCacheKey(request);
    if ("error" in promptCacheKeyResult) {
      return addCorsHeaders(
        Response.json(
          {
            error: {
              message: promptCacheKeyResult.error,
              type: "invalid_request_error",
              code: "invalid_prompt_cache_key",
            },
          },
          { status: 400 },
        ),
      );
    }
    promptCacheKeyForRedaction = promptCacheKeyResult.key;
    const normalizedModel = normalizeModelName(model);
    const cotBudget = resolveAnthropicThinkingBudgetTokens(model, process.env);
    const cotOptions =
      cotBudget != null
        ? mergeAnthropicCotProviderOptions(model, process.env, cotBudget)
        : {};
    // Authoritative reasoning detection: many reasoning models (kimi-k2.6,
    // glm-5.1, deepseek-v4-pro, ...) do not carry a "think"/"reasoning" id but
    // do advertise a reasoning parameter in the catalog. Workers consume fresh
    // or stale cached metadata and hydrate misses off-path; a cold optional
    // catalog uses the same name-pattern fallback as non-Worker tools.
    // #9899: skip the reasoning-detection catalog read when id name-pattern
    // detection ALREADY classifies this as a reasoning model. The catalog can
    // only ADD reasoning, never remove it (modelUsesReasoningTokens ORs the two
    // signals), so for a name-pattern match the catalog cannot change
    // computeEffectiveMaxTokens — the read is pure latency. Default now (the
    // hot-path cache is no longer flag-gated); pinned to the name-pattern set.
    const skipCatalogLookup = modelUsesReasoningTokens(model);
    const monetizedAppPromise = requestedAppId
      ? options.executionCtx
        ? options.requiredAppId
          ? appsService.getByIdCacheOnly(requestedAppId, {
              executionCtx: options.executionCtx,
            })
          : appsService.getAuthorizedMonetizedAppForUserCacheOnly(
              requestedAppId,
              user,
              { executionCtx: options.executionCtx },
            )
        : options.requiredAppId
          ? appsService
              .getById(requestedAppId)
              .then((app) => ({ kind: "ready" as const, app: app ?? null }))
          : appsService
              .getAuthorizedMonetizedAppForUser(requestedAppId, user)
              .then((app) => ({ kind: "ready" as const, app: app ?? null }))
      : Promise.resolve({ kind: "ready" as const, app: null });
    const platformCredentialConfigured =
      hasLanguageModelProviderConfigured(model);
    const pooledCredentialPromise = selectPooledInferenceCredential({
      model,
      organizationId: user.organization_id,
      sessionKey: apiKey?.id ?? user.id,
      requirePooledCredential: !platformCredentialConfigured,
      executionCtx: options.executionCtx,
    });
    const modelCatalogPromise = skipCatalogLookup
      ? Promise.resolve({ kind: "ready" as const, model: null })
      : options.executionCtx
        ? getGatewayModelByIdCacheOnly(model, {
            executionCtx: options.executionCtx,
          })
        : getCachedGatewayModelById(model)
            .then((catalogModel) => ({
              kind: "ready" as const,
              model: catalogModel,
            }))
            // error-policy:J4 non-Worker tools retain the explicit
            // name-pattern fallback when optional catalog metadata fails.
            .catch((error) => {
              logger.warn(
                "[Chat Completions] reasoning-detection catalog lookup failed; using name patterns",
                {
                  model,
                  error: error instanceof Error ? error.message : String(error),
                },
              );
              return { kind: "ready" as const, model: null };
            });
    const shouldBlockUserPromise = moderationAlreadyChecked
      ? Promise.resolve({ kind: "ready" as const, blocked: false })
      : options.executionCtx
        ? contentModerationService.shouldBlockUserCacheOnly(user.id, {
            executionCtx: options.executionCtx,
          })
        : contentModerationService
            .shouldBlockUser(user.id)
            .then((blocked) => ({ kind: "ready" as const, blocked }));

    const [
      appResolution,
      pooledCredentialResolution,
      modelCatalogResolution,
      moderationResolution,
    ] = await Promise.all([
      monetizedAppPromise,
      pooledCredentialPromise,
      modelCatalogPromise,
      shouldBlockUserPromise,
    ]);
    if (
      appResolution.kind !== "ready" ||
      pooledCredentialResolution.kind !== "ready" ||
      moderationResolution.kind !== "ready"
    ) {
      return attachPreforwardTelemetry(
        addCorsHeaders(
          Response.json(
            {
              error: {
                message:
                  "Inference dependency cache is warming. Retry shortly.",
                type: "service_unavailable",
                code: "inference_dependency_cache_warming",
              },
            },
            { status: 503, headers: { "Retry-After": "1" } },
          ),
        ),
      );
    }
    monetizedApp = appResolution.app;
    if (
      options.requiredAppId &&
      (!monetizedApp ||
        (!monetizedApp.monetization_enabled &&
          monetizedApp.organization_id !== user.organization_id))
    ) {
      return addCorsHeaders(
        Response.json(
          {
            error: {
              message: monetizedApp
                ? "Access denied to this app"
                : "App not found",
              type: "invalid_request_error",
              code: monetizedApp ? "access_denied" : "app_not_found",
            },
          },
          { status: monetizedApp ? 403 : 404 },
        ),
      );
    }
    appId = monetizedApp?.id ?? null;
    useAppCredits = Boolean(monetizedApp);
    const pooledCredential = pooledCredentialResolution.credential;
    const modelSupportedParameters =
      modelCatalogResolution.kind === "ready"
        ? modelCatalogResolution.model?.supported_parameters
        : undefined;
    const shouldBlockUser = moderationResolution.blocked;

    if (!pooledCredential && !platformCredentialConfigured) {
      return addCorsHeaders(
        Response.json(
          {
            error: {
              message: getAiProviderConfigurationError(),
              type: "service_unavailable",
              code: "ai_not_configured",
            },
          },
          { status: 503 },
        ),
      );
    }

    const billingSource = pooledCredential
      ? "gateway"
      : (resolveAiProviderSource(model) ?? "gateway");
    const effectiveMaxTokens = computeEffectiveMaxTokens(
      request.max_tokens,
      cotBudget,
      model,
      modelSupportedParameters,
      reasoningEffort,
    );
    const webSearchEnabled = request.webSearchEnabled === true;
    const webSearchActive = isAnthropicWebSearchEnabled(
      provider,
      model,
      webSearchEnabled,
    );
    const webSearchOptions = buildProviderNativeWebSearchTools({
      provider,
      model,
      enabled: webSearchEnabled,
      maxUses: request.webSearchMaxUses,
    });

    // 5. Check content moderation. Skipped when the hot-path resolver already
    // verified the suspension status in this request (#9899) — never skipped on
    // the slow path.
    if (shouldBlockUser) {
      return addCorsHeaders(
        Response.json(
          {
            error: {
              message:
                "Your account has been suspended due to policy violations.",
              type: "account_suspended",
              code: "moderation_violation",
            },
          },
          { status: 403 },
        ),
      );
    }

    // Start async moderation in background. ALWAYS runs (it is off the hot path)
    // so new violations are still detected; on a violation we invalidate this
    // user's inference auth-context so the cached fast path can't keep serving a
    // user who just crossed the suspension threshold (#9899).
    const lastUserMessage = request.messages
      .filter((m) => m.role === "user")
      .pop();
    if (lastUserMessage) {
      const content = getMessageContent(lastUserMessage);
      if (content) {
        const moderationTask = contentModerationService.moderateInBackground(
          content,
          user.id,
          undefined,
          (result) => {
            logger.warn(
              "[Chat Completions] Async moderation detected violation",
              {
                userId: user.id,
                categories: result.flaggedCategories,
              },
            );
          },
        );
        options.executionCtx?.waitUntil(moderationTask);
      }
    }

    // 6. Estimate tokens and reserve credits
    const estimatedInputTokens =
      estimateInputTokens(
        request.messages.map((m) => ({ content: getMessageContent(m) })),
      ) + (webSearchActive ? ANTHROPIC_WEB_SEARCH_INPUT_TOKEN_BUFFER : 0);
    const estimatedOutputTokens =
      effectiveMaxTokens ?? request.max_tokens ?? 500;
    const affiliateCode = req.headers.get("X-Affiliate-Code");

    const tBeforeReserve = performance.now();
    const useMonetizedAppBilling = Boolean(
      useAppCredits && appId && monetizedApp,
    );
    try {
      if (
        shouldUsePooledNoopReservation({
          pooledCredential,
          useMonetizedAppBilling,
        })
      ) {
        if (admissionCredential) {
          await assertInferenceCredentialActive(
            user.organization_id,
            admissionCredential,
          );
        }
        settleReservation = async () => null;
        settleUnknown = async () => null;
      } else if (useAppCredits && appId && monetizedApp) {
        if (admissionCredential) {
          await assertInferenceCredentialActive(
            user.organization_id,
            admissionCredential,
          );
        }
        assertInferenceAppAffiliateSupported(appId, affiliateCode);
        const { totalCost } = await calculateCost(
          normalizedModel,
          provider,
          estimatedInputTokens,
          estimatedOutputTokens,
          billingSource,
          options.executionCtx
            ? { cacheOnly: true, executionCtx: options.executionCtx }
            : undefined,
        );
        const metadata = {
          model,
          provider,
          billingSource,
          requestId,
          route: "chat_completions",
          streaming: request.stream === true,
          estimatedInputTokens,
          estimatedOutputTokens,
        };
        if (options.executionCtx) {
          const admission = await admitAppInferenceCacheOnly({
            appId,
            app: monetizedApp,
            userId: user.id,
            organizationId: user.organization_id,
            estimatedBaseCostUsd: totalCost,
            description: `Chat completion: ${model}`,
            idempotencyKey,
            metadata,
            requestId,
            model,
            provider,
            billingSource,
            affiliateCode,
            executionCtx: options.executionCtx,
            admissionSnapshot,
          });
          settleReservation = admission.settle;
          settleUnknown = admission.settleUnknown;
          markProviderDispatched = admission.markProviderDispatched;
        } else {
          const reservation = await appCreditsService.reserveInferenceCredits({
            appId,
            userId: user.id,
            estimatedBaseCost: totalCost,
            description: `Chat completion: ${model}`,
            idempotencyKey,
            metadata,
            app: monetizedApp,
          });
          settleReservation = createCreditReservationSettler(reservation);
          settleUnknown = () =>
            settleReservation?.(totalCost) ?? Promise.resolve(null);
        }
      } else {
        const admission = await admitOrganizationInference({
          context: {
            organizationId: user.organization_id,
            userId: user.id,
            apiKeyId: apiKey?.id ?? null,
            model,
            provider,
            billingSource,
            affiliateCode,
            requestId,
          },
          estimatedInputTokens,
          estimatedOutputTokens,
          apiKeyId: apiKey?.id ?? null,
          affiliateCode,
          executionCtx: options.executionCtx,
          admissionSnapshot,
          credential: admissionCredential,
        });
        settleReservation = admission.settle;
        settleUnknown = admission.settleUnknown;
        markProviderDispatched = admission.markProviderDispatched;
        billingReservation = admission.reservation;
      }
    } catch (error) {
      if (error instanceof InferenceCredentialRevokedError) {
        const reason = inferenceCredentialRevocationReason(error.reason);
        const denial = resolveInferenceAuthStandingDenial(
          reason === "moderation_blocked" ||
            reason === "organization_inactive" ||
            reason === "account_inactive" ||
            reason === "membership_missing"
            ? { kind: "suspended", reason }
            : { kind: "rejected", status: 401, reason },
          { route: "chat_completions", traceId },
        );
        return attachPreforwardTelemetry(
          addCorsHeaders(
            Response.json(
              {
                error: {
                  message: denial.message,
                  type: denial.type,
                  code: denial.code,
                  details: { reason: denial.reason },
                },
              },
              { status: denial.status },
            ),
          ),
        );
      }
      if (error instanceof InferenceAppAffiliateUnsupportedError) {
        return addCorsHeaders(
          Response.json(
            {
              error: {
                message:
                  "App monetization and affiliate attribution cannot be combined.",
                type: "invalid_request_error",
                code: "unsupported_billing_combination",
              },
            },
            { status: 400 },
          ),
        );
      }
      if (error instanceof InsufficientCreditsError) {
        const creditKind = useMonetizedAppBilling ? "cloud credits" : "credits";
        return addCorsHeaders(
          Response.json(
            {
              error: {
                message: `Insufficient ${creditKind}. Required: $${error.required.toFixed(4)}`,
                type: "insufficient_quota",
                code: "insufficient_credits",
              },
            },
            { status: 402 },
          ),
        );
      }
      if (
        error instanceof InferenceBalanceCacheWarmingError ||
        error instanceof AiPricingCacheWarmingError ||
        error instanceof AiPricingCacheUnavailableError
      ) {
        return addCorsHeaders(
          Response.json(
            {
              error: {
                message: "Billing authorization is warming. Retry shortly.",
                type: "service_unavailable",
                code: "billing_cache_warming",
              },
            },
            { status: 503 },
          ),
        );
      }
      throw error;
    }
    if (!settleReservation || !settleUnknown) {
      throw new Error(
        "[Chat Completions] inference admission did not return complete settlement controls",
      );
    }
    const tAfterReserve = performance.now();

    // 7. Convert messages for AI SDK
    const systemMessage = request.messages.find((m) => m.role === "system");
    const systemPrompt = systemMessage
      ? getMessageContent(systemMessage)
      : undefined;
    const nonSystemMessages = request.messages.filter(
      (m) => m.role !== "system",
    );
    const modelMessages = convertToModelMessagesFromOpenAI(nonSystemMessages);

    logger.info("[Chat Completions] Request", {
      traceId,
      model,
      messageCount: request.messages.length,
      streaming: request.stream,
      estimatedInputTokens,
      webSearchEnabled: webSearchActive,
    });

    // The boundary is the direct upstream fetch or outer AI SDK invocation.
    // SDK-internal prompt conversion and model dispatch happen afterward and
    // are intentionally outside this gateway-preforward measurement.
    let gatewayHandoffAt: number | undefined;
    const gatewayHandoffTelemetry: GatewayHandoffTelemetry = {
      capture: () => {
        providerDispatched = true;
        gatewayHandoffAt ??= performance.now();
      },
      emit: () => {
        if (gatewayHandoffAt === undefined || preforwardTiming) return;
        preforwardTiming = snapshotGatewayPreforwardTiming({
          authMs: tAuth - telemetryStartedAt,
          middleMs: tBeforeReserve - tAuth,
          reserveMs: tAfterReserve - tBeforeReserve,
          setupMs: gatewayHandoffAt - tAfterReserve,
          totalMs: gatewayHandoffAt - telemetryStartedAt,
        });
        logger.info("[Chat Completions][preforward]", {
          traceId,
          model,
          authMs: preforwardTiming.authMs,
          midReadsMs: preforwardTiming.middleMs,
          reserveMs: preforwardTiming.reserveMs,
          setupMs: preforwardTiming.setupMs,
          totalMs: preforwardTiming.totalMs,
          stream: request.stream === true,
        });
      },
    };

    // 8. Handle streaming vs non-streaming
    const preforwardResponse = request.stream
      ? await handleStreamingRequest(
          model,
          systemPrompt,
          modelMessages,
          request,
          user,
          apiKey ? { id: apiKey.id } : null,
          affiliateCode,
          idempotencyKey,
          requestId,
          appId,
          startTime,
          req.signal,
          routeTimeoutMs,
          estimatedInputTokens,
          settleReservation,
          settleUnknown,
          billingReservation,
          cotOptions,
          effectiveMaxTokens,
          webSearchOptions,
          billingSource,
          pooledCredential,
          useMonetizedAppBilling,
          options.executionCtx,
          gatewayHandoffTelemetry,
          markProviderDispatched,
          traceId,
        )
      : await handleNonStreamingRequest(
          model,
          systemPrompt,
          modelMessages,
          request,
          user,
          apiKey ? { id: apiKey.id } : null,
          affiliateCode,
          idempotencyKey,
          requestId,
          appId,
          startTime,
          req.signal,
          routeTimeoutMs,
          settleReservation,
          settleUnknown,
          billingReservation,
          cotOptions,
          effectiveMaxTokens,
          webSearchOptions,
          billingSource,
          pooledCredential,
          useMonetizedAppBilling,
          options.executionCtx,
          gatewayHandoffTelemetry,
          markProviderDispatched,
        );
    if (!preforwardTiming) {
      throw new Error(
        "[Chat Completions] gateway handoff timing was not captured",
      );
    }
    // Re-wrap instead of mutating a fetch Response, whose headers can be
    // immutable. The body passes through unchanged, so streaming stays
    // zero-buffered.
    return attachPreforwardTelemetry(preforwardResponse);
  } catch (error) {
    await settleOffResponsePath(options.executionCtx, async () => {
      if (
        providerDispatched &&
        !isKnownUnacceptedProviderError(error) &&
        !isProviderConfigurationError(error)
      ) {
        await settleUnknown?.();
      } else {
        await settleReservation?.(0);
      }
    });
    const rawMessage = redactPromptCacheKey(
      error instanceof Error ? error.message : String(error),
      promptCacheKeyForRedaction,
    );
    logger.error("[Chat Completions] Error", {
      traceId,
      error: rawMessage,
      cause:
        error instanceof Error && error.cause
          ? redactPromptCacheKey(
              String((error.cause as Error).message ?? error.cause),
              promptCacheKeyForRedaction,
            )
          : undefined,
    });
    // Provider-configuration failures carry internal setup guidance that must
    // never reach a direct API caller; the raw detail is already in the log above.
    // To the caller the deterministic truth is that this deployment cannot
    // serve the requested model.
    if (isProviderConfigurationError(error)) {
      return attachPreforwardTelemetry(
        addCorsHeaders(
          Response.json(
            {
              error: {
                message: modelNotAvailableMessage(model),
                type: "invalid_request_error",
                code: "model_not_available",
              },
            },
            { status: 400 },
          ),
        ),
      );
    }
    const isDbError =
      rawMessage.startsWith("Failed query:") ||
      rawMessage.includes("insert into") ||
      rawMessage.includes("select from");
    const errorMessage = isDbError ? "Internal server error" : rawMessage;

    const isInsufficientCredits =
      error instanceof InsufficientCreditsError ||
      errorMessage.includes("Insufficient") ||
      errorMessage.includes("credits");
    const status = isInsufficientCredits
      ? 402
      : (getRecoverableProviderErrorStatus(error) ?? getErrorStatusCode(error));
    const errorType = openAiErrorTypeForStatus(status);

    return attachPreforwardTelemetry(
      addCorsHeaders(
        Response.json(
          {
            error: {
              message: errorMessage,
              type: errorType,
            },
          },
          { status },
        ),
      ),
    );
  }
}

/**
 * Client-facing message for a provider-configuration failure. The requested
 * model id is the only detail safe to echo back — the underlying errors name
 * internal env vars and setup steps, which stay in server logs only.
 */
function modelNotAvailableMessage(model: string): string {
  return `model '${model}' is not available on this deployment`;
}

/**
 * OpenAI-compatible `error.type` for an HTTP status. Single mapping shared by
 * the non-streaming error response and the terminal streaming error chunk so
 * the two paths can never disagree about what a status means.
 */
function openAiErrorTypeForStatus(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 402) return "insufficient_quota";
  if (status === 429) return "rate_limit_error";
  if (status === 503) return "service_unavailable";
  if (status === 400 || status === 404) return "invalid_request_error";
  return "api_error";
}

function summarizeFinishedStepUsage(
  steps: readonly StepResult<ToolSet>[],
): AIUsage | null {
  let sawUsage = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheWriteInputTokens = 0;

  for (const step of steps) {
    const usage = step.usage;
    const stepInputTokens = firstNumber(usage.inputTokens) ?? 0;
    const stepOutputTokens = firstNumber(usage.outputTokens) ?? 0;
    const stepTotalTokens =
      firstNumber(usage.totalTokens) ?? stepInputTokens + stepOutputTokens;
    const stepCacheReadTokens =
      firstNumber(
        usage.inputTokenDetails?.cacheReadTokens,
        usage.cachedInputTokens,
      ) ?? 0;
    const stepCacheWriteTokens =
      firstNumber(usage.inputTokenDetails?.cacheWriteTokens) ?? 0;

    if (
      stepInputTokens > 0 ||
      stepOutputTokens > 0 ||
      stepTotalTokens > 0 ||
      stepCacheReadTokens > 0 ||
      stepCacheWriteTokens > 0
    ) {
      sawUsage = true;
    }

    inputTokens += stepInputTokens;
    outputTokens += stepOutputTokens;
    totalTokens += stepTotalTokens;
    cacheReadInputTokens += stepCacheReadTokens;
    cacheWriteInputTokens += stepCacheWriteTokens;
  }

  if (!sawUsage) return null;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens,
  };
}

async function settleStreamingAbortReservation(params: {
  model: string;
  provider: string;
  user: { id: string; organization_id: string };
  apiKey: { id: string } | null;
  affiliateCode: string | null;
  appId: string | null;
  requestId: string;
  idempotencyKey: string;
  systemPrompt: string | undefined;
  prompt: string;
  startTime: number;
  billingSource: PricingBillingSource;
  estimatedInputTokens: number;
  deliveredText: string;
  steps: readonly StepResult<ToolSet>[];
  settleReservation: (
    actualCost: number,
  ) => Promise<CreditReconciliationResult | null>;
  settleUnknown: () => Promise<CreditReconciliationResult | null>;
  billingReservation?: CreditReservation;
}): Promise<CreditReconciliationResult | null> {
  const finishedStepUsage = summarizeFinishedStepUsage(params.steps);
  const deliveredOutputTokens = estimateTokens(params.deliveredText);
  const inputTokens = Math.max(
    params.estimatedInputTokens,
    finishedStepUsage?.inputTokens ?? 0,
  );
  const outputTokens = Math.max(
    deliveredOutputTokens,
    finishedStepUsage?.outputTokens ?? 0,
  );
  const totalTokens = Math.max(
    inputTokens + outputTokens,
    finishedStepUsage?.totalTokens ?? 0,
  );

  try {
    const billingContext = buildChatBillingContext({
      user: params.user,
      apiKey: params.apiKey,
      model: params.model,
      provider: params.provider,
      billingSource: params.billingSource,
      requestId: params.requestId,
      appId: params.appId,
      affiliateCode: params.affiliateCode,
      streaming: true,
    });
    const billing = await billUsage(
      billingContext,
      {
        inputTokens,
        outputTokens,
        totalTokens,
        cacheReadInputTokens: finishedStepUsage?.cacheReadInputTokens,
        cacheWriteInputTokens: finishedStepUsage?.cacheWriteInputTokens,
      },
      params.billingReservation,
    );
    const reconciliation = await params.settleReservation(billing.totalCost);
    const usageRecord = await recordUsageAnalytics(billingContext, billing, {
      type: "chat",
      isSuccessful: false,
      errorMessage: "client_aborted_stream",
      content: params.deliveredText,
      systemPrompt: params.systemPrompt,
      prompt: params.prompt,
      latencyMs: Date.now() - params.startTime,
    });
    if (usageRecord) {
      try {
        await aiBillingRecordsService.record({
          context: billingContext,
          billing,
          usageRecord,
          idempotencyKey: params.idempotencyKey,
          reconciliation,
        });
      } catch (auditError) {
        logger.error("[Chat Completions] audit record failed (non-fatal)", {
          error:
            auditError instanceof Error
              ? auditError.message
              : String(auditError),
          cause:
            auditError instanceof Error && auditError.cause
              ? String((auditError.cause as Error).message ?? auditError.cause)
              : undefined,
        });
      }
    }

    logger.info(
      "[Chat Completions] Stream aborted; reservation partially settled",
      {
        model: params.model,
        inputTokens: billing.inputTokens,
        outputTokens: billing.outputTokens,
        totalCost: billing.totalCost,
        deliveredChars: params.deliveredText.length,
        finishedSteps: params.steps.length,
      },
    );

    return reconciliation;
  } catch (error) {
    logger.error(
      "[Chat Completions] Stream abort partial settlement failed; retaining the conservative estimate",
      {
        model: params.model,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return await params.settleUnknown();
  }
}

// ============================================================================
// Pass-through Streaming Fast Path (#15428)
// ============================================================================

/**
 * True when a streamed request needs NO gateway-side transformation, so the
 * upstream's SSE bytes can be piped to the client verbatim. Deliberately
 * conservative: anything the pipe cannot represent byte-for-byte (tool
 * calling, response_format, provider-native web search, multimodal message
 * parts) falls through to the streamText path unchanged.
 *
 * `stream_options.include_usage` must ALREADY be the client's contract: the
 * billing meter needs the terminal usage frame, and a pipe cannot inject the
 * frame upstream without the client also receiving it. plugin-elizacloud
 * requests it on every streamed call, so the measured hot path qualifies; a
 * client that did not opt in falls through rather than receiving frames it
 * never asked for.
 */
function qualifiesForPassthroughStreaming(request: ChatRequest): boolean {
  if (request.stream !== true) return false;
  if (request.stream_options?.include_usage !== true) return false;
  if (request.tools?.length) return false;
  if (request.tool_choice !== undefined) return false;
  if (request.response_format && request.response_format.type !== "text") {
    return false;
  }
  if (request.webSearchEnabled === true) return false;
  for (const message of request.messages) {
    if (message.role === "tool") return false;
    if (message.tool_calls?.length) return false;
    if (message.tool_call_id !== undefined) return false;
    if (message.content !== null && typeof message.content !== "string") {
      return false;
    }
  }
  return true;
}

/**
 * Client-facing status for a pass-through upstream error response — the same
 * classification getRecoverableProviderErrorStatus applies to AI-SDK errors:
 * caller-fault statuses pass through; 401/403 are OUR provider-key state
 * (never the caller's fault) and everything else means the upstream is
 * unavailable, both surfaced as 503.
 */
function mapPassthroughUpstreamStatus(status: number): number {
  if (status === 400 || status === 402 || status === 404 || status === 429) {
    return status;
  }
  return 503;
}

function passthroughErrorResponse(status: number, message: string): Response {
  return addCorsHeaders(
    Response.json(
      {
        error: {
          message,
          type: openAiErrorTypeForStatus(status),
          code: status,
        },
      },
      { status },
    ),
  );
}

/** Round to 2dp once so log/header/ring-buffer values agree (#16079). */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Bounded, sanitized echo of the provider's own request id (#16079). The value
 * is provider-chosen (not fully trusted): keep only the same safe token
 * characters Server-Timing descriptions allow and cap the length, so a
 * hostile upstream header cannot smuggle content into logs or client-visible
 * headers.
 */
function sanitizeProviderRequestId(value: string | null): string | undefined {
  const sanitized = value?.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
  return sanitized ? sanitized : undefined;
}

/**
 * The pass-through streaming fast path (#15428): fetch the provider's
 * chat/completions directly with `stream: true` and return the response body
 * piped to the client byte-for-byte — no AI-SDK decode, no per-part
 * processing, no SSE re-encode (the measured ~1.5s TTFB / ~5s total gateway
 * overhead vs ~0.17s / ~0.6s direct). Billing parity comes from a push-based
 * meter that observes every chunk as it is forwarded from the single upstream
 * reader (no `tee()` — its slow-branch queue is unbounded, #20032); the
 * stream's terminal event feeds the tail (via the same settleOffResponsePath
 * seam as the SDK path) to extract the terminal usage frame + delivered text
 * for the EXISTING settle chain (billUsage → settleReservation → analytics →
 * audit).
 *
 * Returns null when the fast path does not apply (flag off, non-qualifying
 * request, no direct upstream) — callers fall through to streamText. Runs
 * strictly AFTER auth + billing admission; it replaces only the provider
 * forward + re-encode stage.
 *
 * Error semantics mirror the SDK path where the timing allows and are strictly
 * fail-closed otherwise:
 *   - upstream non-2xx / network failure BEFORE any bytes: full refund and an
 *     OpenAI-shaped error response with the same status classification the SDK
 *     path's terminal error chunk carries (surfaced pre-stream because the
 *     pipe has not committed a 200 yet);
 *   - in-stream upstream error frame without usage: full refund (onError
 *     parity);
 *   - client abort / upstream drop / timeout (no usage frame): estimate-based
 *     partial settle of the delivered text (onAbort parity). Client disconnect
 *     cancels the upstream fetch via AbortSignal pass-through.
 */
async function tryPassthroughStreamingRequest(params: {
  model: string;
  systemPrompt: string | undefined;
  request: ChatRequest;
  user: { id: string; organization_id: string };
  apiKey: { id: string } | null;
  affiliateCode: string | null;
  idempotencyKey: string;
  requestId: string;
  appId: string | null;
  startTime: number;
  abortSignal: AbortSignal | undefined;
  timeoutMs: number;
  estimatedInputTokens: number;
  settleReservation: (
    actualCost: number,
  ) => Promise<CreditReconciliationResult | null>;
  settleUnknown: () => Promise<CreditReconciliationResult | null>;
  markProviderDispatched?: () => Promise<void>;
  billingReservation?: CreditReservation;
  effectiveMaxTokens: number | undefined;
  billingSource: PricingBillingSource;
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
  gatewayHandoffTelemetry?: GatewayHandoffTelemetry;
  /** Shared correlation id (#16079): keys the milestone event to the trace. */
  traceId: string;
}): Promise<Response | null> {
  const { model, request, settleReservation } = params;
  if (!isPassthroughStreamingEnabled()) return null;
  if (!qualifiesForPassthroughStreaming(request)) return null;
  const upstream = resolvePassthroughUpstreamForModel(model);
  if (!upstream) return null;

  const provider = getProviderFromModel(model);
  // Same param clamping as the SDK path, mapped back to the OpenAI wire names
  // the upstream's chat/completions accepts.
  const safeParams = getSafeModelParams(model, {
    temperature: request.temperature,
    topP: request.top_p,
    frequencyPenalty: request.frequency_penalty,
    presencePenalty: request.presence_penalty,
    stopSequences: request.stop
      ? Array.isArray(request.stop)
        ? request.stop
        : [request.stop]
      : undefined,
  });
  const upstreamBody: Record<string, unknown> = {
    model: upstream.modelId,
    messages: request.messages,
    stream: true,
    // Qualification guarantees this is already the client's contract; stated
    // explicitly so the billing meter's usage frame never depends on upstream
    // defaults.
    stream_options: { include_usage: true },
  };
  if (safeParams.temperature !== undefined) {
    upstreamBody.temperature = safeParams.temperature;
  }
  if (safeParams.topP !== undefined) upstreamBody.top_p = safeParams.topP;
  if (safeParams.frequencyPenalty !== undefined) {
    upstreamBody.frequency_penalty = safeParams.frequencyPenalty;
  }
  if (safeParams.presencePenalty !== undefined) {
    upstreamBody.presence_penalty = safeParams.presencePenalty;
  }
  if (safeParams.stopSequences?.length) {
    upstreamBody.stop = safeParams.stopSequences;
  }
  if (request.reasoning_effort !== undefined) {
    upstreamBody.reasoning_effort = request.reasoning_effort;
  }
  if (params.effectiveMaxTokens != null) {
    upstreamBody.max_tokens = params.effectiveMaxTokens;
  }
  const promptCacheKey = resolvePromptCacheKey(request);
  if (!("error" in promptCacheKey) && promptCacheKey.key) {
    upstreamBody.prompt_cache_key = promptCacheKey.key;
  }

  // Client disconnect must cancel the upstream fetch (the meter then settles
  // the delivered portion via its readError path); the route timeout keeps
  // parity with the SDK path's streamText({ timeout }).
  const signals: AbortSignal[] = [];
  if (params.abortSignal) signals.push(params.abortSignal);
  if (Number.isFinite(params.timeoutMs) && params.timeoutMs > 0) {
    signals.push(AbortSignal.timeout(params.timeoutMs));
  }

  let upstreamResponse: Response;
  // #16079: the milestone origin is the provider fetch dispatch itself —
  // assigned AFTER the dispatch-marker await (which can carry Durable Object
  // acknowledgement latency) and immediately before fetch(), so every
  // milestone below is attributable to the provider leg, not gateway
  // preforward work (which the preforward snapshot already covers).
  let upstreamFetchStartedAt = 0;
  const upstreamInit: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${upstream.apiKey}`,
    },
    body: JSON.stringify(upstreamBody),
    ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
  };
  try {
    await params.markProviderDispatched?.();
    upstreamFetchStartedAt = performance.now();
    upstreamResponse = await invokeAtGatewayHandoff(
      params.gatewayHandoffTelemetry,
      () => fetch(upstream.url, upstreamInit),
    );
  } catch (error) {
    // A failed dispatch marker proves this Worker never called the provider,
    // even when the Durable Object committed but every acknowledgement was
    // lost. Once fetch starts, transport failure remains ambiguous.
    await settleOffResponsePath(params.executionCtx, async () => {
      if (isInferenceAdmissionDispatchMarkError(error)) {
        await params.settleReservation(0);
      } else {
        await params.settleUnknown();
      }
    });
    logger.error("[Chat Completions] Passthrough upstream fetch failed", {
      model,
      provider: upstream.providerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return passthroughErrorResponse(503, "upstream provider request failed");
  }

  if (!upstreamResponse.ok) {
    await settleOffResponsePath(params.executionCtx, async () => {
      if (isKnownUnacceptedProviderStatus(upstreamResponse.status)) {
        await settleReservation(0);
      } else {
        await params.settleUnknown();
      }
    });
    const status = mapPassthroughUpstreamStatus(upstreamResponse.status);
    // Caller-fault statuses echo the upstream's own error message (the same
    // truth the SDK path surfaces via APICallError.message); everything else
    // gets the generic form so upstream auth/infra detail never leaks to the
    // caller (#13406 discipline).
    let message = "upstream provider error";
    if (status !== 503) {
      const bodyText = await upstreamResponse.text().catch(() => "");
      const upstreamMessage = getObjectValue(
        getObjectValue(parseJsonObject(bodyText), "error"),
        "message",
      );
      message = redactPromptCacheKey(
        typeof upstreamMessage === "string" && upstreamMessage.trim()
          ? upstreamMessage
          : `upstream provider returned ${upstreamResponse.status}`,
        "error" in promptCacheKey ? undefined : promptCacheKey.key,
      );
    } else {
      // error-policy:J6 best-effort teardown — release the upstream connection;
      // the (auth/infra) body is intentionally unused.
      await upstreamResponse.body?.cancel().catch(() => undefined);
    }
    logger.error("[Chat Completions] Passthrough upstream error status", {
      model,
      provider: upstream.providerId,
      upstreamStatus: upstreamResponse.status,
      mappedStatus: status,
    });
    return passthroughErrorResponse(status, message);
  }
  if (!upstreamResponse.body) {
    await settleOffResponsePath(params.executionCtx, async () => {
      await params.settleUnknown();
    });
    logger.error(
      "[Chat Completions] Passthrough upstream returned an accepted response without a stream body",
      { model, provider: upstream.providerId },
    );
    return passthroughErrorResponse(
      503,
      "upstream provider response was incomplete",
    );
  }
  // #16079: freeze the provider-leg boundaries known before the pipe commits.
  // The provider's own request id is echoed bounded-and-sanitized so the
  // correlated trace can be joined to provider-side logs without leaking
  // arbitrary upstream header content (same character policy as Server-Timing
  // descriptions).
  const upstreamHeadersMs = round2(performance.now() - upstreamFetchStartedAt);
  const providerRequestId = sanitizeProviderRequestId(
    upstreamResponse.headers.get("x-request-id"),
  );
  // Single-reader fan-out (#20032 defect 4): the client stream is the ONLY
  // consumer of the upstream body, and the meter observes each chunk
  // synchronously as it is forwarded. Upstream pulling is therefore bounded
  // by the client's own backpressure — a slow or stalled client stalls the
  // upstream instead of accumulating an unbounded tee queue in Worker memory.
  const upstreamReader = upstreamResponse.body.getReader();
  const meter = createPassthroughStreamMeter({
    // #16079: milestones measured from the provider fetch dispatch.
    startedAt: upstreamFetchStartedAt,
  });
  const billingPrompt = buildChatPromptForBilling(request);
  // Settlement is triggered by the stream's terminal event (EOF, read error,
  // or client cancel) — first terminal wins; the meter's own terminal guard
  // makes the tail snapshot stable across a cancel racing an EOF.
  let settlementStarted = false;
  const settleFromTail = async (tail: PassthroughStreamTail) => {
    if (settlementStarted) return;
    settlementStarted = true;
    // Always-on correlated milestone record (#16079): the ring buffer is read
    // back via the admin cloud-observability endpoint, so unlike logger.info
    // it survives without VERBOSE_LOGGING. Bounded fields only.
    recordCloudStreamMilestones({
      traceId: params.traceId,
      requestId: params.requestId,
      path: "passthrough",
      model,
      ...(providerRequestId ? { providerRequestId } : {}),
      upstreamHeadersMs,
      firstEventMs: tail.milestones.firstEventMs,
      firstReasoningMs: tail.milestones.firstReasoningMs,
      firstContentMs: tail.milestones.firstContentMs,
      completionMs: tail.milestones.completionMs,
      // An in-stream SSE error frame is an upstream-reported failure, and a
      // stream that ended without [DONE] is truncated: both are recorded as
      // not-completed rather than a healthy run (#16079, #20032).
      aborted: tail.readError !== null || tail.sawErrorFrame || !tail.sawDone,
      createdAt: new Date().toISOString(),
    });
    if (tail.usage) {
      // Success settle — the same chain, amounts, and record shapes as the SDK
      // path's onFinish, fed by the provider-reported usage frame.
      try {
        const billingContext = buildChatBillingContext({
          user: params.user,
          apiKey: params.apiKey,
          model,
          provider,
          billingSource: params.billingSource,
          requestId: params.requestId,
          appId: params.appId,
          affiliateCode: params.affiliateCode,
          streaming: true,
        });
        const billing = await billUsage(
          billingContext,
          tail.usage,
          params.billingReservation,
        );
        const reconciliation = await settleReservation(billing.totalCost);
        const usageRecord = await recordUsageAnalytics(
          billingContext,
          billing,
          {
            type: "chat",
            content: tail.deliveredText,
            systemPrompt: params.systemPrompt,
            prompt: billingPrompt,
            latencyMs: Date.now() - params.startTime,
          },
        );
        if (usageRecord) {
          try {
            await aiBillingRecordsService.record({
              context: billingContext,
              billing,
              usageRecord,
              idempotencyKey: params.idempotencyKey,
              reconciliation,
            });
          } catch (auditError) {
            logger.error("[Chat Completions] audit record failed (non-fatal)", {
              error:
                auditError instanceof Error
                  ? auditError.message
                  : String(auditError),
            });
          }
        }
        logger.info("[Chat Completions] Passthrough streaming complete", {
          model,
          durationMs: Date.now() - params.startTime,
          inputTokens: billing.inputTokens,
          outputTokens: billing.outputTokens,
          totalCost: billing.totalCost,
        });
      } catch (error) {
        // The provider reported usage, so a local billing failure cannot be
        // treated as proof of zero cost. The conservative terminal preserves
        // the admitted estimate and is first-call-wins with a partial success.
        await params.settleUnknown();
        logger.error("[Chat Completions] Passthrough settle error", {
          model,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (tail.sawErrorFrame && tail.readError === null) {
      // An HTTP-accepted stream can consume provider work before its terminal
      // error frame, even when no usage frame arrives. Absence of metering is
      // not evidence of zero cost, so retain the admitted estimate.
      await params.settleUnknown();
      logger.error(
        "[Chat Completions] Passthrough upstream in-stream error — conservative estimate retained",
        { model },
      );
      return;
    }

    // No usage frame (client abort / upstream drop / timeout — or, degenerate,
    // a normally-terminated stream whose provider omitted the frame): the
    // estimate-based partial settle, identical to the SDK path's onAbort.
    await settleStreamingAbortReservation({
      model,
      provider,
      user: params.user,
      apiKey: params.apiKey,
      affiliateCode: params.affiliateCode,
      appId: params.appId,
      requestId: params.requestId,
      idempotencyKey: params.idempotencyKey,
      systemPrompt: params.systemPrompt,
      prompt: billingPrompt,
      startTime: params.startTime,
      billingSource: params.billingSource,
      estimatedInputTokens: params.estimatedInputTokens,
      deliveredText: tail.deliveredText,
      steps: [],
      settleReservation,
      settleUnknown: params.settleUnknown,
      billingReservation: params.billingReservation,
    });
    logger.info(
      "[Chat Completions] Passthrough stream ended without usage frame; settled from estimates",
      { model, readAborted: tail.readError !== null, sawDone: tail.sawDone },
    );
  };

  // The settle chain runs OFF the response path when a Workers executionCtx
  // exists (the same seam the SDK path defers through) and inline at the
  // terminal event otherwise — for a non-Worker caller the final read (or the
  // cancel acknowledgement) resolves only after settlement completes, so
  // draining the response is a deterministic settlement barrier in tests.
  const cancelAwareClientBranch = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let read: Awaited<ReturnType<typeof upstreamReader.read>>;
      try {
        read = await upstreamReader.read();
      } catch (error) {
        await settleOffResponsePath(params.executionCtx, () =>
          settleFromTail(meter.fail(error)),
        );
        // error-policy:J1 translate upstream read failure to the client stream.
        controller.error(error);
        return;
      }
      if (read.done) {
        await settleOffResponsePath(params.executionCtx, () =>
          settleFromTail(meter.finish()),
        );
        controller.close();
        return;
      }
      meter.observe(read.value);
      controller.enqueue(read.value);
    },
    async cancel(reason) {
      // The single upstream reader keeps the provider connection alive only
      // while the client reads. On disconnect, stop the upstream and settle
      // the observed partial output inside Cloudflare's waitUntil window.
      const tail = meter.fail(
        reason ??
          new DOMException(
            "The client stopped reading the stream",
            "AbortError",
          ),
      );
      // Register/run settlement before teardown: an upstream implementation
      // may never resolve cancel(), but billing must still enter waitUntil (or
      // start inline for non-Worker callers) as soon as the client disconnects.
      const settlement = settleOffResponsePath(params.executionCtx, () =>
        settleFromTail(tail),
      );
      // error-policy:J6 best-effort teardown — the upstream connection may
      // already be errored/closed; settlement proceeds from the observed tail.
      await Promise.all([
        upstreamReader.cancel(reason).catch(() => undefined),
        settlement,
      ]);
    },
  });

  return addCorsHeaders(
    new Response(cancelAwareClientBranch, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        // Observability marker: distinguishes the piped path in logs/latency
        // probes without touching the SSE payload bytes.
        "X-Eliza-Inference-Path": "passthrough",
        // #16079: the provider leg's known boundaries travel on the response
        // so browser/correlated callers can join them to the trace id. Mid-
        // stream milestones cannot (headers are frozen once the 200 commits
        // and the body must stay byte-identical) — those live in the
        // always-on ring-buffer event keyed by the same trace id.
        "Server-Timing": `upstream_headers;dur=${upstreamHeadersMs}`,
        ...(providerRequestId
          ? { "X-Eliza-Provider-Request-Id": providerRequestId }
          : {}),
      },
    }),
  );
}

// ============================================================================
// Streaming Handler
// ============================================================================

async function handleStreamingRequest(
  model: string,
  systemPrompt: string | undefined,
  messages: ModelMessage[],
  request: ChatRequest,
  user: { id: string; organization_id: string },
  apiKey: { id: string } | null,
  affiliateCode: string | null,
  idempotencyKey: string,
  requestId: string,
  appId: string | null,
  startTime: number,
  abortSignal: AbortSignal | undefined,
  timeoutMs: number,
  estimatedInputTokens: number,
  settleReservation: (
    actualCost: number,
  ) => Promise<CreditReconciliationResult | null>,
  settleUnknown: () => Promise<CreditReconciliationResult | null>,
  billingReservation: CreditReservation | undefined,
  cotOptions: ReturnType<typeof mergeAnthropicCotProviderOptions>,
  effectiveMaxTokens: number | undefined,
  webSearchOptions: ReturnType<typeof buildProviderNativeWebSearchTools>,
  billingSource: PricingBillingSource,
  pooledCredential: PooledInferenceCredential | null,
  useMonetizedAppBilling: boolean,
  executionCtx?: { waitUntil(promise: Promise<unknown>): void },
  gatewayHandoffTelemetry?: GatewayHandoffTelemetry,
  markProviderDispatched?: () => Promise<void>,
  /** Shared trace id (#16079) correlating the milestone event with the caller. */
  traceId?: string,
) {
  // #15428 pass-through fast path: qualifying plain streamed chat against a
  // direct OpenAI-compatible upstream pipes the provider bytes straight
  // through (zero decode/re-encode) and meters a teed branch into the same
  // billing chain. Anything the pipe cannot represent — pooled BYO keys,
  // Anthropic CoT provider options, provider-native web search, tools,
  // response_format, multimodal content — takes the streamText path below,
  // which is byte-identical to today (and the only path when the flag is off).
  if (
    pooledCredential === null &&
    Object.keys(cotOptions).length === 0 &&
    Object.keys(webSearchOptions).length === 0
  ) {
    const passthroughResponse = await tryPassthroughStreamingRequest({
      model,
      systemPrompt,
      request,
      user,
      apiKey,
      affiliateCode,
      idempotencyKey,
      requestId,
      appId,
      startTime,
      abortSignal,
      timeoutMs,
      estimatedInputTokens,
      settleReservation,
      settleUnknown,
      markProviderDispatched,
      billingReservation,
      effectiveMaxTokens,
      billingSource,
      executionCtx,
      gatewayHandoffTelemetry,
      traceId: traceId ?? requestId,
    });
    if (passthroughResponse) return passthroughResponse;
  }

  const promptCacheKeyResult = resolvePromptCacheKey(request);
  const promptCacheKey =
    "error" in promptCacheKeyResult ? undefined : promptCacheKeyResult.key;
  const modelProviderOptions = mergePromptCacheProviderOptions(
    cotOptions,
    getProviderFromModel(model).startsWith("cerebras") &&
      !("error" in promptCacheKeyResult)
      ? promptCacheKey
      : undefined,
  );
  const provider = getProviderFromModel(model);
  const tools = convertTools(request.tools);
  const toolChoice = mapToolChoice(request.tool_choice);
  const experimentalOutput = mapResponseFormat(request.response_format);
  const billingPrompt = buildChatPromptForBilling(request);
  const billingAffiliateCode =
    pooledCredential && !useMonetizedAppBilling ? null : affiliateCode;
  let deliveredText = "";
  let deliveredProviderOutput = false;
  let streamingSettlementPromise: Promise<CreditReconciliationResult | null> | null =
    null;

  // First-call-wins EVEN on throw (#11512): the settlement promise is cached
  // unconditionally, so a rejected settlement can never be re-run by a later
  // callback (onAbort/onError racing a thrown onFinish). Resetting on throw
  // let a second call re-invoke reconcile after its org refund had already
  // committed — a second full refund, i.e. minted cashable credit. Subsequent
  // callers observe the same resolution or the same rejection.
  const settleStreamingOnce = (
    factory: () => Promise<CreditReconciliationResult | null>,
  ): Promise<CreditReconciliationResult | null> => {
    if (!streamingSettlementPromise) {
      streamingSettlementPromise = factory();
    }
    return streamingSettlementPromise;
  };

  const settleStreamingProviderFailureOnce = (error: unknown) =>
    settleStreamingOnce(async () =>
      deliveredProviderOutput || !isKnownUnacceptedProviderError(error)
        ? await settleUnknown()
        : await settleReservation(0),
    );

  const settleStreamingAbortOnce = (steps: readonly StepResult<ToolSet>[]) =>
    settleStreamingOnce(
      async () =>
        await settleStreamingAbortReservation({
          model,
          provider,
          user,
          apiKey,
          affiliateCode: billingAffiliateCode,
          appId,
          requestId,
          idempotencyKey,
          systemPrompt,
          prompt: billingPrompt,
          startTime,
          billingSource,
          estimatedInputTokens,
          deliveredText,
          steps,
          settleReservation,
          settleUnknown,
          billingReservation,
        }),
    );

  const safeParams = getSafeModelParams(model, {
    temperature: request.temperature,
    topP: request.top_p,
    frequencyPenalty: request.frequency_penalty,
    presencePenalty: request.presence_penalty,
    stopSequences: request.stop
      ? Array.isArray(request.stop)
        ? request.stop
        : [request.stop]
      : undefined,
  });
  const reasoningProviderOptions = buildReasoningEffortProviderOptions(
    request.reasoning_effort ?? undefined,
  );

  const languageModel = getLanguageModel(model, pooledCredential ?? undefined);
  const invokeStreamText = bindGatewayHandoffTelemetry(
    gatewayHandoffTelemetry,
    (options: Parameters<typeof streamText>[0]) => streamText(options),
  );
  await markProviderDispatched?.();
  const result = invokeStreamText({
    model: languageModel,
    system: systemPrompt,
    messages,
    ...webSearchOptions,
    abortSignal,
    timeout: timeoutMs,
    ...safeParams,
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    ...(experimentalOutput ? { output: experimentalOutput } : {}),
    ...(effectiveMaxTokens != null && { maxOutputTokens: effectiveMaxTokens }),
    ...combineProviderOptions(modelProviderOptions, reasoningProviderOptions),
    // Parity with the non-streaming path (#8759): the settlement chain below
    // (billUsage → settleReservation → analytics → audit) is 5+ serial DB
    // round-trips, and the AI SDK awaits onFinish before it ends fullStream —
    // so awaiting the chain inline held the final SSE frame + [DONE] hostage
    // for the full write latency (~8s measured in prod). Nothing the client
    // receives depends on these writes (`text`/`usage` come from the provider
    // result; the terminal usage frame is built from the stream's own finish
    // part), so defer them via waitUntil. settleStreamingOnce is still invoked
    // synchronously — the settlement promise is cached before onFinish
    // returns, so the idempotent first-call-wins guarantee against a racing
    // onAbort/onError is unchanged — and without an executionCtx (tests,
    // non-Worker callers) the chain is awaited inline exactly as before.
    onFinish: async ({ text, usage }) => {
      const settlement = settleStreamingOnce(async () => {
        // A finished stream whose provider reported NO usage cannot prove its
        // cost — billing the empty record would settle delivered output at $0,
        // reading "not reported" as "free". Retain the admitted estimate
        // instead (the same guard /v1/chat applies to a falsy onFinish usage).
        // An explicit all-zero usage report still bills normally below, and
        // provably-rejected work still reaches zero through onError/the stream
        // backstop, which win this first-call-wins settler.
        if (!hasReportedUsageTokens(usage)) {
          const reconciliation = await settleUnknown();
          await recordPooledInferenceSuccess(
            pooledCredential,
            user.id,
            executionCtx,
          );
          logger.error(
            "[Chat Completions] Stream finished without reported usage; settled admitted estimate",
            { model },
          );
          return reconciliation;
        }
        try {
          const billingContext = buildChatBillingContext({
            user,
            apiKey,
            model,
            provider,
            billingSource,
            requestId,
            appId,
            affiliateCode: billingAffiliateCode,
            streaming: true,
          });
          const billing = await billUsage(
            billingContext,
            usage,
            billingReservation,
          );
          const reconciliation = await settleReservation(billing.totalCost);
          await recordPooledInferenceSuccess(
            pooledCredential,
            user.id,
            executionCtx,
          );

          const usageRecord = await recordUsageAnalytics(
            billingContext,
            billing,
            {
              type: "chat",
              content: text,
              systemPrompt,
              prompt: billingPrompt,
              latencyMs: Date.now() - startTime,
            },
          );
          if (usageRecord) {
            try {
              await aiBillingRecordsService.record({
                context: billingContext,
                billing,
                usageRecord,
                idempotencyKey,
                reconciliation,
              });
            } catch (auditError) {
              logger.error(
                "[Chat Completions] audit record failed (non-fatal)",
                {
                  error:
                    auditError instanceof Error
                      ? auditError.message
                      : String(auditError),
                  cause:
                    auditError instanceof Error && auditError.cause
                      ? String(
                          (auditError.cause as Error).message ??
                            auditError.cause,
                        )
                      : undefined,
                },
              );
            }
          }

          logger.info("[Chat Completions] Streaming complete", {
            durationMs: Date.now() - startTime,
            inputTokens: billing.inputTokens,
            outputTokens: billing.outputTokens,
            totalCost: billing.totalCost,
          });

          return reconciliation;
        } catch (error) {
          const reconciliation = await settleUnknown();
          logger.error("[Chat Completions] onFinish error", {
            error: error instanceof Error ? error.message : String(error),
          });
          return reconciliation;
        }
      });
      await settleOffResponsePath(executionCtx, async () => {
        await settlement;
      });
    },
    onAbort: async ({
      steps,
    }: {
      readonly steps: readonly StepResult<ToolSet>[];
    }) => {
      const settlement = settleStreamingAbortOnce(steps);
      await settleOffResponsePath(executionCtx, async () => {
        await settlement;
      });
      logger.info("[Chat Completions] Stream aborted before completion", {
        model,
        estimatedInputTokens,
        deliveredOutputTokens: estimateTokens(deliveredText),
      });
    },
    // A provider error during streaming (e.g. the cerebras 429/5xx the
    // fail-fast path surfaces) fires onError — NOT onFinish or onAbort. Without
    // this, the upfront admission is never reconciled. A rejection before any
    // output releases the hold; an error after deliverable output retains the
    // admitted estimate because the provider cost is unknown. The settler is
    // first-call-wins, so later callbacks cannot supersede either decision.
    onError: async ({ error }: { error: unknown }) => {
      const settlement = settleStreamingProviderFailureOnce(error);
      await settleOffResponsePath(executionCtx, async () => {
        await settlement;
        await recordPooledInferenceFailure(
          pooledCredential,
          error,
          promptCacheKey,
          executionCtx,
        );
      });
      logger.error(
        "[Chat Completions] Stream provider error — admission settled",
        {
          model,
          conservative: deliveredProviderOutput,
          error: redactPromptCacheKey(
            error instanceof Error ? error.message : String(error),
            promptCacheKey,
          ),
        },
      );
    },
  } as Parameters<typeof streamText>[0]);

  // Convert to OpenAI-compatible SSE stream
  const encoder = new TextEncoder();

  // OpenAI stream_options.include_usage contract: every chunk carries
  // `usage: null` and one extra terminal chunk (empty `choices`) carries the
  // real usage, before `data: [DONE]`. Without honoring it, streamed calls
  // are unmeterable client-side — plugin-elizacloud requests this frame on
  // every streamed call and emits MODEL_USED metering only when it arrives.
  const includeUsage = request.stream_options?.include_usage === true;
  const usageFieldOnChunks = includeUsage ? { usage: null } : {};

  const openAIStream = new ReadableStream({
    async start(controller) {
      const responseId = `chatcmpl-${Date.now()}`;
      const toolCallIndexes = new Map<string, number>();
      // Argument chars already delivered per tool call id via
      // `tool-input-delta` fragments. OpenAI streaming clients concatenate
      // every `function.arguments` fragment for an index, so the consolidated
      // `tool-call` part must not re-emit arguments that were already
      // streamed — doing so produced doubled, unparseable argument JSON
      // downstream (hermes/openclaw agents hard-fail the tool call).
      const toolCallArgsDelivered = new Map<string, number>();
      let nextToolCallIndex = 0;
      let finishReason = "stop";
      let finishUsage: unknown;

      try {
        for await (const part of result.fullStream) {
          if (part.type === "text-delta") {
            deliveredProviderOutput ||= part.text.length > 0;
            const chunk = {
              id: responseId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              ...usageFieldOnChunks,
              choices: [
                {
                  index: 0,
                  delta: { content: part.text },
                  finish_reason: null,
                },
              ],
            };
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
            );
            deliveredText += part.text;
            continue;
          }

          if (part.type === "tool-input-start") {
            deliveredProviderOutput = true;
            const index = nextToolCallIndex++;
            toolCallIndexes.set(part.id, index);
            toolCallArgsDelivered.set(part.id, 0);
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: responseId,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model,
                  ...usageFieldOnChunks,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index,
                            id: part.id,
                            type: "function",
                            function: { name: part.toolName, arguments: "" },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                })}\n\n`,
              ),
            );
            continue;
          }

          if (part.type === "tool-input-delta") {
            deliveredProviderOutput ||= part.delta.length > 0;
            const index = toolCallIndexes.get(part.id) ?? 0;
            toolCallArgsDelivered.set(
              part.id,
              (toolCallArgsDelivered.get(part.id) ?? 0) + part.delta.length,
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: responseId,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model,
                  ...usageFieldOnChunks,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index,
                            function: { arguments: part.delta },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                })}\n\n`,
              ),
            );
            continue;
          }

          if (part.type === "tool-call") {
            deliveredProviderOutput = true;
            const index =
              toolCallIndexes.get(part.toolCallId) ?? nextToolCallIndex++;
            toolCallIndexes.set(part.toolCallId, index);
            // Arguments already went out incrementally for this id; the
            // consolidated part is only the SDK's summary event. Re-emitting
            // the full serialized input here would append a second copy of
            // the arguments on the client. Providers that never stream input
            // fragments (no start/delta for this id, or an empty delta
            // stream) still need the full emission below.
            if ((toolCallArgsDelivered.get(part.toolCallId) ?? 0) > 0) {
              finishReason = "tool_calls";
              continue;
            }
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: responseId,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model,
                  ...usageFieldOnChunks,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index,
                            id: part.toolCallId,
                            type: "function",
                            function: {
                              name: part.toolName,
                              arguments: toOpenAIArguments(part.input),
                            },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                })}\n\n`,
              ),
            );
            finishReason = "tool_calls";
            continue;
          }

          if (part.type === "finish") {
            finishReason =
              part.finishReason === "tool-calls"
                ? "tool_calls"
                : part.finishReason;
            finishUsage = part.totalUsage;
          }

          if (part.type === "error") {
            throw part.error;
          }
        }

        // A low explicit max_tokens can be consumed entirely by hidden
        // reasoning. Match the non-streaming contract: an empty-but-billed
        // completion is a length truncation, never a successful stop.
        if (
          isEmptyButBilled(
            deliveredText,
            nextToolCallIndex > 0,
            finishUsage,
            finishReason,
          )
        ) {
          finishReason = "length";
        }

        // Send final chunk with finish_reason
        const finalChunk = {
          id: responseId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          ...usageFieldOnChunks,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: toOpenAiFinishReason(finishReason),
            },
          ],
        };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`),
        );
        // Terminal usage-only chunk (empty choices) per stream_options
        // .include_usage. Only ever built from the SDK's reported usage — if
        // the finish part never arrived there is nothing honest to report, so
        // the frame is omitted rather than fabricated as zeros.
        if (includeUsage && hasReportedUsageTokens(finishUsage)) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [],
                usage: formatOpenAIUsage(
                  normalizeUsageTokens(finishUsage),
                  finishUsage,
                ),
              })}\n\n`,
            ),
          );
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        // Finding #11: a provider error mid-stream (e.g. the cerebras 429/5xx
        // surfaced as a `fullStream` error part) would otherwise leave the
        // already-sent 200 SSE body silently truncated — an OpenAI-compatible
        // client sees a cut stream that looks like a normal (empty) completion
        // and does not back off. Emit a terminal OpenAI-shaped error chunk +
        // [DONE] so the client can distinguish failure (and rate-limit-back-off)
        // from success. This catch can run even when the SDK never invokes (or
        // does not await) onError, so settle the admission here too. The
        // first-call-wins settler prevents this backstop from superseding the
        // callback's known-zero or conservative decision.
        const streamAborted = abortSignal?.aborted === true;
        const settlement = streamAborted
          ? settleStreamingAbortOnce([])
          : settleStreamingProviderFailureOnce(error);
        await settleOffResponsePath(executionCtx, async () => {
          await settlement;
          if (!streamAborted) {
            await recordPooledInferenceFailure(
              pooledCredential,
              error,
              promptCacheKey,
              executionCtx,
            );
          }
        });
        // Same sanitization as the non-streaming path: a provider-
        // configuration failure surfacing mid-stream (e.g. the gateway's
        // request-time auth error) names internal env vars — log it, send the
        // caller the clean model-not-available form. onError does not always
        // fire before this catch, so the log here is the guaranteed record.
        const isConfigError = isProviderConfigurationError(error);
        if (isConfigError) {
          logger.error(
            "[Chat Completions] Provider configuration error during stream",
            {
              model,
              error: redactPromptCacheKey(
                error instanceof Error ? error.message : String(error),
                promptCacheKey,
              ),
            },
          );
        }
        const status = isConfigError
          ? 400
          : (getRecoverableProviderErrorStatus(error) ??
            getErrorStatusCode(error));
        try {
          const errorChunk = {
            error: {
              message: isConfigError
                ? modelNotAvailableMessage(model)
                : redactPromptCacheKey(
                    error instanceof Error ? error.message : String(error),
                    promptCacheKey,
                  ),
              // Same status→type mapping as the non-streaming path — a
              // hardcoded "rate_limit_error" here mislabeled every mid-stream
              // provider failure (schema 400s, upstream 5xx) as rate limiting,
              // steering OpenAI-compatible clients into pointless back-off
              // retries.
              type: openAiErrorTypeForStatus(status),
              code: status,
            },
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (enqueueError) {
          // The stream was already torn down (client disconnected / controller
          // closed) — fall back to erroring it so the runtime cleans up.
          logger.error(
            "[Chat Completions] Failed to emit terminal stream error chunk",
            {
              error:
                enqueueError instanceof Error
                  ? enqueueError.message
                  : String(enqueueError),
            },
          );
          controller.error(error);
        }
      }
    },
  });

  return addCorsHeaders(
    new Response(openAIStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    }),
  );
}

// ============================================================================
// Non-Streaming Handler
// ============================================================================

async function handleNonStreamingRequest(
  model: string,
  systemPrompt: string | undefined,
  messages: ModelMessage[],
  request: ChatRequest,
  user: { id: string; organization_id: string },
  apiKey: { id: string } | null,
  affiliateCode: string | null,
  idempotencyKey: string,
  requestId: string,
  appId: string | null,
  startTime: number,
  abortSignal: AbortSignal | undefined,
  timeoutMs: number,
  settleReservation: (
    actualCost: number,
  ) => Promise<CreditReconciliationResult | null>,
  settleUnknown: () => Promise<CreditReconciliationResult | null>,
  billingReservation: CreditReservation | undefined,
  cotOptions: ReturnType<typeof mergeAnthropicCotProviderOptions>,
  effectiveMaxTokens: number | undefined,
  webSearchOptions: ReturnType<typeof buildProviderNativeWebSearchTools>,
  billingSource: PricingBillingSource,
  pooledCredential: PooledInferenceCredential | null,
  useMonetizedAppBilling: boolean,
  executionCtx: { waitUntil(promise: Promise<unknown>): void } | undefined,
  gatewayHandoffTelemetry?: GatewayHandoffTelemetry,
  markProviderDispatched?: () => Promise<void>,
) {
  const provider = getProviderFromModel(model);
  const tools = convertTools(request.tools);
  const toolChoice = mapToolChoice(request.tool_choice);
  const experimentalOutput = mapResponseFormat(request.response_format);
  const billingAffiliateCode =
    pooledCredential && !useMonetizedAppBilling ? null : affiliateCode;

  const promptCacheKeyResult = resolvePromptCacheKey(request);
  const promptCacheKey =
    "error" in promptCacheKeyResult ? undefined : promptCacheKeyResult.key;
  const modelProviderOptions = mergePromptCacheProviderOptions(
    cotOptions,
    provider.startsWith("cerebras") && !("error" in promptCacheKeyResult)
      ? promptCacheKey
      : undefined,
  );

  const safeParamsNonStream = getSafeModelParams(model, {
    temperature: request.temperature,
    topP: request.top_p,
    frequencyPenalty: request.frequency_penalty,
    presencePenalty: request.presence_penalty,
    stopSequences: request.stop
      ? Array.isArray(request.stop)
        ? request.stop
        : [request.stop]
      : undefined,
  });
  const reasoningProviderOptions = buildReasoningEffortProviderOptions(
    request.reasoning_effort ?? undefined,
  );

  let providerInvocationStarted = false;
  try {
    const languageModel = getLanguageModel(
      model,
      pooledCredential ?? undefined,
    );
    const invokeGenerateText = bindGatewayHandoffTelemetry(
      gatewayHandoffTelemetry,
      (options: Parameters<typeof generateText>[0]) => generateText(options),
    );
    await markProviderDispatched?.();
    providerInvocationStarted = true;
    const result = await invokeGenerateText({
      model: languageModel,
      system: systemPrompt,
      messages,
      ...webSearchOptions,
      abortSignal,
      timeout: timeoutMs,
      ...safeParamsNonStream,
      ...(tools ? { tools } : {}),
      ...(toolChoice ? { toolChoice } : {}),
      ...(experimentalOutput ? { output: experimentalOutput } : {}),
      ...(effectiveMaxTokens != null && {
        maxOutputTokens: effectiveMaxTokens,
      }),
      ...combineProviderOptions(modelProviderOptions, reasoningProviderOptions),
    } as Parameters<typeof generateText>[0]);
    // Token counts for the OpenAI-compat response come straight from the
    // model's reported usage, so the entire billing/settlement chain below can
    // run off the response path without changing the bytes the client receives.
    const responseTokens = normalizeUsageTokens(result.usage);
    const responseLatencyMs = Date.now() - startTime;

    // Bill using actual usage from SDK response. Deferred via waitUntil so the
    // ~0.7-1.1s of reconciliation/audit DB writes never block the response.
    // Same code, same amounts, same reservation — only the timing moves.
    const billingPrompt = buildChatPromptForBilling(request);
    await settleOffResponsePath(executionCtx, async () => {
      try {
        const billingContext = buildChatBillingContext({
          user,
          apiKey,
          model,
          provider,
          billingSource,
          requestId,
          appId,
          affiliateCode: billingAffiliateCode,
          streaming: false,
        });
        const billing = await billUsage(
          billingContext,
          result.usage,
          billingReservation,
        );
        const reconciliation = await settleReservation(billing.totalCost);
        await recordPooledInferenceSuccess(
          pooledCredential,
          user.id,
          executionCtx,
        );

        const usageRecord = await recordUsageAnalytics(
          billingContext,
          billing,
          {
            type: "chat",
            content: result.text,
            systemPrompt,
            prompt: billingPrompt,
            latencyMs: responseLatencyMs,
          },
        );
        if (usageRecord) {
          try {
            await aiBillingRecordsService.record({
              context: billingContext,
              billing,
              usageRecord,
              idempotencyKey,
              reconciliation,
            });
          } catch (auditError) {
            logger.error("[Chat Completions] audit record failed (non-fatal)", {
              error:
                auditError instanceof Error
                  ? auditError.message
                  : String(auditError),
              cause:
                auditError instanceof Error && auditError.cause
                  ? String(
                      (auditError.cause as Error).message ?? auditError.cause,
                    )
                  : undefined,
            });
          }
        }

        logger.info("[Chat Completions] Non-streaming complete", {
          durationMs: Date.now() - startTime,
          inputTokens: billing.inputTokens,
          outputTokens: billing.outputTokens,
          totalCost: billing.totalCost,
        });
      } catch (billingError) {
        // Provider output already exists. If pricing/accounting fails locally,
        // zero is not an honest cost; retain the admitted estimate.
        try {
          await settleUnknown();
        } catch (releaseError) {
          logger.error(
            "[Chat Completions] failed to release reservation after deferred billing failure",
            {
              requestId,
              organizationId: user.organization_id,
              error:
                releaseError instanceof Error
                  ? releaseError.message
                  : String(releaseError),
            },
          );
        }
        logger.error("[Chat Completions] deferred billing failed", {
          error:
            billingError instanceof Error
              ? billingError.message
              : String(billingError),
        });
      }
    });

    // Reasoning-model empty-output guard. A reasoning model can spend an
    // explicit caller budget on hidden chain-of-thought and return empty visible
    // text while still billing the consumed tokens. Surface it honestly: report
    // finish_reason "length" (so OpenAI-compatible clients retry with a higher
    // max_tokens) instead of a misleading "stop" with null content.
    const hasToolCalls = Boolean(result.toolCalls?.length);
    const visibleText = result.text || "";
    const emptyButBilled = isEmptyButBilled(
      visibleText,
      hasToolCalls,
      result.usage,
      result.finishReason,
    );
    const finishReason: "tool_calls" | "length" | "content_filter" | "stop" =
      hasToolCalls || result.finishReason === "tool-calls"
        ? "tool_calls"
        : result.finishReason === "length" || emptyButBilled
          ? "length"
          : result.finishReason === "content-filter"
            ? "content_filter"
            : "stop";
    if (emptyButBilled) {
      logger.warn("[Chat Completions] Empty completion despite billed tokens", {
        model,
        outputTokens: result.usage?.outputTokens,
        sdkFinishReason: result.finishReason,
        // Name-pattern only here (logging metadata); the budget decision upstream
        // uses the authoritative catalog supported_parameters signal.
        isReasoningModel: modelUsesReasoningTokens(model),
      });
    }

    // Return OpenAI-compatible response
    return addCorsHeaders(
      Response.json({
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: result.text || null,
              ...(hasToolCalls
                ? {
                    tool_calls: result.toolCalls.map((toolCall) => ({
                      id: toolCall.toolCallId,
                      type: "function",
                      function: {
                        name: toolCall.toolName,
                        arguments: toOpenAIArguments(toolCall.input),
                      },
                    })),
                  }
                : {}),
            },
            finish_reason: finishReason,
          },
        ],
        usage: formatOpenAIUsage(responseTokens, result.usage),
      }),
    );
  } catch (error) {
    await settleOffResponsePath(executionCtx, async () => {
      if (
        providerInvocationStarted &&
        !isKnownUnacceptedProviderError(error) &&
        !isProviderConfigurationError(error)
      ) {
        await settleUnknown();
      } else {
        await settleReservation(0);
      }
      await recordPooledInferenceFailure(
        pooledCredential,
        error,
        promptCacheKey,
        executionCtx,
      );
    });
    throw error;
  }
}

const honoRouter = new Hono<AppEnv>();
honoRouter.options("/", async (c) => {
  try {
    return await __next_OPTIONS(c.req.raw);
  } catch (error) {
    return failureResponse(c, error);
  }
});
honoRouter.post("/", async (c) => {
  try {
    return await handleChatCompletionsPOST(c.req.raw, {
      executionCtx: c.executionCtx,
      traceId: c.get("traceId"),
    });
  } catch (error) {
    // error-policy:J1 route boundary — every catch in v1/chat/* translates a thrown error into a structured HTTP failure via failureResponse (never a fabricated 200/empty completion). Credit reservations are released before rethrow on the streaming paths above.
    return failureResponse(c, error);
  }
});
export default honoRouter;

/**
 * Test-only exports. Not part of the public route surface; the `__` prefix
 * and `TestHooks` suffix make accidental third-party use obvious. Used by
 * `__tests__/chat-completions-tool-choice.test.ts` to exercise the AI-SDK
 * shape conversion helpers without spinning up the Hono router or hitting
 * any model provider.
 */
/**
 * Normalize an AI-SDK finish reason to an OpenAI `finish_reason` enum value.
 * The streaming path previously emitted the raw SDK value verbatim, leaking
 * non-OpenAI tokens like `content-filter` (hyphen), `error`, and `unknown`
 * into the wire field — strict OpenAI-compatible clients reject or mishandle
 * them. The non-streaming path already maps these; this keeps the two paths in
 * agreement.
 */
function toOpenAiFinishReason(
  raw: string | undefined,
): "stop" | "length" | "tool_calls" | "content_filter" {
  switch (raw) {
    case "tool-calls":
    case "tool_calls":
      return "tool_calls";
    case "length":
      return "length";
    case "content-filter":
    case "content_filter":
      return "content_filter";
    // "stop" / "error" / "other" / "unknown" / undefined → the OpenAI default.
    default:
      return "stop";
  }
}

export const __nativeToolingTestHooks = {
  mapToolChoice,
  convertTools,
  computeEffectiveMaxTokens,
  validateCerebrasReasoningEffort,
  buildReasoningEffortProviderOptions,
  isEmptyButBilled,
  toOpenAiFinishReason,
  resolvePromptCacheKey,
  mergePromptCacheProviderOptions,
  redactPromptCacheKey,
} as const;

/** Test seam for the non-streaming AI SDK forwarding contract. */
export const __reasoningEffortTestHooks = {
  handleNonStreamingRequest,
} as const;

/**
 * Test-only seam for the streaming credit-settlement + terminal-error-chunk
 * behavior (the money-leak repro in
 * `__tests__/chat-completions-streaming-credit-leak.test.ts`). Exposes the
 * internal streaming handler so a test can drive it with a mocked `streamText`
 * (forcing a provider 429/5xx) and a REAL credit-reservation settler, then
 * assert the reservation is released to 0 and a terminal error chunk is emitted.
 * The `__` prefix + `TestHooks` suffix mark it as non-public.
 */
export const __streamingCreditTestHooks = {
  handleStreamingRequest,
  getRecoverableProviderErrorStatus,
} as const;

export const __billingBranchTestHooks = {
  shouldUsePooledNoopReservation,
} as const;

/**
 * Test-only seam for the pass-through streaming fast path (#15428): the
 * qualification predicate and the upstream-status mapping, unit-tested
 * directly; the pipe/tee/settle behavior itself is driven through
 * `handleStreamingRequest` with a mocked global fetch in
 * `__tests__/chat-completions-passthrough-streaming.test.ts`.
 */
export const __passthroughStreamingTestHooks = {
  qualifiesForPassthroughStreaming,
  mapPassthroughUpstreamStatus,
} as const;
