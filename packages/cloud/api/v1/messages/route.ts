/**
 * POST /api/v1/messages — Anthropic Messages API-compatible endpoint.
 *
 * Streaming via Pattern B (hand-built SSE over `ReadableStream`). Returns a
 * `Response` with a streaming body — Hono passes it through unchanged.
 *
 * WHY: Claude Code and Anthropic SDK clients speak POST /v1/messages.
 * This route lets them use elizaOS Cloud credits/auth without a custom proxy.
 */

import {
  type AssistantModelMessage,
  generateText,
  type ImagePart,
  type JSONValue,
  jsonSchema,
  type ModelMessage,
  type StepResult,
  streamText,
  type TextPart,
  type ToolCallPart,
  type ToolContent,
  type ToolResultPart,
  type ToolSet,
  type UserModelMessage,
} from "ai";
import { Hono } from "hono";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  enforceOrgRateLimit,
  OrgRateLimitCacheNotReadyError,
} from "@/lib/middleware/rate-limit";
import {
  bindGatewayHandoffTelemetry,
  type GatewayHandoffTelemetry,
  type GatewayPreforwardTiming,
  resolveElizaTraceId,
  snapshotGatewayPreforwardTiming,
  withGatewayPreforwardTelemetry,
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
  canonicalizeCerebrasModelId,
  getLanguageModel,
  isProviderConfigurationError,
  resolveAiProviderSource,
} from "@/lib/providers/language-model";
import { getRequestIdempotencyKey } from "@/lib/runtime/request-context";
import {
  type AIUsage,
  billUsage,
  estimateInputTokens,
  InsufficientCreditsError,
  normalizeUsage,
  recordUsageAnalytics,
} from "@/lib/services/ai-billing";
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
import { inferenceRateLimitConfig } from "@/lib/services/inference-admission-snapshot";
import type { InferenceAdmissionSnapshot } from "@/lib/services/inference-auth-cache";
import { resolveInferenceAuthContext } from "@/lib/services/inference-auth-context";
import { InferenceBalanceCacheWarmingError } from "@/lib/services/inference-billing-fast-path";
import {
  isKnownPreDispatchProviderConfigurationError,
  isKnownUnacceptedProviderError,
} from "@/lib/services/inference-provider-outcome";
import { admitOrganizationInference } from "@/lib/services/organization-inference-admission";
import { createCreditReservationSettler } from "@/lib/utils/credit-reservation";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import { logger } from "@/lib/utils/logger";
import { getRouteTimeoutMs } from "@/lib/utils/request-timeout";
import { settleOffResponsePath } from "@/lib/utils/settle-off-response-path";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const ROUTE_MAX_DURATION = 800;

type AnthropicTextBlock = { type: "text"; text: string };

type AnthropicImageBlock = {
  type: "image";
  source:
    | { type: "url"; url: string }
    | { type: "base64"; media_type: string; data: string };
};

type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicContentBlock[];
};

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

type AnthropicResponseBlock = AnthropicTextBlock | AnthropicToolUseBlock;

interface AnthropicMessageParam {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

type AnthropicSystemParam =
  | string
  | Array<{ type: "text"; text: string; cache_control?: unknown }>;

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "none" }
  | { type: "tool"; name: string };

interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessageParam[];
  system?: AnthropicSystemParam;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
}

type AnthropicStopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use";

type ToolNameMap = Map<string, string>;

function normalizeModelId(model: string): string {
  const canonicalCerebrasModel = canonicalizeCerebrasModelId(model);
  if (canonicalCerebrasModel !== model) return canonicalCerebrasModel;
  if (model.includes("/")) return model;
  if (model.startsWith("claude-")) return `anthropic/${model}`;
  return model;
}

const MESSAGES_MIN_RESPONSE_TOKENS = 4096;

/**
 * Response-token budget for a /v1/messages generation. Mirrors the
 * chat/completions floor: Anthropic CoT needs headroom for thinking PLUS the
 * answer, and non-Anthropic reasoning models (cerebras zai-glm-4.7 /
 * gpt-oss-120b / gemma-4-31b) spend hidden reasoning tokens — without a floor a
 * small `max_tokens` is consumed by reasoning alone and the caller is billed
 * for empty output. Non-reasoning models pass their requested budget through.
 */
export function messagesEffectiveMaxTokens(
  requestMaxTokens: number | undefined,
  cotBudget: number | null,
  model: string,
): number | undefined {
  if (cotBudget != null) {
    return Math.max(
      requestMaxTokens ?? MESSAGES_MIN_RESPONSE_TOKENS,
      cotBudget + MESSAGES_MIN_RESPONSE_TOKENS,
    );
  }
  if (modelUsesReasoningTokens(model)) {
    return Math.max(
      requestMaxTokens ?? MESSAGES_MIN_RESPONSE_TOKENS,
      MESSAGES_MIN_RESPONSE_TOKENS,
    );
  }
  return requestMaxTokens;
}

function inferImageMediaType(urlOrType: string): string {
  const lower = urlOrType.toLowerCase().trim();

  if (lower === "image/png") return "image/png";
  if (lower === "image/gif") return "image/gif";
  if (lower === "image/webp") return "image/webp";
  if (lower === "image/svg+xml") return "image/svg+xml";

  if (lower.startsWith("data:image/")) {
    const match = lower.match(/^data:(image\/[a-z0-9.+-]+)[;,]/);
    if (match) {
      return match[1];
    }
  }

  let pathOrUrl = lower;
  try {
    pathOrUrl = new URL(urlOrType).pathname.toLowerCase();
  } catch {
    // Keep original string when it is not a URL.
  }

  if (pathOrUrl.endsWith(".png")) return "image/png";
  if (pathOrUrl.endsWith(".gif")) return "image/gif";
  if (pathOrUrl.endsWith(".webp")) return "image/webp";
  if (pathOrUrl.endsWith(".svg")) return "image/svg+xml";
  return "image/jpeg";
}

function normalizeSystemPrompt(
  system: AnthropicSystemParam | undefined,
): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system;
  return system.map((block) => block.text).join("\n\n");
}

function mapToolChoice(
  toolChoice: AnthropicToolChoice | undefined,
):
  | "auto"
  | "none"
  | "required"
  | { type: "tool"; toolName: string }
  | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "none") return "none";
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "tool") {
    return { type: "tool", toolName: toolChoice.name };
  }
  return undefined;
}

function convertTools(tools: AnthropicTool[] | undefined):
  | Record<
      string,
      {
        description?: string;
        inputSchema: ReturnType<typeof jsonSchema>;
        outputSchema: ReturnType<typeof jsonSchema>;
      }
    >
  | undefined {
  if (!tools?.length) return undefined;

  const result: Record<
    string,
    {
      description?: string;
      inputSchema: ReturnType<typeof jsonSchema>;
      outputSchema: ReturnType<typeof jsonSchema>;
    }
  > = {};

  for (const tool of tools) {
    result[tool.name] = {
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: jsonSchema(tool.input_schema),
      outputSchema: jsonSchema({
        type: "object",
        additionalProperties: true,
      }),
    };
  }

  return result;
}

function toImageData(urlOrData: string): string | URL {
  if (urlOrData.startsWith("data:")) return urlOrData;

  try {
    return new URL(urlOrData);
  } catch {
    return urlOrData;
  }
}

function serializeToolResultContent(
  content: string | AnthropicContentBlock[],
): string | Record<string, unknown> | AnthropicContentBlock[] {
  if (typeof content === "string") return content;

  if (content.length === 1 && content[0]?.type === "text") {
    return content[0].text;
  }

  return content;
}

function toToolResultOutput(
  content: string | AnthropicContentBlock[],
): ToolResultPart["output"] {
  const serialized = serializeToolResultContent(content);

  if (typeof serialized === "string") {
    return { type: "text" as const, value: serialized };
  }

  return {
    type: "json" as const,
    value: JSON.parse(JSON.stringify(serialized)) as JSONValue,
  };
}

function trackToolNames(
  content: string | AnthropicContentBlock[],
  toolNames: ToolNameMap,
): void {
  if (typeof content === "string") return;

  for (const block of content) {
    if (block.type === "tool_use") {
      toolNames.set(block.id, block.name);
    }
  }
}

function anthropicMessagesToModelMessages(
  messages: AnthropicMessageParam[],
): ModelMessage[] {
  const modelMessages: ModelMessage[] = [];
  const toolNames = new Map<string, string>();

  for (const message of messages) {
    trackToolNames(message.content, toolNames);
  }

  for (const message of messages) {
    if (message.role === "user") {
      const userParts: Array<TextPart | ImagePart> = [];
      const toolResults: ToolContent = [];

      if (typeof message.content === "string") {
        userParts.push({ type: "text", text: message.content });
      } else {
        for (const block of message.content) {
          if (block.type === "text") {
            userParts.push({ type: "text", text: block.text });
            continue;
          }

          if (block.type === "image" && block.source.type === "url") {
            userParts.push({
              type: "image",
              image: toImageData(block.source.url),
              mediaType: inferImageMediaType(block.source.url),
            });
            continue;
          }

          if (block.type === "image" && block.source.type === "base64") {
            const mediaType = inferImageMediaType(block.source.media_type);
            userParts.push({
              type: "image",
              image: `data:${mediaType};base64,${block.source.data}`,
              mediaType,
            });
            continue;
          }

          if (block.type === "tool_result") {
            toolResults.push({
              type: "tool-result",
              toolCallId: block.tool_use_id,
              toolName: toolNames.get(block.tool_use_id) ?? "unknown_tool",
              output: toToolResultOutput(block.content),
            });
          }
        }
      }

      if (userParts.length > 0) {
        const userMessage: UserModelMessage = {
          role: "user",
          content: userParts,
        };
        modelMessages.push(userMessage);
      }

      if (toolResults.length > 0) {
        const toolMessage = {
          role: "tool",
          content: toolResults,
        } satisfies { role: "tool"; content: ToolContent };
        modelMessages.push(toolMessage);
      }

      continue;
    }

    const assistantParts: Array<TextPart | ToolCallPart | ToolResultPart> = [];

    if (typeof message.content === "string") {
      assistantParts.push({ type: "text", text: message.content });
    } else {
      for (const block of message.content) {
        if (block.type === "text") {
          assistantParts.push({ type: "text", text: block.text });
          continue;
        }

        if (block.type === "tool_use") {
          assistantParts.push({
            type: "tool-call",
            toolCallId: block.id,
            toolName: block.name,
            input: block.input,
          });
          continue;
        }

        if (block.type === "tool_result") {
          assistantParts.push({
            type: "tool-result",
            toolCallId: block.tool_use_id,
            toolName: toolNames.get(block.tool_use_id) ?? "unknown_tool",
            output: toToolResultOutput(block.content),
          });
        }
      }
    }

    const assistantMessage: AssistantModelMessage = {
      role: "assistant",
      content:
        assistantParts.length > 0
          ? assistantParts
          : [{ type: "text", text: "" }],
    };
    modelMessages.push(assistantMessage);
  }

  return modelMessages;
}

function getMessageContentForEstimate(message: AnthropicMessageParam): string {
  if (typeof message.content === "string") return message.content;

  return message.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_use") return JSON.stringify(block.input);
      if (block.type === "tool_result") {
        const serialized = serializeToolResultContent(block.content);
        return typeof serialized === "string"
          ? serialized
          : JSON.stringify(serialized);
      }
      return "";
    })
    .join(" ");
}

function mapFinishReason(
  finishReason: string,
  rawFinishReason: string | undefined,
  hasToolCalls: boolean,
): AnthropicStopReason {
  if (hasToolCalls || finishReason === "tool-calls") return "tool_use";
  if (rawFinishReason?.includes("stop_sequence")) return "stop_sequence";
  if (finishReason === "length" || rawFinishReason === "max_tokens") {
    return "max_tokens";
  }
  return "end_turn";
}

function resolveStopSequence(
  stopReason: AnthropicStopReason,
  rawFinishReason: string | undefined,
  requestedStopSequences: string[] | undefined,
): string | null {
  if (stopReason !== "stop_sequence") return null;

  if (
    rawFinishReason &&
    rawFinishReason !== "stop_sequence" &&
    requestedStopSequences?.includes(rawFinishReason)
  ) {
    return rawFinishReason;
  }

  if (requestedStopSequences?.length === 1) {
    return requestedStopSequences[0];
  }

  return null;
}

function anthropicError(
  type: string,
  message: string,
  status: number,
  headers?: HeadersInit,
): Response {
  return Response.json(
    { type: "error", error: { type, message } },
    { status: status as 400, headers },
  );
}

/**
 * Client-facing message for an unresolvable model. Mirrors the
 * /v1/chat/completions boundary (#13913): when `getLanguageModel` /
 * provider resolution raises a configuration error, the caller must see a clean, model-scoped
 * error — never the internal provider/gateway config detail.
 */
function modelNotAvailableMessage(model: string): string {
  return `model '${model}' is not available on this deployment`;
}

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  const startTime = Date.now();
  const telemetryStartedAt = performance.now();
  const traceId = c.get("traceId") ?? resolveElizaTraceId(c.req.raw.headers);
  let preforwardTiming: GatewayPreforwardTiming | undefined;
  const attachPreforwardTelemetry = (response: Response): Response =>
    preforwardTiming
      ? withGatewayPreforwardTelemetry(response, traceId, preforwardTiming)
      : response;
  const routeTimeoutMs = getRouteTimeoutMs(ROUTE_MAX_DURATION);
  // Workers ExecutionContext retains post-response accounting. Hono throws
  // outside a Worker, where local tools keep their synchronous compatibility.
  let executionCtx: { waitUntil(promise: Promise<unknown>): void } | undefined;
  try {
    const candidate = c.executionCtx;
    executionCtx =
      typeof candidate?.waitUntil === "function" ? candidate : undefined;
  } catch {
    // error-policy:J4 local Hono hosts have no Workers execution context; an
    // enabled Worker configuration fails closed immediately below.
    executionCtx = undefined;
  }
  if (!executionCtx && c.env?.INFERENCE_DEFERRED_ADMISSION === "true") {
    logger.error(
      "[Messages] Worker execution context is unavailable for cache-only inference",
    );
    return anthropicError(
      "api_error",
      "Inference authorization is warming. Retry shortly.",
      503,
    );
  }
  let settleReservation:
    | ((actualCost: number) => Promise<CreditReconciliationResult | null>)
    | null = null;
  let settleUnknownReservation:
    | (() => Promise<CreditReconciliationResult | null>)
    | null = null;
  let markProviderDispatched: (() => Promise<void>) | undefined;
  let billingReservation: CreditReservation | undefined;

  let user: { id: string; organization_id: string };
  let apiKey: { id: string } | null = null;
  // Collapse auth + org + suspension into one cache decision for API-key and
  // Steward-session inference. Cold Workers schedule authoritative hydration
  // and return a retryable response; wallet proofs stay on the non-Worker path
  // because their timestamped signatures are not reusable cache identities.
  let moderationAlreadyChecked = false;
  let admissionSnapshot: InferenceAdmissionSnapshot | undefined;
  try {
    const resolution = await resolveInferenceAuthContext(c.req.raw, {
      executionCtx,
      traceId,
      cacheOnly: Boolean(executionCtx),
    });
    if (resolution.kind === "warming") {
      return anthropicError(
        "api_error",
        "Authorization cache is warming. Retry shortly.",
        503,
      );
    }
    if (resolution.kind === "suspended") {
      return anthropicError(
        "permission_error",
        "Your account has been suspended due to policy violations.",
        403,
      );
    }
    if (resolution.kind === "rejected") {
      return anthropicError(
        resolution.status === 403 ? "permission_error" : "authentication_error",
        resolution.status === 403
          ? "Account or organization access is disabled."
          : "Authentication required.",
        resolution.status,
      );
    }
    if (resolution.kind === "authorized") {
      user = {
        id: resolution.ctx.userId,
        organization_id: resolution.ctx.orgId,
      };
      apiKey = resolution.ctx.apiKeyId ? { id: resolution.ctx.apiKeyId } : null;
      admissionSnapshot = resolution.ctx.admission;
      // The resolver already verified not-suspended (cache hit = at populate;
      // origin miss = just now), so the synchronous moderation read is skipped.
      moderationAlreadyChecked = true;
    } else {
      if (executionCtx) {
        return anthropicError(
          "authentication_error",
          "Authentication required.",
          401,
        );
      }
      const auth = await requireUserOrApiKeyWithOrg(c);
      user = { id: auth.id, organization_id: auth.organization_id };
      // Workers auth shim does not surface the apiKey row; attribution by
      // apiKey id requires a separate lookup.
      apiKey = await getRequestApiKeyId(c);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return anthropicError("authentication_error", message, 401);
  }
  const tAuth = performance.now();

  let orgRateLimited: Response | null;
  try {
    orgRateLimited = await enforceOrgRateLimit(
      user.organization_id,
      "completions",
      {
        cacheOnly: Boolean(executionCtx),
        executionCtx,
        config: inferenceRateLimitConfig(admissionSnapshot, "completions"),
      },
    );
  } catch (error) {
    // error-policy:J1 preserve the Anthropic error envelope while the
    // cache-only policy hydrates off path.
    if (error instanceof OrgRateLimitCacheNotReadyError) {
      return anthropicError(
        "api_error",
        "Rate-limit authorization cache is warming. Retry shortly.",
        503,
        { "Retry-After": "1" },
      );
    }
    throw error;
  }
  if (orgRateLimited) {
    const headers = new Headers(orgRateLimited.headers);
    headers.delete("Content-Type");
    headers.delete("Content-Length");
    if (orgRateLimited.status === 429) {
      return anthropicError(
        "rate_limit_error",
        "Organization rate limit exceeded.",
        429,
        headers,
      );
    }
    return anthropicError(
      "api_error",
      "Rate-limit authorization is unavailable. Retry shortly.",
      503,
      headers,
    );
  }

  const requestedAppId = c.req.header("X-App-Id");
  let appId: string | null = null;
  let useAppCredits = false;
  let monetizedApp: NonNullable<
    Awaited<ReturnType<typeof appsService.getById>>
  > | null = null;
  if (requestedAppId) {
    if (executionCtx) {
      const appResolution =
        await appsService.getAuthorizedMonetizedAppForUserCacheOnly(
          requestedAppId,
          user,
          { executionCtx },
        );
      if (appResolution.kind !== "ready") {
        return anthropicError(
          "api_error",
          "Application authorization cache is warming. Retry shortly.",
          503,
          { "Retry-After": "1" },
        );
      }
      monetizedApp = appResolution.app;
    } else {
      monetizedApp =
        (await appsService.getAuthorizedMonetizedAppForUser(
          requestedAppId,
          user,
        )) ?? null;
    }
    appId = monetizedApp?.id ?? null;
    useAppCredits = Boolean(monetizedApp?.monetization_enabled);
  }

  const decodedBody = await decodeRequestJson(c.req);
  if (!decodedBody.ok) {
    // error-policy:J3 malformed JSON is invalid request input.
    return anthropicError("invalid_request_error", "Invalid JSON body", 400);
  }
  const body = decodedBody.value;

  if (!body || typeof body !== "object") {
    return anthropicError("invalid_request_error", "Invalid JSON body", 400);
  }

  const request = body as AnthropicMessagesRequest;
  if (
    !request.model ||
    request.max_tokens == null ||
    !request.messages?.length
  ) {
    return anthropicError(
      "invalid_request_error",
      "Missing required fields: model, max_tokens, messages",
      400,
    );
  }

  const model = normalizeModelId(request.model);
  const provider = getProviderFromModel(model);
  const normalizedModel = normalizeModelName(model);
  const systemPrompt = normalizeSystemPrompt(request.system);

  let shouldBlockUser = false;
  if (!moderationAlreadyChecked) {
    if (executionCtx) {
      const moderationResolution =
        await contentModerationService.shouldBlockUserCacheOnly(user.id, {
          executionCtx,
        });
      if (moderationResolution.kind !== "ready") {
        return anthropicError(
          "api_error",
          "Moderation authorization cache is warming. Retry shortly.",
          503,
        );
      }
      shouldBlockUser = moderationResolution.blocked;
    } else {
      shouldBlockUser = await contentModerationService.shouldBlockUser(user.id);
    }
  }
  if (shouldBlockUser) {
    return anthropicError(
      "permission_error",
      "Your account has been suspended due to policy violations.",
      403,
    );
  }

  const lastUserMessage = request.messages
    .filter((message) => message.role === "user")
    .pop();
  if (lastUserMessage) {
    const content = getMessageContentForEstimate(lastUserMessage);
    if (content) {
      const moderationTask = contentModerationService.moderateInBackground(
        content,
        user.id,
        undefined,
        (result) => {
          logger.warn("[Messages API] Async moderation detected violation", {
            userId: user.id,
            categories: result.flaggedCategories,
          });
        },
      );
      executionCtx?.waitUntil(moderationTask);
    }
  }

  const estimateMessages: Array<{ content: string | undefined }> = [];
  if (systemPrompt) {
    estimateMessages.push({ content: systemPrompt });
  }
  for (const message of request.messages) {
    estimateMessages.push({ content: getMessageContentForEstimate(message) });
  }

  const estimatedInputTokens = estimateInputTokens(estimateMessages);
  // Reserve against the SAME ceiling the provider is capped at below, not the
  // raw request.max_tokens. `messagesEffectiveMaxTokens` raises a reasoning
  // model's provider budget to fit hidden reasoning PLUS the answer (e.g. a
  // requested 256 becomes the 4096 floor), so reserving the raw value lets the
  // provider bill well above the reservation — the #16081 invariant, fixed for
  // /v1/chat/completions but not here. The provider paths recompute the same
  // deterministic value, so admission and enforcement stay identical.
  const reservationCotBudget = resolveAnthropicThinkingBudgetTokens(
    model,
    process.env,
  );
  const estimatedOutputTokens =
    messagesEffectiveMaxTokens(
      request.max_tokens,
      reservationCotBudget,
      model,
    ) ?? request.max_tokens;
  const affiliateCode = c.req.header("X-Affiliate-Code") ?? null;
  const billingSource: PricingBillingSource =
    resolveAiProviderSource(model) ?? "bitrouter";
  // One server-generated identity spans admission, settlement, affiliate
  // earnings, and audit records. A client-controlled retry key is intentionally
  // kept separate because two delivered requests must produce two charges.
  const requestId = crypto.randomUUID();
  const tBeforeReserve = performance.now();

  if (useAppCredits && appId && monetizedApp) {
    // #10423: prefer the request-stable key (Idempotency-Key/X-Request-Id via
    // the bootstrap ALS) so a client retry of the SAME request dedupes the
    // creator-earnings legs; a fresh uuid per invocation would never match.
    const idempotencyKey = getRequestIdempotencyKey() ?? crypto.randomUUID();

    try {
      assertInferenceAppAffiliateSupported(appId, affiliateCode);
      const { totalCost } = await calculateCost(
        normalizedModel,
        provider,
        estimatedInputTokens,
        estimatedOutputTokens,
        billingSource,
        executionCtx ? { cacheOnly: true, executionCtx } : undefined,
      );
      const metadata = {
        model,
        provider,
        billingSource,
        estimatedInputTokens,
        estimatedOutputTokens,
        streaming: Boolean(request.stream),
      };
      if (executionCtx) {
        const admission = await admitAppInferenceCacheOnly({
          appId,
          app: monetizedApp,
          userId: user.id,
          organizationId: user.organization_id,
          estimatedBaseCostUsd: totalCost,
          description: `Messages API: ${model}`,
          idempotencyKey,
          metadata,
          requestId,
          model,
          provider,
          billingSource,
          affiliateCode,
          executionCtx,
          admissionSnapshot,
        });
        settleReservation = admission.settle;
        settleUnknownReservation = admission.settleUnknown;
        markProviderDispatched = admission.markProviderDispatched;
      } else {
        const reservation = await appCreditsService.reserveInferenceCredits({
          appId,
          userId: user.id,
          estimatedBaseCost: totalCost,
          description: `Messages API: ${model}`,
          idempotencyKey,
          metadata,
          app: monetizedApp,
        });
        const settle = createCreditReservationSettler(reservation);
        settleReservation = settle;
        settleUnknownReservation = () => settle(reservation.reservedAmount);
      }
    } catch (error) {
      if (error instanceof InferenceAppAffiliateUnsupportedError) {
        return anthropicError(
          "invalid_request_error",
          "App monetization and affiliate attribution cannot be combined.",
          400,
        );
      }
      if (error instanceof InsufficientCreditsError) {
        return anthropicError(
          "rate_limit_error",
          `Insufficient cloud credits. Required: $${error.required.toFixed(4)}`,
          429,
        );
      }
      if (
        error instanceof InferenceBalanceCacheWarmingError ||
        error instanceof AiPricingCacheWarmingError ||
        error instanceof AiPricingCacheUnavailableError
      ) {
        return anthropicError(
          "api_error",
          "Billing authorization is warming. Retry shortly.",
          503,
        );
      }

      throw error;
    }
  } else {
    try {
      const admission = await admitOrganizationInference({
        context: {
          organizationId: user.organization_id,
          userId: user.id,
          apiKeyId: apiKey?.id,
          model,
          provider,
          billingSource,
          affiliateCode,
          requestId,
        },
        estimatedInputTokens,
        estimatedOutputTokens,
        apiKeyId: apiKey?.id,
        affiliateCode,
        executionCtx,
        admissionSnapshot,
      });
      settleReservation = admission.settle;
      settleUnknownReservation = admission.settleUnknown;
      markProviderDispatched = admission.markProviderDispatched;
      billingReservation = admission.reservation;
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        return anthropicError(
          "rate_limit_error",
          `Insufficient credits. Required: $${error.required.toFixed(4)}`,
          429,
        );
      }
      if (error instanceof InferenceBalanceCacheWarmingError) {
        return anthropicError(
          "api_error",
          "Billing authorization is warming. Retry shortly.",
          503,
        );
      }

      throw error;
    }
  }

  if (!settleReservation || !settleUnknownReservation) {
    throw new Error(
      "[Messages API] inference admission did not return terminal settlers",
    );
  }
  const tAfterReserve = performance.now();

  // The outer AI SDK invocation is the last gateway-controlled boundary.
  // Model doGenerate/doStream dispatch occurs later inside the SDK and is not
  // represented as provider latency by this preforward snapshot.
  let gatewayHandoffAt: number | undefined;
  const gatewayHandoffTelemetry: GatewayHandoffTelemetry = {
    capture: () => {
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
      logger.info("[Messages API][preforward]", {
        traceId,
        model,
        authMs: preforwardTiming.authMs,
        midReadsMs: preforwardTiming.middleMs,
        reserveMs: preforwardTiming.reserveMs,
        setupMs: preforwardTiming.setupMs,
        totalMs: preforwardTiming.totalMs,
        stream: Boolean(request.stream),
      });
    },
  };

  try {
    // Payload conversion is throwable (convertTools rejects a malformed-but-
    // valid `tools` array); keep it inside the settle-refunding try so a
    // conversion throw refunds the reservation instead of stranding the debit
    // the caller was just charged (refund-gap class, #11795).
    const messages = anthropicMessagesToModelMessages(request.messages);
    const tools = convertTools(request.tools);
    const toolChoice = mapToolChoice(request.tool_choice);
    const safeParams = getSafeModelParams(model, {
      temperature: request.temperature,
      topP: request.top_p,
      topK: request.top_k,
      stopSequences: request.stop_sequences,
    });

    const preforwardResponse = request.stream
      ? await handleStream(
          model,
          systemPrompt,
          messages,
          request,
          user,
          apiKey,
          affiliateCode,
          startTime,
          estimatedInputTokens,
          safeParams,
          tools,
          toolChoice,
          c.req.raw.signal,
          routeTimeoutMs,
          settleReservation,
          settleUnknownReservation,
          billingReservation,
          billingSource,
          requestId,
          executionCtx,
          gatewayHandoffTelemetry,
          markProviderDispatched,
        )
      : await handleNonStream(
          model,
          systemPrompt,
          messages,
          request,
          user,
          apiKey,
          affiliateCode,
          startTime,
          safeParams,
          tools,
          toolChoice,
          c.req.raw.signal,
          routeTimeoutMs,
          settleReservation,
          settleUnknownReservation,
          billingReservation,
          billingSource,
          requestId,
          executionCtx,
          gatewayHandoffTelemetry,
          markProviderDispatched,
        );
    if (!preforwardTiming) {
      throw new Error("[Messages API] gateway handoff timing was not captured");
    }
    return attachPreforwardTelemetry(preforwardResponse);
  } catch (error) {
    await settleOffResponsePath(executionCtx, async () => {
      if (
        gatewayHandoffAt === undefined ||
        isProviderConfigurationError(error)
      ) {
        await settleReservation?.(0);
      } else {
        await settleUnknownReservation?.();
      }
    });
    const message = error instanceof Error ? error.message : String(error);
    // A provider-configuration failure (unknown model / unconfigured gateway)
    // carries internal setup guidance in its message — return a clean,
    // model-scoped 400 instead of leaking it as a 500 api_error (#13913 for the
    // sibling /v1/chat/completions boundary).
    if (isProviderConfigurationError(error)) {
      logger.error("[Messages API] Provider configuration error", {
        error: message,
      });
      return attachPreforwardTelemetry(
        anthropicError(
          "invalid_request_error",
          modelNotAvailableMessage(model),
          400,
        ),
      );
    }
    logger.error("[Messages API] Error", { traceId, error: message });
    return attachPreforwardTelemetry(anthropicError("api_error", message, 500));
  }
});

/**
 * Workers auth shim doesn't expose the validated apiKey row; repeat the
 * lookup so usage attribution stays in parity with the Next-era handler.
 */
async function getRequestApiKeyId(
  c: AppContext,
): Promise<{ id: string } | null> {
  const apiKeyHeader = c.req.header("X-API-Key") || c.req.header("x-api-key");
  const auth = c.req.header("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const elizaBearer = bearer?.startsWith("eliza_") ? bearer : null;
  const apiKey = apiKeyHeader || elizaBearer;
  if (!apiKey) return null;
  const { apiKeysService } = await import("@/lib/services/api-keys");
  const validated = await apiKeysService.validateApiKey(apiKey);
  return validated ? { id: validated.id } : null;
}

async function handleNonStream(
  model: string,
  systemPrompt: string | undefined,
  messages: ModelMessage[],
  request: AnthropicMessagesRequest,
  user: { id: string; organization_id: string },
  apiKey: { id: string } | null,
  affiliateCode: string | null,
  startTime: number,
  safeParams: ReturnType<typeof getSafeModelParams>,
  tools: ReturnType<typeof convertTools>,
  toolChoice:
    | "auto"
    | "none"
    | "required"
    | { type: "tool"; toolName: string }
    | undefined,
  abortSignal: AbortSignal | undefined,
  timeoutMs: number,
  settleReservation: (
    actualCost: number,
  ) => Promise<CreditReconciliationResult | null>,
  settleUnknownReservation: () => Promise<CreditReconciliationResult | null>,
  billingReservation: CreditReservation | undefined,
  billingSource: PricingBillingSource,
  // Stable per-request id → the getAffiliateEarningsSourceId dedupe key. Without
  // it billUsage falls back to legacy_<uuid> and a retry double-accrues cashable
  // affiliate earnings. Mirrors chat/completions (#11588).
  requestId: string,
  executionCtx: { waitUntil(promise: Promise<unknown>): void } | undefined,
  gatewayHandoffTelemetry?: GatewayHandoffTelemetry,
  markProviderDispatched?: () => Promise<void>,
) {
  const provider = getProviderFromModel(model);
  let providerInvocationStarted = false;

  const cotBudget = resolveAnthropicThinkingBudgetTokens(model, process.env);
  const cotOptions =
    cotBudget != null
      ? mergeAnthropicCotProviderOptions(model, process.env, cotBudget)
      : {};
  const effectiveMaxTokens = messagesEffectiveMaxTokens(
    request.max_tokens,
    cotBudget,
    model,
  );

  try {
    const languageModel = getLanguageModel(model);
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
      maxOutputTokens: effectiveMaxTokens,
      abortSignal,
      timeout: timeoutMs,
      ...safeParams,
      ...(tools ? { tools } : {}),
      ...(toolChoice ? { toolChoice } : {}),
      ...cotOptions,
    });
    // Token counts for the Anthropic-compatible response come straight from the
    // model's reported usage, so the entire billing/settlement chain below can
    // run off the response path without changing the bytes the client receives.
    const responseTokens = normalizeUsage(result.usage);

    // Bill using actual usage from the SDK response. Deferred via waitUntil so
    // the billUsage → settleReservation → analytics DB writes never block the
    // response (#15414, non-stream sibling). Same code, same amounts, same
    // reservation — only the timing moves. Mirrors chat/completions
    // handleNonStreamingRequest (#15412 / #8759); without an executionCtx
    // (tests, non-Worker callers) the chain runs inline exactly as before.
    await settleOffResponsePath(executionCtx, async () => {
      try {
        const billing = await billUsage(
          {
            organizationId: user.organization_id,
            userId: user.id,
            apiKeyId: apiKey?.id,
            model,
            provider,
            billingSource,
            affiliateCode,
            requestId,
          },
          result.usage,
          billingReservation,
        );
        await settleReservation(billing.totalCost);

        await recordUsageAnalytics(
          {
            organizationId: user.organization_id,
            userId: user.id,
            apiKeyId: apiKey?.id,
            model,
            provider,
            billingSource,
          },
          billing,
          { type: "chat", content: result.text },
        );

        logger.info("[Messages API] Non-streaming complete", {
          durationMs: Date.now() - startTime,
          inputTokens: billing.inputTokens,
          outputTokens: billing.outputTokens,
        });
      } catch (billingError) {
        // Provider usage exists, so a billing failure settles conservatively to
        // the admitted estimate. First-call-wins preserves an actual settlement
        // if billing completed before a later analytics failure.
        try {
          await settleUnknownReservation();
        } catch (settlementError) {
          logger.error(
            "[Messages API] failed to settle unknown cost after deferred billing failure",
            {
              requestId,
              organizationId: user.organization_id,
              error:
                settlementError instanceof Error
                  ? settlementError.message
                  : String(settlementError),
            },
          );
        }
        logger.error("[Messages API] deferred billing failed", {
          error:
            billingError instanceof Error
              ? billingError.message
              : String(billingError),
        });
      }
    });

    const responseContent: AnthropicResponseBlock[] = [];
    if (result.text) {
      responseContent.push({ type: "text", text: result.text });
    }

    if (result.toolCalls?.length) {
      for (const toolCall of result.toolCalls) {
        responseContent.push({
          type: "tool_use",
          id: toolCall.toolCallId,
          name: toolCall.toolName,
          input: toolCall.input as Record<string, unknown>,
        });
      }
    }

    if (responseContent.length === 0) {
      responseContent.push({ type: "text", text: "" });
    }

    const hasToolCalls = Boolean(result.toolCalls?.length);
    const stopReason = mapFinishReason(
      result.finishReason,
      result.rawFinishReason,
      hasToolCalls,
    );
    const stopSequence = resolveStopSequence(
      stopReason,
      result.rawFinishReason,
      request.stop_sequences,
    );

    return Response.json({
      id: `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      type: "message",
      role: "assistant",
      content: responseContent,
      model: request.model,
      stop_reason: stopReason,
      stop_sequence: stopSequence,
      usage: {
        input_tokens: responseTokens.inputTokens,
        output_tokens: responseTokens.outputTokens,
      },
    });
  } catch (error) {
    const settlement =
      !providerInvocationStarted ||
      isKnownPreDispatchProviderConfigurationError(error) ||
      isKnownUnacceptedProviderError(error)
        ? settleReservation(0)
        : // A transport failure, timeout, or provider 5xx after dispatch does
          // not prove that the provider performed no work.
          settleUnknownReservation();
    await settleOffResponsePath(executionCtx, async () => {
      await settlement;
    });
    throw error;
  }
}

/**
 * The abort-settlement helpers only read `usage` off the SDK's finished steps.
 * `StepResult` is invariant in its tools generic, so this structural view lets
 * the streamText callback's concrete `StepResult<convertedTools>[]` flow in
 * without a cast (`usage` itself does not depend on the tools generic).
 */
type FinishedStepUsageSource = {
  readonly usage: StepResult<ToolSet>["usage"];
};

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

/**
 * True when the SDK's finish usage carries at least one provider-reported
 * token count (an explicit zero counts as reported). Mirrors the
 * chat-completions `hasReportedUsageTokens` guard so a stream that finished
 * WITHOUT reporting usage is distinguishable from a legitimate zero-token
 * report and never settles delivered output at $0.
 */
function hasReportedFinishUsage(usage: unknown): boolean {
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

function summarizeFinishedStepUsage(
  steps: readonly FinishedStepUsageSource[],
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

/**
 * Settles a streaming reservation after a client abort to the cost of what was
 * actually delivered (prompt + streamed output) instead of refunding the whole
 * hold. Port of the /v1/chat/completions abort partial settlement
 * (#11455/#11472): the platform already paid the upstream provider for the
 * delivered tokens, so a `settleReservation(0)` full refund leaks that cost as
 * uncollected revenue.
 *
 * The SDK reports no exact usage on abort (no `finish` part arrives), so the
 * delivered output is billed from the accumulated text-delta text via
 * `estimateTokens`, floored by any finished-step usage the SDK did report —
 * the same best-available measure the chat completions route uses. If partial
 * billing itself fails, the conservative unknown-cost terminal charges the
 * admitted estimate. The settler remains first-call-wins, so a racing callback
 * cannot replace a known actual settlement.
 */
async function settleStreamingAbortReservation(params: {
  model: string;
  provider: string;
  user: { id: string; organization_id: string };
  apiKey: { id: string } | null;
  affiliateCode: string | null;
  billingSource: PricingBillingSource;
  requestId: string;
  estimatedInputTokens: number;
  deliveredText: string;
  steps: readonly FinishedStepUsageSource[];
  settleReservation: (
    actualCost: number,
  ) => Promise<CreditReconciliationResult | null>;
  settleUnknownReservation: () => Promise<CreditReconciliationResult | null>;
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
    const billing = await billUsage(
      {
        organizationId: params.user.organization_id,
        userId: params.user.id,
        apiKeyId: params.apiKey?.id,
        model: params.model,
        provider: params.provider,
        billingSource: params.billingSource,
        affiliateCode: params.affiliateCode,
        requestId: params.requestId,
      },
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

    await recordUsageAnalytics(
      {
        organizationId: params.user.organization_id,
        userId: params.user.id,
        apiKeyId: params.apiKey?.id,
        model: params.model,
        provider: params.provider,
        billingSource: params.billingSource,
      },
      billing,
      {
        type: "chat",
        isSuccessful: false,
        errorMessage: "client_aborted_stream",
        content: params.deliveredText,
      },
    );

    logger.info(
      "[Messages API] Stream aborted; reservation partially settled",
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
      "[Messages API] Stream abort partial settlement failed; settling admitted estimate",
      {
        model: params.model,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return await params.settleUnknownReservation();
  }
}

async function handleStream(
  model: string,
  systemPrompt: string | undefined,
  messages: ModelMessage[],
  request: AnthropicMessagesRequest,
  user: { id: string; organization_id: string },
  apiKey: { id: string } | null,
  affiliateCode: string | null,
  startTime: number,
  estimatedInputTokens: number,
  safeParams: ReturnType<typeof getSafeModelParams>,
  tools: ReturnType<typeof convertTools>,
  toolChoice:
    | "auto"
    | "none"
    | "required"
    | { type: "tool"; toolName: string }
    | undefined,
  abortSignal: AbortSignal | undefined,
  timeoutMs: number,
  settleReservation: (
    actualCost: number,
  ) => Promise<CreditReconciliationResult | null>,
  settleUnknownReservation: () => Promise<CreditReconciliationResult | null>,
  billingReservation: CreditReservation | undefined,
  billingSource: PricingBillingSource,
  // Stable per-request id → the getAffiliateEarningsSourceId dedupe key. Without
  // it billUsage falls back to legacy_<uuid> and a retry double-accrues cashable
  // affiliate earnings. Mirrors chat/completions (#11588).
  requestId: string,
  executionCtx?: { waitUntil(promise: Promise<unknown>): void },
  gatewayHandoffTelemetry?: GatewayHandoffTelemetry,
  markProviderDispatched?: () => Promise<void>,
) {
  const provider = getProviderFromModel(model);
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  let deliveredText = "";
  let providerOutputObserved = false;
  let streamingSettlementPromise: Promise<CreditReconciliationResult | null> | null =
    null;

  // Single-flights the terminal settlement across onFinish/onAbort/onError and
  // the stream-catch backstop. The settler itself is first-call-wins
  // idempotent, but the abort path bills usage + records analytics BEFORE
  // settling, so racing paths must share one settlement promise or an abort
  // could be billed/recorded twice. Mirrors /v1/chat/completions (#11472).
  const settleStreamingOnce = (
    factory: () => Promise<CreditReconciliationResult | null>,
  ): Promise<CreditReconciliationResult | null> => {
    if (!streamingSettlementPromise) {
      // Cache unconditionally — never reset on rejection. A racing settle path
      // must not re-run a failed settlement (it would re-bill/re-record the
      // abort). The inner reservation settler is first-call-wins idempotent and
      // retries its reconcile legs safely, so the awaiting caller still sees the
      // failure without a reset. Mirrors /v1/chat/completions (#11512).
      streamingSettlementPromise = factory();
    }
    return streamingSettlementPromise;
  };

  const refundStreamingReservationOnce = () =>
    settleStreamingOnce(async () => await settleReservation(0));
  const settleUnknownStreamingReservationOnce = () =>
    settleStreamingOnce(async () => await settleUnknownReservation());
  const settleStreamingProviderFailureOnce = (error: unknown) =>
    providerOutputObserved || !isKnownUnacceptedProviderError(error)
      ? settleUnknownStreamingReservationOnce()
      : refundStreamingReservationOnce();

  const settleStreamingAbortOnce = (
    steps: readonly FinishedStepUsageSource[],
  ) =>
    settleStreamingOnce(
      async () =>
        await settleStreamingAbortReservation({
          model,
          provider,
          user,
          apiKey,
          affiliateCode,
          billingSource,
          requestId,
          estimatedInputTokens,
          deliveredText,
          steps,
          settleReservation,
          settleUnknownReservation,
          billingReservation,
        }),
    );

  const cotBudget = resolveAnthropicThinkingBudgetTokens(model, process.env);
  const cotOptions =
    cotBudget != null
      ? mergeAnthropicCotProviderOptions(model, process.env, cotBudget)
      : {};
  const effectiveMaxTokens = messagesEffectiveMaxTokens(
    request.max_tokens,
    cotBudget,
    model,
  );

  const languageModel = getLanguageModel(model);
  const invokeStreamText = bindGatewayHandoffTelemetry(
    gatewayHandoffTelemetry,
    (options: Parameters<typeof streamText>[0]) => streamText(options),
  );
  await markProviderDispatched?.();
  const result = invokeStreamText({
    model: languageModel,
    system: systemPrompt,
    messages,
    maxOutputTokens: effectiveMaxTokens,
    abortSignal,
    timeout: timeoutMs,
    ...safeParams,
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    ...cotOptions,
    // Parity with chat/completions (#15412 / #8759): the settlement chain below
    // (billUsage → settleReservation → analytics) is serial cross-provider DB
    // round-trips, and the AI SDK awaits onFinish before it ends fullStream —
    // so awaiting the chain inline held the final SSE frames (message_delta +
    // message_stop) hostage for the full write latency (~8s measured on the
    // completions route, #15414 here). Nothing the client receives depends on
    // these writes (the terminal usage frame is built from the stream's own
    // finish part), so defer them via waitUntil. settleStreamingOnce is still
    // invoked synchronously — the settlement promise is cached before onFinish
    // returns, so the idempotent first-call-wins guarantee against a racing
    // onAbort/onError is unchanged — and without an executionCtx (tests,
    // non-Worker callers) the chain is awaited inline exactly as before.
    onFinish: async ({ text, totalUsage }) => {
      const settlement = settleStreamingOnce(async () => {
        // A finished stream whose provider reported NO usage cannot prove its
        // cost — billing the empty record would settle delivered output at $0,
        // reading "not reported" as "free". Retain the admitted estimate
        // instead (mirrors /v1/chat's falsy-usage guard). An explicit all-zero
        // usage report still bills normally below, and provably-rejected work
        // still reaches zero through onError/the stream backstop, which win
        // this first-call-wins settler.
        if (!hasReportedFinishUsage(totalUsage)) {
          const reconciliation = await settleUnknownReservation();
          logger.error(
            "[Messages API] Stream finished without reported usage; settled admitted estimate",
            { model },
          );
          return reconciliation;
        }
        try {
          const billing = await billUsage(
            {
              organizationId: user.organization_id,
              userId: user.id,
              apiKeyId: apiKey?.id,
              model,
              provider,
              billingSource,
              affiliateCode,
              requestId,
            },
            totalUsage,
            billingReservation,
          );
          const reconciliation = await settleReservation(billing.totalCost);

          await recordUsageAnalytics(
            {
              organizationId: user.organization_id,
              userId: user.id,
              apiKeyId: apiKey?.id,
              model,
              provider,
              billingSource,
            },
            billing,
            { type: "chat", content: text },
          );

          logger.info("[Messages API] Streaming complete", {
            durationMs: Date.now() - startTime,
            inputTokens: billing.inputTokens,
            outputTokens: billing.outputTokens,
          });

          return reconciliation;
        } catch (error) {
          const reconciliation = await settleUnknownReservation();
          logger.error("[Messages API] onFinish billing error", {
            error: error instanceof Error ? error.message : String(error),
          });
          return reconciliation;
        }
      });
      await settleOffResponsePath(executionCtx, async () => {
        await settlement;
      });
    },
    // A client abort mid-stream must NOT release the whole hold: the upstream
    // provider was already paid for the prompt + every token delivered before
    // the disconnect. Settle to that partial cost instead (#11513); provider
    // errors below still refund in full.
    onAbort: async ({ steps }) => {
      const settlement = settleStreamingAbortOnce(steps);
      await settleOffResponsePath(executionCtx, async () => {
        await settlement;
      });
      logger.info("[Messages API] Stream aborted before completion", {
        model,
        estimatedInputTokens,
        deliveredOutputTokens: estimateTokens(deliveredText),
      });
    },
    // A pre-output provider rejection is known-zero. Once text was delivered,
    // exact usage is unavailable and the admitted estimate is retained instead.
    // Settlement remains single-flighted across the stream backstop below.
    onError: async ({ error }: { error: unknown }) => {
      const settlement = settleStreamingProviderFailureOnce(error);
      await settleOffResponsePath(executionCtx, async () => {
        await settlement;
      });
      logger.error(
        "[Messages API] Stream provider error — reservation settled",
        {
          model,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    },
  });

  const encoder = new TextEncoder();

  function sse(event: string, data: Record<string, unknown>): Uint8Array {
    return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  const stream = new ReadableStream({
    async start(controller) {
      const blockState = new Map<
        string,
        {
          index: number;
          type: "text" | "tool";
          sawInputDelta: boolean;
          stopped: boolean;
        }
      >();
      let nextIndex = 0;
      let sawToolCalls = false;
      let finishReason = "stop";
      let rawFinishReason: string | undefined;
      let totalUsage:
        | { inputTokens?: number; outputTokens?: number; totalTokens?: number }
        | undefined;

      const ensureTextBlock = (id: string) => {
        const existing = blockState.get(id);
        if (existing) return existing.index;

        const index = nextIndex++;
        blockState.set(id, {
          index,
          type: "text",
          sawInputDelta: false,
          stopped: false,
        });
        controller.enqueue(
          sse("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
          }),
        );
        return index;
      };

      const ensureToolBlock = (id: string, toolName: string) => {
        const existing = blockState.get(id);
        if (existing) return existing.index;

        const index = nextIndex++;
        blockState.set(id, {
          index,
          type: "tool",
          sawInputDelta: false,
          stopped: false,
        });
        controller.enqueue(
          sse("content_block_start", {
            type: "content_block_start",
            index,
            content_block: {
              type: "tool_use",
              id,
              name: toolName,
              input: {},
            },
          }),
        );
        return index;
      };

      const stopBlock = (id: string) => {
        const state = blockState.get(id);
        if (!state || state.stopped) return;

        controller.enqueue(
          sse("content_block_stop", {
            type: "content_block_stop",
            index: state.index,
          }),
        );
        state.stopped = true;
      };

      try {
        controller.enqueue(
          sse("message_start", {
            type: "message_start",
            message: {
              id: messageId,
              type: "message",
              role: "assistant",
              content: [],
              model: request.model,
              stop_reason: null,
              stop_sequence: null,
              usage: {
                input_tokens: estimatedInputTokens,
                output_tokens: 0,
              },
            },
          }),
        );

        controller.enqueue(sse("ping", { type: "ping" }));

        for await (const part of result.fullStream) {
          switch (part.type) {
            case "text-start": {
              ensureTextBlock(part.id);
              break;
            }

            case "text-delta": {
              const index = ensureTextBlock(part.id);
              if (part.text.length > 0) providerOutputObserved = true;
              controller.enqueue(
                sse("content_block_delta", {
                  type: "content_block_delta",
                  index,
                  delta: { type: "text_delta", text: part.text },
                }),
              );
              deliveredText += part.text;
              break;
            }

            case "text-end": {
              stopBlock(part.id);
              break;
            }

            case "tool-input-start": {
              providerOutputObserved = true;
              sawToolCalls = true;
              ensureToolBlock(part.id, part.toolName);
              break;
            }

            case "tool-input-delta": {
              providerOutputObserved = true;
              const state = blockState.get(part.id);
              if (state) {
                state.sawInputDelta = true;
                controller.enqueue(
                  sse("content_block_delta", {
                    type: "content_block_delta",
                    index: state.index,
                    delta: {
                      type: "input_json_delta",
                      partial_json: part.delta,
                    },
                  }),
                );
              }
              break;
            }

            case "tool-input-end": {
              stopBlock(part.id);
              break;
            }

            case "tool-call": {
              providerOutputObserved = true;
              sawToolCalls = true;
              const index = ensureToolBlock(part.toolCallId, part.toolName);
              const state = blockState.get(part.toolCallId);

              if (state && !state.sawInputDelta) {
                controller.enqueue(
                  sse("content_block_delta", {
                    type: "content_block_delta",
                    index,
                    delta: {
                      type: "input_json_delta",
                      partial_json: JSON.stringify(part.input ?? {}),
                    },
                  }),
                );
                state.sawInputDelta = true;
              }

              stopBlock(part.toolCallId);
              break;
            }

            case "finish": {
              finishReason = part.finishReason;
              rawFinishReason = part.rawFinishReason;
              totalUsage = part.totalUsage;
              break;
            }

            case "error": {
              throw part.error;
            }
          }
        }

        for (const [id, state] of blockState.entries()) {
          if (!state.stopped) {
            stopBlock(id);
          }
        }

        const stopReason = mapFinishReason(
          finishReason,
          rawFinishReason,
          sawToolCalls,
        );
        const stopSequence = resolveStopSequence(
          stopReason,
          rawFinishReason,
          request.stop_sequences,
        );

        controller.enqueue(
          sse("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: stopSequence },
            usage: {
              output_tokens: totalUsage?.outputTokens ?? 0,
            },
          }),
        );

        controller.enqueue(sse("message_stop", { type: "message_stop" }));
      } catch (error) {
        // Backstop: this catch can run even when the AI SDK never invokes (or
        // doesn't await) onError — e.g. a fullStream `error` part re-thrown here,
        // or a controller.enqueue throw on client disconnect racing ahead of
        // onAbort. Settle the reservation here too so the upfront hold is never
        // leaked (a permanent overcharge). When the request signal is aborted
        // this is the client-abort path, so settle to the delivered partial
        // cost (#11513) instead of refunding the full hold. A provider failure
        // before output is known-zero; after output it retains the admitted
        // estimate because exact terminal usage is unavailable. Settlement is
        // single-flighted, so this cannot double-bill if onAbort/onError already
        // won the race. Mirrors the
        // /v1/chat/completions backstop.
        const streamAborted = abortSignal?.aborted === true;
        const settlement = streamAborted
          ? settleStreamingAbortOnce([])
          : settleStreamingProviderFailureOnce(error);
        await settleOffResponsePath(executionCtx, async () => {
          await settlement;
        });
        const message = error instanceof Error ? error.message : String(error);
        // Same provider-configuration redaction as the non-streaming path: a
        // GatewayError's internal setup guidance must not reach the caller in
        // the terminal SSE error event (#13913).
        let terminalEvent: Record<string, unknown>;
        if (isProviderConfigurationError(error)) {
          logger.error("[Messages API] Stream provider configuration error", {
            error: message,
          });
          terminalEvent = {
            type: "error",
            error: {
              type: "invalid_request_error",
              message: modelNotAvailableMessage(model),
            },
          };
        } else {
          logger.error("[Messages API] Stream error", { error: message });
          terminalEvent = {
            type: "error",
            error: { type: "api_error", message },
          };
        }
        try {
          controller.enqueue(sse("error", terminalEvent));
        } catch (enqueueError) {
          // The stream was already torn down (client disconnected / controller
          // closed) — fall back to erroring it so the runtime cleans up.
          // Mirrors the /v1/chat/completions terminal-chunk guard; settlement
          // above has already run either way.
          logger.error(
            "[Messages API] Failed to emit terminal stream error event",
            {
              error:
                enqueueError instanceof Error
                  ? enqueueError.message
                  : String(enqueueError),
            },
          );
          controller.error(error);
        }
      } finally {
        try {
          controller.close();
        } catch {
          // error-policy:J6 best-effort teardown — the controller is already
          // closed or errored when the terminal-chunk guard above fired.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}

/**
 * Test-only seam for the streaming credit-settlement behavior (the abort
 * money-leak repro in `__tests__/messages-abort-partial-settle.test.ts`).
 * Exposes the internal streaming handler so a test can drive it with a mocked
 * `streamText` and a REAL credit-reservation settler, then assert an aborted
 * stream settles to the delivered partial cost instead of a full refund.
 * The `__` prefix + `TestHooks` suffix mark it as non-public. Mirrors
 * `__streamingCreditTestHooks` in ../chat/completions/route.ts.
 */
export const __messagesStreamingCreditTestHooks = {
  handleStream,
  handleNonStream,
} as const;

export default app;
