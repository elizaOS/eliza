// app/api/v1/chat/completions/route.ts
import { Hono } from "hono";
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
  streamText,
} from "ai";
import { getErrorStatusCode } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { createPreflightResponse } from "@/lib/middleware/cors-apps";
import { enforceOrgRateLimit } from "@/lib/middleware/rate-limit";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  calculateCost,
  getProviderFromModel,
  getSafeModelParams,
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
  getAiProviderConfigurationError,
  getLanguageModel,
  hasLanguageModelProviderConfigured,
  resolveAiProviderSource,
} from "@/lib/providers/language-model";
import {
  billUsage,
  estimateInputTokens,
  InsufficientCreditsError,
  recordUsageAnalytics,
  reserveCredits,
} from "@/lib/services/ai-billing";
import { aiBillingRecordsService } from "@/lib/services/ai-billing-records";
import type { PricingBillingSource } from "@/lib/services/ai-pricing-definitions";
import { appCreditsService } from "@/lib/services/app-credits";
import { appsService } from "@/lib/services/apps";
import { contentModerationService } from "@/lib/services/content-moderation";
import {
  type CreditReconciliationResult,
  type CreditReservation,
  creditsService,
} from "@/lib/services/credits";
import { createCreditReservationSettler } from "@/lib/utils/credit-reservation";
import { logger } from "@/lib/utils/logger";
import { getRouteTimeoutMs } from "@/lib/utils/request-timeout";

const ROUTE_MAX_DURATION = 800;

// Minimum tokens to reserve for actual response generation when CoT is active
const MIN_RESPONSE_TOKENS = 4096;

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
      process.env.VAST_PROVIDER_INSTANCE_ID ?? process.env.VAST_INSTANCE_ID ?? null,
    providerEndpoint:
      process.env.VAST_PROVIDER_ENDPOINT ??
      process.env.VAST_ENDPOINT_URL ??
      process.env.VAST_BASE_URL ??
      null,
  };
}

/**
 * Computes effective max_tokens when Anthropic CoT is enabled.
 * When thinking is active, max_tokens must be >= budgetTokens or Anthropic API rejects.
 * Additionally, we must reserve capacity for the actual response (not just thinking).
 */
function computeEffectiveMaxTokens(
  requestMaxTokens: number | undefined,
  cotBudget: number | null,
): number | undefined {
  if (cotBudget !== null) {
    // When CoT is active, ensure max_tokens covers both thinking budget AND response capacity
    // Without this, thinking consumes all tokens leaving nothing for the actual response
    return Math.max(requestMaxTokens ?? MIN_RESPONSE_TOKENS, cotBudget + MIN_RESPONSE_TOKENS);
  }
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
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stream?: boolean;
  stop?: string | string[];
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  }>;
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
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
  if (lowerUrl.includes(".png") || lowerUrl.includes("image/png")) return "image/png";
  if (lowerUrl.includes(".gif") || lowerUrl.includes("image/gif")) return "image/gif";
  if (lowerUrl.includes(".webp") || lowerUrl.includes("image/webp")) return "image/webp";
  if (lowerUrl.includes(".svg") || lowerUrl.includes("image/svg")) return "image/svg+xml";
  // Default to JPEG for .jpg, .jpeg, or unknown
  return "image/jpeg";
}

function getImageUrl(imageUrl: { url: string } | string): string | null {
  if (typeof imageUrl === "string") {
    return imageUrl || null;
  }
  return imageUrl.url || null;
}

function inferFileMediaType(fileData: string | undefined, filename: string | undefined): string {
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

function toModelContentParts(content: Exclude<ChatMessage["content"], string | null>) {
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
          logger.warn("[chat/completions] Ignoring file part without file_data", {
            filename: part.file.filename,
            hasFileId: typeof part.file.file_id === "string",
          });
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

function convertToModelMessagesFromOpenAI(messages: ChatMessage[]): ModelMessage[] {
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
        content: assistantParts.length > 0 ? assistantParts : [{ type: "text", text: "" }],
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
        ...(tool.function.description ? { description: tool.function.description } : {}),
        inputSchema: jsonSchema(tool.function.parameters ?? { type: "object" }),
        outputSchema: jsonSchema({ type: "object", additionalProperties: true }),
      },
    ]),
  );
}

function mapToolChoice(
  toolChoice: ChatRequest["tool_choice"],
): "auto" | "none" | "required" | { type: "tool"; toolName: string } | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice === "auto" || toolChoice === "none") return toolChoice;
  return { type: "tool", toolName: toolChoice.function.name };
}

function mapResponseFormat(responseFormat: ChatRequest["response_format"]) {
  if (!responseFormat || responseFormat.type === "text") return undefined;
  const schema =
    responseFormat.type === "json_schema"
      ? (responseFormat.json_schema.schema ?? { type: "object" })
      : { type: "object", additionalProperties: true };
  const name = responseFormat.type === "json_schema" ? responseFormat.json_schema.name : undefined;
  const description =
    responseFormat.type === "json_schema" ? responseFormat.json_schema.description : undefined;

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

export const __nativeToolingTestHooks = {
  convertToModelMessagesFromOpenAI,
  convertTools,
  mapToolChoice,
  mapResponseFormat,
  formatOpenAIUsage,
};

function formatOpenAIUsage(
  billing: { inputTokens: number; outputTokens: number; totalTokens: number },
  usage: unknown,
) {
  const record = usage && typeof usage === "object" ? (usage as Record<string, unknown>) : {};
  const inputTokenDetails =
    record.inputTokenDetails && typeof record.inputTokenDetails === "object"
      ? (record.inputTokenDetails as Record<string, unknown>)
      : {};
  const promptTokenDetails =
    record.prompt_tokens_details && typeof record.prompt_tokens_details === "object"
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
  if (cacheReadInputTokens !== undefined || cacheCreationInputTokens !== undefined) {
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
  const source = errorValue && typeof errorValue === "object" ? errorValue : value;
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

function getRecoverableProviderErrorStatus(error: unknown): number | null {
  const providerError = unwrapProviderError(error);
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

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
      (providerMessage.includes("quota") && providerMessage.includes("exceeded")) ||
      message.includes("insufficient_quota")
    ) {
      return 429;
    }

    if (providerError.statusCode === 402) {
      return 402;
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

// ============================================================================
// Main Handler
// ============================================================================

interface ChatCompletionsHandlerOptions {
  skipOrgRateLimit?: boolean;
}

export async function handleChatCompletionsPOST(
  req: Request,
  options: ChatCompletionsHandlerOptions = {},
) {
  const startTime = Date.now();
  const requestId = req.headers.get("x-request-id") || crypto.randomUUID();
  const idempotencyKey = req.headers.get("idempotency-key") || requestId;
  const routeTimeoutMs = getRouteTimeoutMs(ROUTE_MAX_DURATION);
  let settleReservation:
    | ((actualCost: number) => Promise<CreditReconciliationResult | null>)
    | null = null;

  try {
    // 1. Authenticate
    const { user, apiKey } = await requireAuthOrApiKeyWithOrg(req);

    // 1b. Per-org tier rate limit
    if (user.organization_id && !options.skipOrgRateLimit) {
      const orgRateLimited = await enforceOrgRateLimit(user.organization_id, "completions");
      if (orgRateLimited) return orgRateLimited;
    }

    // 2. Check for app monetization
    const appId = req.headers.get("X-App-Id");
    let useAppCredits = false;
    let monetizedApp: Awaited<ReturnType<typeof appsService.getById>> | null = null;

    if (appId) {
      monetizedApp = await appsService.getById(appId);
      if (monetizedApp?.monetization_enabled) {
        useAppCredits = true;
      }
    }

    // 3. Parse request
    const request: ChatRequest = await req.json();

    // 4. Validate
    if (!request.model || !request.messages?.length) {
      return addCorsHeaders(
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
      );
    }

    const model = request.model;

    if (!hasLanguageModelProviderConfigured(model)) {
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

    const provider = getProviderFromModel(model);
    const normalizedModel = normalizeModelName(model);
    const billingSource = resolveAiProviderSource(model) ?? "gateway";
    const cotBudget = resolveAnthropicThinkingBudgetTokens(model, process.env);
    const cotOptions =
      cotBudget != null ? mergeAnthropicCotProviderOptions(model, process.env, cotBudget) : {};
    const effectiveMaxTokens = computeEffectiveMaxTokens(request.max_tokens, cotBudget);
    const webSearchEnabled = request.webSearchEnabled === true;
    const webSearchActive = isAnthropicWebSearchEnabled(provider, model, webSearchEnabled);
    const webSearchOptions = buildProviderNativeWebSearchTools({
      provider,
      model,
      enabled: webSearchEnabled,
      maxUses: request.webSearchMaxUses,
    });

    // 5. Check content moderation
    if (await contentModerationService.shouldBlockUser(user.id)) {
      return addCorsHeaders(
        Response.json(
          {
            error: {
              message: "Your account has been suspended due to policy violations.",
              type: "account_suspended",
              code: "moderation_violation",
            },
          },
          { status: 403 },
        ),
      );
    }

    // Start async moderation in background
    const lastUserMessage = request.messages.filter((m) => m.role === "user").pop();
    if (lastUserMessage) {
      const content = getMessageContent(lastUserMessage);
      if (content) {
        contentModerationService.moderateInBackground(content, user.id, undefined, (result) => {
          logger.warn("[Chat Completions] Async moderation detected violation", {
            userId: user.id,
            categories: result.flaggedCategories,
          });
        });
      }
    }

    // 6. Estimate tokens and reserve credits
    const estimatedInputTokens =
      estimateInputTokens(request.messages.map((m) => ({ content: getMessageContent(m) }))) +
      (webSearchActive ? ANTHROPIC_WEB_SEARCH_INPUT_TOKEN_BUFFER : 0);
    const estimatedOutputTokens = effectiveMaxTokens ?? request.max_tokens ?? 500;
    const affiliateCode = req.headers.get("X-Affiliate-Code");

    let reservation: CreditReservation;
    let appCreditsInfo:
      | { appId: string; estimatedBaseCost: number; app: typeof monetizedApp }
      | undefined;

    if (useAppCredits && appId && monetizedApp) {
      // App credits path
      const { totalCost } = await calculateCost(
        normalizedModel,
        provider,
        estimatedInputTokens,
        estimatedOutputTokens,
        billingSource,
      );
      const costWithMarkup = await appCreditsService.calculateCostWithMarkup(appId, totalCost);

      const balanceCheck = await appCreditsService.checkBalance(
        appId,
        user.id,
        costWithMarkup.totalCost,
      );
      if (!balanceCheck.sufficient) {
        return addCorsHeaders(
          Response.json(
            {
              error: {
                message: `Insufficient app credits. Required: $${costWithMarkup.totalCost.toFixed(4)}`,
                type: "insufficient_quota",
                code: "insufficient_credits",
              },
            },
            { status: 402 },
          ),
        );
      }

      // No upfront debit happens for the app-credits flow: the anonymous
      // reservation is a no-op, and the actual debit lands on the org balance
      // inside `appCreditsService.reconcileCredits` after the call resolves.
      // Reporting estimatedBaseCost=0 makes reconcile charge the full actual
      // cost as the diff, instead of treating the estimate as already paid.
      appCreditsInfo = {
        appId,
        estimatedBaseCost: 0,
        app: monetizedApp,
      };
      reservation = creditsService.createAnonymousReservation();
    } else {
      // Organization credits path
      try {
        reservation = await reserveCredits(
          {
            organizationId: user.organization_id!,
            userId: user.id,
            model,
            provider,
            billingSource,
            affiliateCode,
          },
          estimatedInputTokens,
          estimatedOutputTokens,
        );
      } catch (error) {
        if (error instanceof InsufficientCreditsError) {
          return addCorsHeaders(
            Response.json(
              {
                error: {
                  message: `Insufficient credits. Required: $${error.required.toFixed(4)}`,
                  type: "insufficient_quota",
                  code: "insufficient_credits",
                },
              },
              { status: 402 },
            ),
          );
        }
        throw error;
      }
    }

    settleReservation = createCreditReservationSettler(reservation);

    // 7. Convert messages for AI SDK
    const systemMessage = request.messages.find((m) => m.role === "system");
    const systemPrompt = systemMessage ? getMessageContent(systemMessage) : undefined;
    const nonSystemMessages = request.messages.filter((m) => m.role !== "system");
    const modelMessages = convertToModelMessagesFromOpenAI(nonSystemMessages);

    logger.info("[Chat Completions] Request", {
      model,
      messageCount: request.messages.length,
      streaming: request.stream,
      estimatedInputTokens,
      webSearchEnabled: webSearchActive,
    });

    // 8. Handle streaming vs non-streaming
    if (request.stream) {
      return await handleStreamingRequest(
        model,
        systemPrompt,
        modelMessages,
        request,
        user,
        apiKey ? { id: apiKey.id } : null,
        appCreditsInfo,
        affiliateCode,
        idempotencyKey,
        requestId,
        appId,
        startTime,
        req.signal,
        routeTimeoutMs,
        settleReservation,
        cotOptions,
        effectiveMaxTokens,
        webSearchOptions,
        billingSource,
      );
    } else {
      return await handleNonStreamingRequest(
        model,
        systemPrompt,
        modelMessages,
        request,
        user,
        apiKey ? { id: apiKey.id } : null,
        appCreditsInfo,
        affiliateCode,
        idempotencyKey,
        requestId,
        appId,
        startTime,
        req.signal,
        routeTimeoutMs,
        settleReservation,
        cotOptions,
        effectiveMaxTokens,
        webSearchOptions,
        billingSource,
      );
    }
  } catch (error) {
    await settleReservation?.(0);
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("[Chat Completions] Error", { error: errorMessage });

    const isInsufficientCredits =
      error instanceof InsufficientCreditsError ||
      errorMessage.includes("Insufficient") ||
      errorMessage.includes("credits");
    const status = isInsufficientCredits
      ? 402
      : (getRecoverableProviderErrorStatus(error) ?? getErrorStatusCode(error));
    let errorType = "api_error";
    if (status === 401) {
      errorType = "authentication_error";
    } else if (status === 402) {
      errorType = "insufficient_quota";
    } else if (status === 429) {
      errorType = "rate_limit_error";
    } else if (status === 503) {
      errorType = "service_unavailable";
    } else if (status === 400) {
      errorType = "invalid_request_error";
    }

    return addCorsHeaders(
      Response.json(
        {
          error: {
            message: errorMessage,
            type: errorType,
          },
        },
        { status },
      ),
    );
  }
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
  appCreditsInfo: { appId: string; estimatedBaseCost: number; app: unknown } | undefined,
  affiliateCode: string | null,
  idempotencyKey: string,
  requestId: string,
  appId: string | null,
  startTime: number,
  abortSignal: AbortSignal | undefined,
  timeoutMs: number,
  settleReservation: (actualCost: number) => Promise<CreditReconciliationResult | null>,
  cotOptions: ReturnType<typeof mergeAnthropicCotProviderOptions>,
  effectiveMaxTokens: number | undefined,
  webSearchOptions: ReturnType<typeof buildProviderNativeWebSearchTools>,
  billingSource: PricingBillingSource,
) {
  const provider = getProviderFromModel(model);
  const tools = convertTools(request.tools);
  const toolChoice = mapToolChoice(request.tool_choice);
  const experimentalOutput = mapResponseFormat(request.response_format);

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

  const result = streamText({
    model: getLanguageModel(model),
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
    ...cotOptions,
    onFinish: async ({ text, usage }) => {
      try {
        const billingContext = {
          organizationId: user.organization_id,
          userId: user.id,
          apiKeyId: apiKey?.id,
          model,
          provider,
          billingSource,
          requestId,
          metadata: buildProviderReconciliationMetadata(provider, model, true, appId),
          affiliateCode,
          ...buildProviderBillingFields(provider, model),
        };
        const billing = await billUsage(billingContext, usage);
        const reconciliation = await settleReservation(billing.totalCost);

        // Handle app credits reconciliation
        if (appCreditsInfo) {
          await appCreditsService.reconcileCredits({
            appId: appCreditsInfo.appId,
            userId: user.id,
            estimatedBaseCost: appCreditsInfo.estimatedBaseCost,
            actualBaseCost: billing.totalCost,
            description: `Chat reconciliation: ${model}`,
            metadata: { model, provider, billingSource, streaming: true },
          });
        }

        const usageRecord = await recordUsageAnalytics(billingContext, billing, {
          type: "chat",
          content: text,
          systemPrompt,
          prompt: request.messages.map((m) => `[${m.role}] ${getMessageContent(m)}`).join("\n"),
          latencyMs: Date.now() - startTime,
        });
        if (usageRecord) {
          await aiBillingRecordsService.record({
            context: billingContext,
            billing,
            usageRecord,
            idempotencyKey,
            reconciliation,
          });
        }

        logger.info("[Chat Completions] Streaming complete", {
          durationMs: Date.now() - startTime,
          inputTokens: billing.inputTokens,
          outputTokens: billing.outputTokens,
          totalCost: billing.totalCost,
        });
      } catch (error) {
        await settleReservation(0);
        logger.error("[Chat Completions] onFinish error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    onAbort: async () => {
      await settleReservation(0);
      logger.info("[Chat Completions] Stream aborted before completion", {
        model,
      });
    },
  });

  // Convert to OpenAI-compatible SSE stream
  const encoder = new TextEncoder();

  const openAIStream = new ReadableStream({
    async start(controller) {
      const responseId = `chatcmpl-${Date.now()}`;
      const toolCallIndexes = new Map<string, number>();
      let nextToolCallIndex = 0;
      let finishReason = "stop";

      try {
        for await (const part of result.fullStream as AsyncIterable<any>) {
          if (part.type === "text-delta") {
            const chunk = {
              id: responseId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: part.text },
                  finish_reason: null,
                },
              ],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            continue;
          }

          if (part.type === "tool-input-start") {
            const index = nextToolCallIndex++;
            toolCallIndexes.set(part.id, index);
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: responseId,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model,
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
            const index = toolCallIndexes.get(part.id) ?? 0;
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: responseId,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model,
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
            const index = toolCallIndexes.get(part.toolCallId) ?? nextToolCallIndex++;
            toolCallIndexes.set(part.toolCallId, index);
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: responseId,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model,
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
            finishReason = part.finishReason === "tool-calls" ? "tool_calls" : part.finishReason;
          }

          if (part.type === "error") {
            throw part.error;
          }
        }

        // Send final chunk with finish_reason
        const finalChunk = {
          id: responseId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: finishReason === "tool-calls" ? "tool_calls" : finishReason,
            },
          ],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.error(error);
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
  appCreditsInfo: { appId: string; estimatedBaseCost: number; app: unknown } | undefined,
  affiliateCode: string | null,
  idempotencyKey: string,
  requestId: string,
  appId: string | null,
  startTime: number,
  abortSignal: AbortSignal | undefined,
  timeoutMs: number,
  settleReservation: (actualCost: number) => Promise<CreditReconciliationResult | null>,
  cotOptions: ReturnType<typeof mergeAnthropicCotProviderOptions>,
  effectiveMaxTokens: number | undefined,
  webSearchOptions: ReturnType<typeof buildProviderNativeWebSearchTools>,
  billingSource: PricingBillingSource,
) {
  const provider = getProviderFromModel(model);
  const tools = convertTools(request.tools);
  const toolChoice = mapToolChoice(request.tool_choice);
  const experimentalOutput = mapResponseFormat(request.response_format);

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

  try {
    const result = await generateText({
      model: getLanguageModel(model),
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
      ...cotOptions,
    });

    // Bill using actual usage from SDK response
    const billingContext = {
      organizationId: user.organization_id,
      userId: user.id,
      apiKeyId: apiKey?.id,
      model,
      provider,
      billingSource,
      requestId,
      metadata: buildProviderReconciliationMetadata(provider, model, false, appId),
      affiliateCode,
      ...buildProviderBillingFields(provider, model),
    };
    const billing = await billUsage(billingContext, result.usage);
    const reconciliation = await settleReservation(billing.totalCost);

    // Handle app credits
    if (appCreditsInfo) {
      await appCreditsService.reconcileCredits({
        appId: appCreditsInfo.appId,
        userId: user.id,
        estimatedBaseCost: appCreditsInfo.estimatedBaseCost,
        actualBaseCost: billing.totalCost,
        description: `Chat: ${model}`,
        metadata: { model, provider, billingSource, streaming: false },
      });
    }

    const usageRecord = await recordUsageAnalytics(billingContext, billing, {
      type: "chat",
      content: result.text,
      systemPrompt,
      prompt: request.messages.map((m) => `[${m.role}] ${getMessageContent(m)}`).join("\n"),
      latencyMs: Date.now() - startTime,
    });
    if (usageRecord) {
      await aiBillingRecordsService.record({
        context: billingContext,
        billing,
        usageRecord,
        idempotencyKey,
        reconciliation,
      });
    }

    logger.info("[Chat Completions] Non-streaming complete", {
      durationMs: Date.now() - startTime,
      inputTokens: billing.inputTokens,
      outputTokens: billing.outputTokens,
      totalCost: billing.totalCost,
    });

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
              ...(result.toolCalls?.length
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
            finish_reason:
              result.toolCalls?.length || result.finishReason === "tool-calls"
                ? "tool_calls"
                : result.finishReason === "length"
                  ? "length"
                  : result.finishReason === "content-filter"
                    ? "content_filter"
                    : "stop",
          },
        ],
        usage: formatOpenAIUsage(billing, result.usage),
      }),
    );
  } catch (error) {
    await settleReservation(0);
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
honoRouter.post("/", rateLimit(RateLimitPresets.RELAXED), async (c) => {
  try {
    return await handleChatCompletionsPOST(c.req.raw);
  } catch (error) {
    return failureResponse(c, error);
  }
});
export default honoRouter;
