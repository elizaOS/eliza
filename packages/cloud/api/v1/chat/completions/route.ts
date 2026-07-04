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
  type StepResult,
  streamText,
  type ToolSet,
} from "ai";
import { getErrorStatusCode } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { createPreflightResponse } from "@/lib/middleware/cors-apps";
import { enforceOrgRateLimit } from "@/lib/middleware/rate-limit";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
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
  type PooledLanguageModelCredential,
  resolveAiProviderSource,
  resolvePooledDirectProviderForModel,
} from "@/lib/providers/language-model";
import {
  type AIUsage,
  type BillingContext,
  billUsage,
  estimateInputTokens,
  InsufficientCreditsError,
  recordUsageAnalytics,
  reserveCredits,
} from "@/lib/services/ai-billing";
import { aiBillingRecordsService } from "@/lib/services/ai-billing-records";
import type { PricingBillingSource } from "@/lib/services/ai-pricing-definitions";
import { apiKeysService } from "@/lib/services/api-keys";
import { appCreditsService } from "@/lib/services/app-credits";
import { appsService } from "@/lib/services/apps";
import { contentModerationService } from "@/lib/services/content-moderation";
import {
  type CreditReconciliationResult,
  type CreditReservation,
  creditsService,
} from "@/lib/services/credits";
import { resolveInferenceAuthContext } from "@/lib/services/inference-auth-context";
import {
  createOptimisticDebitSettler,
  getGateBalanceUsd,
  isOptimisticBackstopAvailable,
  isOptimisticBillingEnabled,
  isOptimisticEligible,
  resolveSafeBalanceThresholdUsd,
  writePendingInferenceCharge,
} from "@/lib/services/inference-billing-fast-path";
import {
  admitInferenceChargeViaLedger,
  createLedgerDebitSettler,
  resolveInferenceBillingLedger,
} from "@/lib/services/inference-billing-ledger";
import { getCachedGatewayModelById } from "@/lib/services/model-catalog";
import {
  getTeamPoolRegistry,
  type SelectedPooledCredential,
} from "@/lib/services/team-credential-pool";
import { createCreditReservationSettler } from "@/lib/utils/credit-reservation";
import { logger } from "@/lib/utils/logger";
import { getRouteTimeoutMs } from "@/lib/utils/request-timeout";
import { settleOffResponsePath } from "@/lib/utils/settle-off-response-path";

const ROUTE_MAX_DURATION = 800;

// Minimum tokens to reserve for actual response generation when CoT is active
const MIN_RESPONSE_TOKENS = 4096;

interface PooledInferenceCredential extends PooledLanguageModelCredential {
  organizationId: string;
  credentialId: string;
  label: string;
}

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

/**
 * Computes effective max_tokens, reserving response capacity for reasoning models.
 *
 * Reasoning models (Anthropic extended-thinking, OpenAI o-series, DeepSeek R,
 * MiniMax M, and similar families) spend output tokens on hidden chain-of-thought
 * BEFORE emitting any visible answer. If max_tokens only covers the reasoning,
 * the model truncates mid-thought and returns empty content while still billing
 * the consumed tokens. To prevent that:
 *   - Anthropic CoT: max_tokens must be >= thinking budget + response capacity
 *     (the API also hard-rejects max_tokens < thinking budget).
 *   - Any other reasoning model: floor max_tokens at MIN_RESPONSE_TOKENS so there
 *     is always room for an answer after the reasoning.
 *
 * `model` is the requested model id (provider-prefixed is fine).
 */
function computeEffectiveMaxTokens(
  requestMaxTokens: number | undefined,
  cotBudget: number | null,
  model: string,
  supportedParameters?: readonly string[],
): number | undefined {
  if (cotBudget !== null) {
    // When CoT is active, ensure max_tokens covers both thinking budget AND response capacity
    // Without this, thinking consumes all tokens leaving nothing for the actual response
    return Math.max(
      requestMaxTokens ?? MIN_RESPONSE_TOKENS,
      cotBudget + MIN_RESPONSE_TOKENS,
    );
  }
  if (modelUsesReasoningTokens(model, supportedParameters)) {
    // Non-Anthropic reasoning model. Guarantee at least MIN_RESPONSE_TOKENS so the
    // model does not truncate mid-reasoning and return empty (but billed) output.
    // If the caller asked for more, honor it; if they asked for less (or nothing),
    // raise it to the floor.
    return Math.max(
      requestMaxTokens ?? MIN_RESPONSE_TOKENS,
      MIN_RESPONSE_TOKENS,
    );
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

function getRecoverableProviderErrorStatus(error: unknown): number | null {
  const providerError = unwrapProviderError(error);
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();

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
}): Promise<PooledInferenceCredential | null> {
  const providerId = resolvePooledDirectProviderForModel(params.model);
  if (!providerId) return null;
  const selected = await getTeamPoolRegistry().selectCredential({
    organizationId: params.organizationId,
    providerId,
    sessionKey: params.sessionKey,
  });
  return selected
    ? toPooledInferenceCredential(params.organizationId, selected)
    : null;
}

async function recordPooledInferenceSuccess(
  pooledCredential: PooledInferenceCredential | null,
  userId: string,
): Promise<void> {
  if (!pooledCredential) return;
  await getTeamPoolRegistry().recordUse({
    organizationId: pooledCredential.organizationId,
    credentialId: pooledCredential.credentialId,
    userId,
  });
}

async function recordPooledInferenceFailure(
  pooledCredential: PooledInferenceCredential | null,
  error: unknown,
): Promise<void> {
  if (!pooledCredential) return;
  const status =
    getRecoverableProviderErrorStatus(error) ?? getErrorStatusCode(error);
  if (![401, 403, 429].includes(status)) return;
  await getTeamPoolRegistry().recordProviderFailure({
    organizationId: pooledCredential.organizationId,
    credentialId: pooledCredential.credentialId,
    providerId: pooledCredential.providerId,
    status,
    detail: error instanceof Error ? error.message : String(error),
  });
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
  /**
   * Cloudflare ExecutionContext. When present, the post-response billing /
   * settlement chain (billUsage → settleReservation → reconcileCredits →
   * recordUsageAnalytics → audit) is deferred via `waitUntil` so it never
   * blocks the model response. The OpenAI response `usage` is built directly
   * from the model's reported tokens (the same numbers billUsage derives), so
   * the client sees identical output and billing amounts are unchanged — only
   * the *timing* of the reconciliation writes moves off the hot path. This
   * removes ~0.7–1.1s of serial DB writes from every model call; a dedicated
   * agent makes ~10 calls/turn, so it is several seconds saved per turn.
   * Falls back to inline `await` when absent (tests / non-Worker callers).
   */
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
}

export async function handleChatCompletionsPOST(
  req: Request,
  options: ChatCompletionsHandlerOptions = {},
) {
  const startTime = Date.now();
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

  try {
    // 1. Authenticate (+ moderation). #9899: API-key dedicated-agent requests
    // resolve auth + org + moderation in a SINGLE cache read when the cache is
    // available. Non-API-key / cache-unavailable requests take the authoritative
    // slow path verbatim.
    let user: { id: string; organization_id: string };
    let apiKey: { id: string } | null;
    let moderationAlreadyChecked = false;

    const resolution = await resolveInferenceAuthContext(req);
    if (resolution.kind === "suspended") {
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
    if (resolution.kind === "authorized") {
      user = {
        id: resolution.ctx.userId,
        organization_id: resolution.ctx.orgId,
      };
      apiKey = { id: resolution.ctx.apiKeyId };
      // The resolver already verified not-suspended (cache hit = at populate;
      // origin miss = just now), so the synchronous moderation read is skipped.
      moderationAlreadyChecked = true;
    } else {
      const authed = await requireAuthOrApiKeyWithOrg(req);
      user = authed.user;
      apiKey = authed.apiKey ? { id: authed.apiKey.id } : null;
    }
    // Pre-forward latency instrumentation (#9899): measured TTFT through this
    // route is ~6.5s while cerebras-direct is ~0.24s — 100% of the overhead is
    // pre-forward work, not the model. These marks split it (auth vs the
    // rate-limit/app/catalog/moderation reads vs the reserve write) so the next
    // fix targets the real cross-region-Railway hotspot instead of guessing.
    const tAuth = Date.now();

    // 1b. Per-org tier rate limit
    if (user.organization_id && !options.skipOrgRateLimit) {
      const orgRateLimited = await enforceOrgRateLimit(
        user.organization_id,
        "completions",
      );
      if (orgRateLimited) return orgRateLimited;
    }

    // 2. Check for app monetization
    const requestedAppId = req.headers.get("X-App-Id");
    let appId: string | null = null;
    let useAppCredits = false;
    let monetizedApp: Awaited<ReturnType<typeof appsService.getById>> | null =
      null;

    if (requestedAppId) {
      monetizedApp =
        (await appsService.getAuthorizedMonetizedAppForUser(
          requestedAppId,
          user,
        )) ?? null;
      appId = monetizedApp?.id ?? null;
      useAppCredits = Boolean(monetizedApp);
    }

    // 3. Parse request — guard a malformed/empty body to a 400 instead of a 500.
    // An unguarded parse throws a SyntaxError that the outer catch maps to 500
    // (and echoes the raw parse text); the sibling agents routes already guard
    // this. Also require `messages` to be an ARRAY so a non-array value can't
    // slip past the length check and TypeError later in `messages.filter(...)`.
    const request = (await req.json().catch(() => null)) as ChatRequest | null;

    // 4. Validate
    if (
      !request?.model ||
      !Array.isArray(request.messages) ||
      !request.messages.length
    ) {
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

    // Collapse decorated Cerebras ids (e.g. "openai/gpt-oss-120b:nitro" emitted
    // by dedicated agents) to the bare Cerebras id so pricing, routing, and
    // billing all agree and route to cerebras-direct instead of OpenRouter.
    const model = canonicalizeCerebrasModelId(request.model);
    const pooledCredential = await selectPooledInferenceCredential({
      model,
      organizationId: user.organization_id,
      sessionKey: apiKey?.id ?? user.id,
    });

    if (!pooledCredential && !hasLanguageModelProviderConfigured(model)) {
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
    const billingSource = pooledCredential
      ? "gateway"
      : (resolveAiProviderSource(model) ?? "gateway");
    const cotBudget = resolveAnthropicThinkingBudgetTokens(model, process.env);
    const cotOptions =
      cotBudget != null
        ? mergeAnthropicCotProviderOptions(model, process.env, cotBudget)
        : {};
    // Authoritative reasoning detection: many reasoning models (kimi-k2.6,
    // glm-5.1, deepseek-v4-pro, ...) do not carry a "think"/"reasoning" id but
    // do advertise a reasoning parameter in the catalog. Best-effort lookup;
    // on any failure we fall back to id name-pattern detection.
    let modelSupportedParameters: string[] | undefined;
    // #9899: skip the reasoning-detection catalog read when id name-pattern
    // detection ALREADY classifies this as a reasoning model. The catalog can
    // only ADD reasoning, never remove it (modelUsesReasoningTokens ORs the two
    // signals), so for a name-pattern match the catalog cannot change
    // computeEffectiveMaxTokens — the read is pure latency. Default now (the
    // hot-path cache is no longer flag-gated); pinned to the name-pattern set.
    const skipCatalogLookup = modelUsesReasoningTokens(model);
    if (!skipCatalogLookup) {
      try {
        const catalogModel = await getCachedGatewayModelById(model);
        modelSupportedParameters = catalogModel?.supported_parameters;
      } catch (error) {
        logger.warn(
          "[Chat Completions] reasoning-detection catalog lookup failed; using name patterns",
          {
            model,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
    const effectiveMaxTokens = computeEffectiveMaxTokens(
      request.max_tokens,
      cotBudget,
      model,
      modelSupportedParameters,
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
    if (!moderationAlreadyChecked) {
      if (await contentModerationService.shouldBlockUser(user.id)) {
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
        contentModerationService.moderateInBackground(
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
            // Drop the user's IAC so the next request re-checks authoritatively
            // (#9899; the hot-path cache is the default auth path now).
            void apiKeysService.invalidateInferenceContextForUser(user.id);
          },
        );
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

    const tBeforeReserve = Date.now();
    let reservation: CreditReservation | null = null;
    // #9899 Tier-2: set when the optimistic off-path billing branch is taken;
    // replaces the reservation settler with a deferred actual-cost debit.
    let optimisticSettler:
      | ((actualCost: number) => Promise<CreditReconciliationResult | null>)
      | null = null;

    const useMonetizedAppBilling = Boolean(
      useAppCredits && appId && monetizedApp,
    );
    if (useAppCredits && appId && monetizedApp) {
      const { totalCost } = await calculateCost(
        normalizedModel,
        provider,
        estimatedInputTokens,
        estimatedOutputTokens,
        billingSource,
      );

      try {
        reservation = await appCreditsService.reserveInferenceCredits({
          appId,
          userId: user.id,
          estimatedBaseCost: totalCost,
          description: `Chat completion: ${model}`,
          idempotencyKey,
          metadata: {
            model,
            provider,
            billingSource,
            requestId,
            route: "chat_completions",
            streaming: request.stream === true,
            estimatedInputTokens,
            estimatedOutputTokens,
          },
          app: monetizedApp,
        });
      } catch (error) {
        if (error instanceof InsufficientCreditsError) {
          return addCorsHeaders(
            Response.json(
              {
                error: {
                  message: `Insufficient cloud credits. Required: $${error.required.toFixed(4)}`,
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
    } else if (
      shouldUsePooledNoopReservation({
        pooledCredential,
        useMonetizedAppBilling,
      })
    ) {
      reservation = creditsService.createAnonymousReservation();
    } else {
      // Organization credits path. #9899 Tier-2: when optimistic billing is
      // enabled AND this org's balance comfortably clears SAFE_BALANCE_THRESHOLD,
      // skip the synchronous reserve write — instead reserve the charge against a
      // durable backstop and defer the FULL actual-cost debit to the post-response
      // settler. Otherwise take the existing synchronous reserve.
      //
      // The durable backstop is selected by INFERENCE_BILLING_LEDGER: "db" uses
      // the inference_pending_charges ledger (atomic overdraw bound + exactly-once
      // settle + age-ordered sweep), otherwise the KV backstop. The ledger's
      // admission is itself the gate (it reads a fresh balance under a row lock),
      // so it does not need the KV org-balance hint or a writable cache.
      let optimisticReady = false;
      const optimisticBillingEnabled = isOptimisticBillingEnabled();
      // #12749: affiliate-marked requests must take the synchronous reserve.
      // Both optimistic branches admit on the base/platform estimate only, while
      // affiliate markup is resolved inside reserveCredits. The later billUsage
      // call does not receive a reservation, so the collected-earnings clamp is
      // inert on an optimistic path. Falling through keeps the affiliate math
      // single-sourced in reserveCredits and 402s upfront when base+markup is
      // not covered.
      const optimisticAllowedForRequest =
        optimisticBillingEnabled && affiliateCode === null;
      const useDbLedger =
        optimisticAllowedForRequest && resolveInferenceBillingLedger() === "db";

      if (useDbLedger) {
        const { totalCost } = await calculateCost(
          normalizedModel,
          provider,
          estimatedInputTokens,
          estimatedOutputTokens,
          billingSource,
        );
        const admission = await admitInferenceChargeViaLedger({
          charge: {
            requestId,
            organizationId: user.organization_id,
            userId: user.id,
            apiKeyId: apiKey?.id ?? null,
            model,
            provider,
            billingSource,
          },
          estimatedCostUsd: totalCost,
          thresholdUsd: resolveSafeBalanceThresholdUsd(),
        });
        if (admission.admitted) {
          reservation = creditsService.createAnonymousReservation();
          optimisticSettler = createLedgerDebitSettler({
            requestId,
            organizationId: user.organization_id,
            userId: user.id,
            apiKeyId: apiKey?.id ?? null,
            model,
            provider,
            billingSource,
          });
          optimisticReady = true;
        }
      }

      // KV backstop path (unchanged). Only consider it when the DB ledger is not
      // selected and the cache is writable — otherwise a forwarded request would
      // have no recorded charge (free inference). Mirrors the IAC resolver's
      // cache-health guard.
      let useOptimistic = false;
      let estimatedCostUsd = 0;
      if (
        !optimisticReady &&
        optimisticAllowedForRequest &&
        !useDbLedger &&
        isOptimisticBackstopAvailable()
      ) {
        const { totalCost } = await calculateCost(
          normalizedModel,
          provider,
          estimatedInputTokens,
          estimatedOutputTokens,
          billingSource,
        );
        estimatedCostUsd = totalCost;
        const balanceUsd = await getGateBalanceUsd(user.organization_id);
        useOptimistic = isOptimisticEligible({
          enabled: true,
          useAppCredits: false,
          balanceUsd,
          thresholdUsd: resolveSafeBalanceThresholdUsd(),
          estimatedCostUsd,
        });
      }

      // Optimistic path is taken ONLY if the durable pending-charge actually
      // persisted; a non-durable backstop falls through to the synchronous
      // reserve so we never forward on an un-recorded charge (#9899).
      if (useOptimistic) {
        const persisted = await writePendingInferenceCharge(
          {
            requestId,
            organizationId: user.organization_id,
            userId: user.id,
            apiKeyId: apiKey?.id ?? null,
            model,
            provider,
            billingSource,
            estimatedCostUsd,
          },
          Date.now(),
        );
        if (persisted) {
          reservation = creditsService.createAnonymousReservation();
          optimisticSettler = createOptimisticDebitSettler({
            requestId,
            organizationId: user.organization_id,
            userId: user.id,
            model,
            provider,
            billingSource,
          });
          optimisticReady = true;
        } else {
          logger.warn(
            "[Chat Completions] optimistic backstop not durable; using synchronous reserve",
            { requestId, organizationId: user.organization_id },
          );
        }
      }

      if (!optimisticReady) {
        try {
          reservation = await reserveCredits(
            {
              organizationId: user.organization_id,
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
    }

    // Optimistic path debits the actual cost off the response path; otherwise the
    // reservation settler reconciles the upfront hold. Same (actualCost) shape.
    if (
      shouldUsePooledNoopReservation({
        pooledCredential,
        useMonetizedAppBilling,
      })
    ) {
      settleReservation = async () => null;
    } else if (optimisticSettler) {
      settleReservation = optimisticSettler;
    } else {
      if (!reservation) {
        throw new Error("[Chat Completions] credit reservation missing");
      }
      settleReservation = createCreditReservationSettler(reservation);
    }
    const tAfterReserve = Date.now();

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
      model,
      messageCount: request.messages.length,
      streaming: request.stream,
      estimatedInputTokens,
      webSearchEnabled: webSearchActive,
    });

    // Pre-forward latency breakdown (#9899). authMs = auth+org DB lookup;
    // midReadsMs = rate-limit + app + reasoning-catalog + moderation (these run
    // serially and are independent → the parallelization candidate); reserveMs =
    // the credit-reservation DB write; totalMs = everything before the model
    // call. Compare against cerebras-direct ~0.24s to see how much of TTFT is us.
    logger.info("[Chat Completions][preforward]", {
      model,
      authMs: tAuth - startTime,
      midReadsMs: tBeforeReserve - tAuth,
      reserveMs: tAfterReserve - tBeforeReserve,
      totalMs: Date.now() - startTime,
      stream: request.stream === true,
    });

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
          cotOptions,
          effectiveMaxTokens,
          webSearchOptions,
          billingSource,
          pooledCredential,
          useMonetizedAppBilling,
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
          cotOptions,
          effectiveMaxTokens,
          webSearchOptions,
          billingSource,
          pooledCredential,
          useMonetizedAppBilling,
          options.executionCtx,
        );
    // Emit per-step pre-forward timing as a readable header (#9899). Debug-only
    // numbers, no behavior change. totalMs = everything before the model
    // forward; compare vs cerebras-direct ~0.24s to see how much of TTFT is us.
    try {
      preforwardResponse.headers.set(
        "X-Eliza-Preforward-Ms",
        `total=${Date.now() - startTime};auth=${tAuth - startTime};mid=${tBeforeReserve - tAuth};reserve=${tAfterReserve - tBeforeReserve}`,
      );
    } catch {
      // Some Response shapes have immutable headers — never fail a request for a debug header.
    }
    return preforwardResponse;
  } catch (error) {
    await settleReservation?.(0);
    const rawMessage = error instanceof Error ? error.message : String(error);
    logger.error("[Chat Completions] Error", {
      error: rawMessage,
      cause:
        error instanceof Error && error.cause
          ? String((error.cause as Error).message ?? error.cause)
          : undefined,
    });
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
  if (status === 400) return "invalid_request_error";
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
    const billing = await billUsage(billingContext, {
      inputTokens,
      outputTokens,
      totalTokens,
      cacheReadInputTokens: finishedStepUsage?.cacheReadInputTokens,
      cacheWriteInputTokens: finishedStepUsage?.cacheWriteInputTokens,
    });
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
      "[Chat Completions] Stream abort partial settlement failed; refunding reservation",
      {
        model: params.model,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return await params.settleReservation(0);
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
  cotOptions: ReturnType<typeof mergeAnthropicCotProviderOptions>,
  effectiveMaxTokens: number | undefined,
  webSearchOptions: ReturnType<typeof buildProviderNativeWebSearchTools>,
  billingSource: PricingBillingSource,
  pooledCredential: PooledInferenceCredential | null,
  useMonetizedAppBilling: boolean,
) {
  const provider = getProviderFromModel(model);
  const tools = convertTools(request.tools);
  const toolChoice = mapToolChoice(request.tool_choice);
  const experimentalOutput = mapResponseFormat(request.response_format);
  const billingPrompt = buildChatPromptForBilling(request);
  const billingAffiliateCode =
    pooledCredential && !useMonetizedAppBilling ? null : affiliateCode;
  let deliveredText = "";
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

  const refundStreamingReservationOnce = () =>
    settleStreamingOnce(async () => await settleReservation(0));

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

  const result = streamText({
    model: getLanguageModel(model, pooledCredential ?? undefined),
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
      await settleStreamingOnce(async () => {
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
          const billing = await billUsage(billingContext, usage);
          const reconciliation = await settleReservation(billing.totalCost);
          await recordPooledInferenceSuccess(pooledCredential, user.id);

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
          const reconciliation = await settleReservation(0);
          logger.error("[Chat Completions] onFinish error", {
            error: error instanceof Error ? error.message : String(error),
          });
          return reconciliation;
        }
      });
    },
    onAbort: async ({
      steps,
    }: {
      readonly steps: readonly StepResult<ToolSet>[];
    }) => {
      await settleStreamingAbortOnce(steps);
      logger.info("[Chat Completions] Stream aborted before completion", {
        model,
        estimatedInputTokens,
        deliveredOutputTokens: estimateTokens(deliveredText),
      });
    },
    // A provider error during streaming (e.g. the cerebras 429/5xx the
    // fail-fast path surfaces) fires onError — NOT onFinish or onAbort. Without
    // this, the upfront credit reservation is never reconciled and the user is
    // billed for zero output. Mirrors the non-streaming error path's
    // settleReservation(0). The settler is idempotent (first-call-wins), so a
    // later onFinish/onAbort cannot double-refund.
    onError: async ({ error }: { error: unknown }) => {
      await refundStreamingReservationOnce();
      await recordPooledInferenceFailure(pooledCredential, error);
      logger.error(
        "[Chat Completions] Stream provider error — reservation refunded",
        {
          model,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    },
  } as Parameters<typeof streamText>[0]);

  // Convert to OpenAI-compatible SSE stream
  const encoder = new TextEncoder();

  const openAIStream = new ReadableStream({
    async start(controller) {
      const responseId = `chatcmpl-${Date.now()}`;
      const toolCallIndexes = new Map<string, number>();
      let nextToolCallIndex = 0;
      let finishReason = "stop";

      try {
        for await (const part of result.fullStream) {
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
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
            );
            deliveredText += part.text;
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
            const index =
              toolCallIndexes.get(part.toolCallId) ?? nextToolCallIndex++;
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
            finishReason =
              part.finishReason === "tool-calls"
                ? "tool_calls"
                : part.finishReason;
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
              finish_reason:
                finishReason === "tool-calls" ? "tool_calls" : finishReason,
            },
          ],
        };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`),
        );
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
        // does not await) onError, so settle the reservation here too. The
        // settler is idempotent, so this cannot double-refund if onError already
        // won the race.
        const streamAborted = abortSignal?.aborted === true;
        if (streamAborted) {
          await settleStreamingAbortOnce([]);
        } else {
          await refundStreamingReservationOnce();
          await recordPooledInferenceFailure(pooledCredential, error);
        }
        const status =
          getRecoverableProviderErrorStatus(error) ?? getErrorStatusCode(error);
        try {
          const errorChunk = {
            error: {
              message: error instanceof Error ? error.message : String(error),
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
  cotOptions: ReturnType<typeof mergeAnthropicCotProviderOptions>,
  effectiveMaxTokens: number | undefined,
  webSearchOptions: ReturnType<typeof buildProviderNativeWebSearchTools>,
  billingSource: PricingBillingSource,
  pooledCredential: PooledInferenceCredential | null,
  useMonetizedAppBilling: boolean,
  executionCtx: { waitUntil(promise: Promise<unknown>): void } | undefined,
) {
  const provider = getProviderFromModel(model);
  const tools = convertTools(request.tools);
  const toolChoice = mapToolChoice(request.tool_choice);
  const experimentalOutput = mapResponseFormat(request.response_format);
  const billingAffiliateCode =
    pooledCredential && !useMonetizedAppBilling ? null : affiliateCode;

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
      model: getLanguageModel(model, pooledCredential ?? undefined),
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
    } as Parameters<typeof generateText>[0]);

    // Token counts for the OpenAI-compat response come straight from the
    // model's reported usage — identical to what billUsage normalizes
    // (inputTokens ?? promptTokens, etc.) — so the entire billing/settlement
    // chain below can run off the response path without changing the bytes the
    // client receives.
    const usageRec = (result.usage ?? {}) as {
      inputTokens?: number;
      promptTokens?: number;
      outputTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    };
    const responseInputTokens =
      usageRec.inputTokens ?? usageRec.promptTokens ?? 0;
    const responseOutputTokens =
      usageRec.outputTokens ?? usageRec.completionTokens ?? 0;
    const responseTokens = {
      inputTokens: responseInputTokens,
      outputTokens: responseOutputTokens,
      totalTokens:
        usageRec.totalTokens ?? responseInputTokens + responseOutputTokens,
    };
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
        const billing = await billUsage(billingContext, result.usage);
        const reconciliation = await settleReservation(billing.totalCost);
        await recordPooledInferenceSuccess(pooledCredential, user.id);

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
        // Deferred billing failed after the response was already sent: release
        // the held reservation so credit isn't stuck, and log. idempotencyKey
        // keeps any later retry safe.
        try {
          await settleReservation(0);
        } catch {
          // best-effort release
        }
        logger.error("[Chat Completions] deferred billing failed", {
          error:
            billingError instanceof Error
              ? billingError.message
              : String(billingError),
        });
      }
    });

    // Reasoning-model empty-output guard.
    // A reasoning model can spend its whole output budget on hidden
    // chain-of-thought and return empty visible text while still billing the
    // consumed tokens. The budget floor in computeEffectiveMaxTokens prevents
    // the common case, but if it still happens, surface it honestly: report
    // finish_reason "length" (so OpenAI-compatible clients retry with a higher
    // max_tokens) instead of a misleading "stop" with null content.
    const hasToolCalls = Boolean(result.toolCalls?.length);
    const visibleText = result.text || "";
    const emptyButBilled =
      !visibleText && !hasToolCalls && (result.usage?.outputTokens ?? 0) > 0;
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
    await settleReservation?.(0);
    await recordPooledInferenceFailure(pooledCredential, error);
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
    return await handleChatCompletionsPOST(c.req.raw, {
      executionCtx: c.executionCtx,
    });
  } catch (error) {
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
export const __nativeToolingTestHooks = {
  mapToolChoice,
  convertTools,
  computeEffectiveMaxTokens,
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
} as const;

export const __billingBranchTestHooks = {
  shouldUsePooledNoopReservation,
} as const;
