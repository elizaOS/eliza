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
  recordUsageAnalytics,
  reserveCredits,
} from "@/lib/services/ai-billing";
import type { PricingBillingSource } from "@/lib/services/ai-pricing-definitions";
import { appCreditsService } from "@/lib/services/app-credits";
import { appsService } from "@/lib/services/apps";
import { contentModerationService } from "@/lib/services/content-moderation";
import type {
  CreditReconciliationResult,
  CreditReservation,
} from "@/lib/services/credits";
import { resolveInferenceAuthContext } from "@/lib/services/inference-auth-context";
import { createCreditReservationSettler } from "@/lib/utils/credit-reservation";
import { logger } from "@/lib/utils/logger";
import { getRouteTimeoutMs } from "@/lib/utils/request-timeout";
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
): Response {
  return Response.json(
    { type: "error", error: { type, message } },
    { status: status as 400 },
  );
}

/**
 * Client-facing message for an unresolvable model. Mirrors the
 * /v1/chat/completions boundary (#13913): when `getLanguageModel` /
 * the gateway raises a provider-configuration error (e.g. an unknown model on a
 * deployment where only `AI_GATEWAY_API_KEY` is set, whose GatewayError message
 * embeds internal setup guidance), the caller must see a clean, model-scoped
 * error — never the internal provider/gateway config detail.
 */
function modelNotAvailableMessage(model: string): string {
  return `model '${model}' is not available on this deployment`;
}

const app = new Hono<AppEnv>();
app.use("*", rateLimit(RateLimitPresets.RELAXED));

app.post("/", async (c) => {
  const startTime = Date.now();
  const routeTimeoutMs = getRouteTimeoutMs(ROUTE_MAX_DURATION);
  let settleReservation:
    | ((actualCost: number) => Promise<CreditReconciliationResult | null>)
    | null = null;

  let user: { id: string; organization_id: string };
  let apiKey: { id: string } | null = null;
  // #9899 fast-path: collapse auth + org + suspension into ONE KV read for the
  // API-key inference path (this is the eliza-code / anthropic-proxy route, which
  // previously did serial auth + a separate apiKeyId lookup + an uncached
  // moderation Postgres read = ~2.5x slower than /v1/chat/completions). Mirrors
  // that route's resolver; falls to the authoritative serial path for
  // JWT/cookie/wallet creds or a cold cache.
  let moderationAlreadyChecked = false;
  try {
    const resolution = await resolveInferenceAuthContext(c.req.raw);
    if (resolution.kind === "suspended") {
      return anthropicError(
        "permission_error",
        "Your account has been suspended due to policy violations.",
        403,
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

  const requestedAppId = c.req.header("X-App-Id");
  let appId: string | null = null;
  let useAppCredits = false;
  let monetizedApp: NonNullable<
    Awaited<ReturnType<typeof appsService.getById>>
  > | null = null;
  if (requestedAppId) {
    monetizedApp =
      (await appsService.getAuthorizedMonetizedAppForUser(
        requestedAppId,
        user,
      )) ?? null;
    appId = monetizedApp?.id ?? null;
    useAppCredits = Boolean(monetizedApp?.monetization_enabled);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return anthropicError("invalid_request_error", "Invalid JSON body", 400);
  }

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

  if (
    !moderationAlreadyChecked &&
    (await contentModerationService.shouldBlockUser(user.id))
  ) {
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
      contentModerationService.moderateInBackground(
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
  const estimatedOutputTokens = request.max_tokens;
  const affiliateCode = c.req.header("X-Affiliate-Code") ?? null;
  const billingSource: PricingBillingSource =
    resolveAiProviderSource(model) ?? "bitrouter";

  let reservation: CreditReservation;

  if (useAppCredits && appId && monetizedApp) {
    const { totalCost } = await calculateCost(
      normalizedModel,
      provider,
      estimatedInputTokens,
      estimatedOutputTokens,
      billingSource,
    );
    // #10423: prefer the request-stable key (Idempotency-Key/X-Request-Id via
    // the bootstrap ALS) so a client retry of the SAME request dedupes the
    // creator-earnings legs; a fresh uuid per invocation would never match.
    const idempotencyKey = getRequestIdempotencyKey() ?? crypto.randomUUID();

    try {
      reservation = await appCreditsService.reserveInferenceCredits({
        appId,
        userId: user.id,
        estimatedBaseCost: totalCost,
        description: `Messages API: ${model}`,
        idempotencyKey,
        metadata: {
          model,
          provider,
          billingSource,
          estimatedInputTokens,
          estimatedOutputTokens,
          streaming: Boolean(request.stream),
        },
        app: monetizedApp,
      });
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        return anthropicError(
          "rate_limit_error",
          `Insufficient cloud credits. Required: $${error.required.toFixed(4)}`,
          429,
        );
      }

      throw error;
    }
  } else {
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
        return anthropicError(
          "rate_limit_error",
          `Insufficient credits. Required: $${error.required.toFixed(4)}`,
          429,
        );
      }

      throw error;
    }
  }

  settleReservation = createCreditReservationSettler(reservation);

  try {
    // Payload conversion is throwable (convertTools rejects a malformed-but-
    // valid `tools` array); keep it inside the settle-refunding try so a
    // conversion throw refunds the reservation instead of stranding the debit
    // the caller was just charged (refund-gap class, #11795).
    // #11588: the billing requestId feeds the affiliate-earnings dedupe
    // sourceId (getAffiliateEarningsSourceId → `ai_billing:<op>:<requestId>`,
    // deduped on addEarnings) while the org charge is unconditional. It MUST
    // NOT be client-controllable, or a caller pinning `x-request-id`/an
    // idempotency key across two real billed requests could suppress the
    // second affiliate/creator credit while still paying the org charge
    // (mirrors chat/completions). Server-generate it once per request — it
    // stays stable across this request's stream-finish/abort/non-stream
    // settle contexts, so the single-flight billing dedupe is preserved. The
    // client retry key remains ONLY the reservation idempotencyKey (#10423).
    // Threaded into handleStream / handleNonStream.
    const requestId = crypto.randomUUID();
    const messages = anthropicMessagesToModelMessages(request.messages);
    const tools = convertTools(request.tools);
    const toolChoice = mapToolChoice(request.tool_choice);
    const safeParams = getSafeModelParams(model, {
      temperature: request.temperature,
      topP: request.top_p,
      topK: request.top_k,
      stopSequences: request.stop_sequences,
    });

    if (request.stream) {
      return await handleStream(
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
        billingSource,
        requestId,
      );
    }

    return await handleNonStream(
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
      billingSource,
      requestId,
    );
  } catch (error) {
    await settleReservation?.(0);
    const message = error instanceof Error ? error.message : String(error);
    // A provider-configuration failure (unknown model / unconfigured gateway)
    // carries internal setup guidance in its message — return a clean,
    // model-scoped 400 instead of leaking it as a 500 api_error (#13913 for the
    // sibling /v1/chat/completions boundary).
    if (isProviderConfigurationError(error)) {
      logger.error("[Messages API] Provider configuration error", {
        error: message,
      });
      return anthropicError(
        "invalid_request_error",
        modelNotAvailableMessage(model),
        400,
      );
    }
    logger.error("[Messages API] Error", { error: message });
    return anthropicError("api_error", message, 500);
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
  billingSource: PricingBillingSource,
  // Stable per-request id → the getAffiliateEarningsSourceId dedupe key. Without
  // it billUsage falls back to legacy_<uuid> and a retry double-accrues cashable
  // affiliate earnings. Mirrors chat/completions (#11588).
  requestId: string,
) {
  const provider = getProviderFromModel(model);

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
    const result = await generateText({
      model: getLanguageModel(model),
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
        input_tokens: billing.inputTokens,
        output_tokens: billing.outputTokens,
      },
    });
  } catch (error) {
    await settleReservation(0);
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
 * the same best-available measure the chat completions route uses. Falls back
 * to a full refund only when the partial billing itself fails (the settler is
 * first-call-wins idempotent, so that fallback can never double-refund).
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
      "[Messages API] Stream abort partial settlement failed; refunding reservation",
      {
        model: params.model,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return await params.settleReservation(0);
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
  billingSource: PricingBillingSource,
  // Stable per-request id → the getAffiliateEarningsSourceId dedupe key. Without
  // it billUsage falls back to legacy_<uuid> and a retry double-accrues cashable
  // affiliate earnings. Mirrors chat/completions (#11588).
  requestId: string,
) {
  const provider = getProviderFromModel(model);
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  let deliveredText = "";
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

  const result = streamText({
    model: getLanguageModel(model),
    system: systemPrompt,
    messages,
    maxOutputTokens: effectiveMaxTokens,
    abortSignal,
    timeout: timeoutMs,
    ...safeParams,
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    ...cotOptions,
    onFinish: async ({ text, totalUsage }) => {
      await settleStreamingOnce(async () => {
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
          const reconciliation = await settleReservation(0);
          logger.error("[Messages API] onFinish billing error", {
            error: error instanceof Error ? error.message : String(error),
          });
          return reconciliation;
        }
      });
    },
    // A client abort mid-stream must NOT release the whole hold: the upstream
    // provider was already paid for the prompt + every token delivered before
    // the disconnect. Settle to that partial cost instead (#11513); provider
    // errors below still refund in full.
    onAbort: async ({ steps }) => {
      await settleStreamingAbortOnce(steps);
      logger.info("[Messages API] Stream aborted before completion", {
        model,
        estimatedInputTokens,
        deliveredOutputTokens: estimateTokens(deliveredText),
      });
    },
    // A provider error during streaming (e.g. cerebras 429/5xx) fires onError —
    // NOT onFinish or onAbort. Without this the upfront credit reservation is
    // never reconciled and the user is billed for zero output. Mirrors the
    // non-streaming error path's settleReservation(0); the settlement is
    // single-flighted (and the settler idempotent) so this cannot double-refund.
    onError: async ({ error }: { error: unknown }) => {
      await refundStreamingReservationOnce();
      logger.error(
        "[Messages API] Stream provider error — reservation refunded",
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
              sawToolCalls = true;
              ensureToolBlock(part.id, part.toolName);
              break;
            }

            case "tool-input-delta": {
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
        // cost (#11513) instead of refunding the full hold; otherwise it is a
        // provider failure and the hold is released to 0. Settlement is
        // single-flighted, so this cannot double-bill or double-refund if
        // onAbort/onError already won the race. Mirrors the
        // /v1/chat/completions backstop.
        const streamAborted = abortSignal?.aborted === true;
        if (streamAborted) {
          await settleStreamingAbortOnce([]);
        } else {
          await refundStreamingReservationOnce();
        }
        const message = error instanceof Error ? error.message : String(error);
        // Same provider-configuration redaction as the non-streaming path: a
        // GatewayError's internal setup guidance must not reach the caller in
        // the terminal SSE error event (#13913).
        if (isProviderConfigurationError(error)) {
          logger.error("[Messages API] Stream provider configuration error", {
            error: message,
          });
          controller.enqueue(
            sse("error", {
              type: "error",
              error: {
                type: "invalid_request_error",
                message: modelNotAvailableMessage(model),
              },
            }),
          );
        } else {
          logger.error("[Messages API] Stream error", { error: message });
          controller.enqueue(
            sse("error", {
              type: "error",
              error: { type: "api_error", message },
            }),
          );
        }
      } finally {
        controller.close();
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
} as const;

export default app;
