/**
 * Streams the dashboard chat protocol for organization and anonymous callers.
 *
 * Worker requests authorize, moderate, and admit exclusively from cache-backed
 * state before provider dispatch. Billing, analytics, conversation writes, and
 * anonymous counter mirrors run under `waitUntil`.
 */

import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { Hono } from "hono";
import type { AnonymousSession } from "@/db/repositories/anonymous-sessions";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { getCurrentUser } from "@/lib/auth/workers-hono-auth";
import {
  getAnonymousUser,
  reserveAnonymousMessageSlot,
} from "@/lib/auth-anonymous";
import {
  enforceOrgRateLimit,
  OrgRateLimitCacheNotReadyError,
} from "@/lib/middleware/rate-limit";
import { resolveModel } from "@/lib/models";
import { estimateTokens } from "@/lib/pricing";
import {
  mergeAnthropicCotProviderOptions,
  resolveAnthropicThinkingBudgetTokens,
} from "@/lib/providers/anthropic-thinking";
import {
  getAiProviderConfigurationError,
  getLanguageModel,
  hasLanguageModelProviderConfigured,
  isProviderConfigurationError,
  resolveAiProviderSource,
} from "@/lib/providers/language-model";
import { billUsage } from "@/lib/services/ai-billing";
import {
  AiPricingCacheUnavailableError,
  AiPricingCacheWarmingError,
} from "@/lib/services/ai-pricing/cache";
import {
  type AnonymousChatGateCredential,
  type AnonymousChatGateLease,
  commitAnonymousChatSlot,
  markAnonymousChatSlotDispatched,
  refreshAnonymousChatModeration,
  refundAnonymousChatSlot,
  reserveAnonymousChatSlot,
  resolveAnonymousChatContext,
} from "@/lib/services/anonymous-chat-admission";
import { anonymousSessionsService } from "@/lib/services/anonymous-sessions";
import { contentModerationService } from "@/lib/services/content-moderation";
import { conversationsService } from "@/lib/services/conversations";
import {
  type CreditReconciliationResult,
  type CreditReservation,
  creditsService,
  DEFAULT_OUTPUT_TOKENS,
  InsufficientCreditsError,
} from "@/lib/services/credits";
import { generationsService } from "@/lib/services/generations";
import { inferenceRateLimitConfig } from "@/lib/services/inference-admission-snapshot";
import type { InferenceAdmissionSnapshot } from "@/lib/services/inference-auth-cache";
import { resolveInferenceAuthContext } from "@/lib/services/inference-auth-context";
import { InferenceBalanceCacheWarmingError } from "@/lib/services/inference-billing-fast-path";
import { isKnownUnacceptedProviderError } from "@/lib/services/inference-provider-outcome";
import { admitOrganizationInference } from "@/lib/services/organization-inference-admission";
import { usageService } from "@/lib/services/usage";
import { createCreditReservationSettler } from "@/lib/utils/credit-reservation";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import { logger } from "@/lib/utils/logger";
import { getRouteTimeoutMs } from "@/lib/utils/request-timeout";
import { settleOffResponsePath } from "@/lib/utils/settle-off-response-path";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const ROUTE_MAX_DURATION = 800;
const DEFAULT_MIN_OUTPUT_TOKENS = 4096;
const VALID_MESSAGE_ROLES = ["user", "assistant", "system", "tool"] as const;

type ValidRole = (typeof VALID_MESSAGE_ROLES)[number];
type ChatBillingUser = {
  id: string;
  organization_id?: string | null;
};
type ApiKeyIdentity = { id: string };
type ExecutionContextLike = {
  waitUntil(promise: Promise<unknown>): void;
};

function isValidRole(role: string): role is ValidRole {
  return VALID_MESSAGE_ROLES.includes(role as ValidRole);
}

function normalizeMessages(
  messages: Array<{
    role: string;
    content?: string | string[];
    parts?: Array<{ type: string; text?: string }>;
  }>,
): UIMessage[] {
  return messages.map((message, index) => {
    if (!isValidRole(message.role)) {
      throw new Error(
        `Invalid message role "${message.role}" at index ${index}. Valid roles: ${VALID_MESSAGE_ROLES.join(", ")}`,
      );
    }
    if (message.parts && Array.isArray(message.parts)) {
      return message as UIMessage;
    }
    const content =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.join("")
          : "";
    return {
      role: message.role,
      parts: [{ type: "text" as const, text: content }],
    } as UIMessage;
  });
}

function extractTextFromParts(
  parts: Array<{ type: string; text?: string }>,
): string {
  return parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function getMessageText(message: UIMessage | { content?: string }): string {
  if ("parts" in message && Array.isArray(message.parts)) {
    return extractTextFromParts(message.parts);
  }
  if ("content" in message && typeof message.content === "string") {
    return message.content;
  }
  return "";
}

async function getRequestApiKey(
  c: AppContext,
): Promise<ApiKeyIdentity | undefined> {
  const apiKeyHeader = c.req.header("X-API-Key") || c.req.header("x-api-key");
  const authorization = c.req.header("authorization");
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : null;
  const elizaBearer = bearer?.startsWith("eliza_") ? bearer : null;
  const apiKey = apiKeyHeader || elizaBearer;
  if (!apiKey) return undefined;
  const { apiKeysService } = await import("@/lib/services/api-keys");
  const validated = await apiKeysService.validateApiKey(apiKey);
  return validated ? { id: validated.id } : undefined;
}

function retryableWarmingResponse(c: AppContext, area: string): Response {
  return c.json(
    { error: `${area} authorization is warming. Retry shortly.` },
    503,
    { "Retry-After": "1" },
  );
}

type AnonymousLimitResponse =
  | {
      reason: "message_limit";
      remaining: number;
      limit: number;
    }
  | {
      reason: "hourly_limit";
      remaining: number;
      limit: number;
      retryAfter: number;
    };

function anonymousLimitResponse(
  c: AppContext,
  limitResult: AnonymousLimitResponse,
): Response {
  const error =
    limitResult.reason === "message_limit"
      ? `You've reached your free message limit (${limitResult.limit} messages). Sign up to continue chatting!`
      : "You've reached the hourly rate limit. Please wait an hour or sign up for unlimited access.";
  const body = {
    error,
    requiresSignup: true,
    reason: limitResult.reason,
    limit: limitResult.limit,
    remaining: limitResult.remaining,
  };
  if (limitResult.reason === "hourly_limit") {
    return c.json(body, 429, {
      "Retry-After": String(limitResult.retryAfter),
    });
  }
  return c.json(body, 429);
}

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  let executionCtx: ExecutionContextLike | undefined;
  try {
    const candidate = c.executionCtx;
    executionCtx =
      typeof candidate?.waitUntil === "function" ? candidate : undefined;
  } catch {
    // error-policy:J4 Hono intentionally throws outside Workers; local tools
    // retain compatibility, while enabled Worker admission fails closed below.
    executionCtx = undefined;
  }
  if (!executionCtx && c.env?.INFERENCE_DEFERRED_ADMISSION === "true") {
    logger.error(
      "chat-api",
      "Worker execution context is unavailable for cache-only inference",
    );
    return retryableWarmingResponse(c, "Inference");
  }

  let settleReservation:
    | ((actualCost: number) => Promise<CreditReconciliationResult | null>)
    | null = null;
  let settleUnknownReservation:
    | (() => Promise<CreditReconciliationResult | null>)
    | null = null;
  let markProviderDispatched: (() => Promise<void>) | undefined;
  let billingReservation: CreditReservation | undefined;
  let refundAnonymousMessageSlot: (() => Promise<void>) | null = null;
  let commitAnonymousMessageSlot: (() => Promise<void>) | null = null;
  let markAnonymousMessageSlotDispatched: (() => Promise<void>) | null = null;
  let providerDispatchStarted = false;

  try {
    let user: ChatBillingUser;
    let apiKey: ApiKeyIdentity | undefined;
    let isAnonymous = false;
    let anonymousSession: Pick<
      AnonymousSession,
      "id" | "session_token" | "message_count" | "messages_limit"
    > | null = null;
    let anonymousCredential: AnonymousChatGateCredential | null = null;
    let moderationAlreadyChecked = false;
    let admissionSnapshot: InferenceAdmissionSnapshot | undefined;

    if (executionCtx) {
      const authResolution = await resolveInferenceAuthContext(c.req.raw, {
        executionCtx,
        cacheOnly: true,
      });
      if (authResolution.kind === "warming") {
        return retryableWarmingResponse(c, "Authentication");
      }
      if (authResolution.kind === "suspended") {
        return c.json(
          {
            error:
              "Your account has been suspended due to policy violations. Please contact support.",
          },
          403,
        );
      }
      if (authResolution.kind === "rejected") {
        return c.json(
          {
            error:
              authResolution.status === 403
                ? "Account or organization access is disabled."
                : "Authentication required",
          },
          authResolution.status,
        );
      }
      if (authResolution.kind === "authorized") {
        user = {
          id: authResolution.ctx.userId,
          organization_id: authResolution.ctx.orgId,
        };
        apiKey = authResolution.ctx.apiKeyId
          ? { id: authResolution.ctx.apiKeyId }
          : undefined;
        moderationAlreadyChecked = true;
        admissionSnapshot = authResolution.ctx.admission;
      } else {
        const anonymousResolution = await resolveAnonymousChatContext(
          c.req.raw,
          executionCtx,
        );
        if (anonymousResolution.kind === "missing") {
          return c.json({ error: "Authentication required" }, 401);
        }
        if (anonymousResolution.kind === "warming") {
          return retryableWarmingResponse(c, "Anonymous session");
        }
        if (anonymousResolution.kind === "rejected") {
          return c.json(
            { error: "Anonymous session is no longer active" },
            401,
          );
        }
        if (anonymousResolution.kind === "unavailable") {
          return retryableWarmingResponse(c, "Anonymous session");
        }
        if (anonymousResolution.blocked) {
          return c.json(
            {
              error:
                "Your account has been suspended due to policy violations. Please contact support.",
            },
            403,
          );
        }
        anonymousCredential = anonymousResolution.credential;
        user = {
          id: anonymousCredential.context.userId,
          organization_id: null,
        };
        anonymousSession = {
          id: anonymousCredential.context.sessionId,
          session_token: "",
          message_count: anonymousCredential.context.messageCount,
          messages_limit: anonymousCredential.context.messagesLimit,
        };
        isAnonymous = true;
        moderationAlreadyChecked = true;
      }
    } else {
      const authedUser = await getCurrentUser(c);
      if (authedUser) {
        user = authedUser;
        apiKey = await getRequestApiKey(c);
        if (!user.organization_id) {
          return c.json(
            { error: "No organization associated with this account" },
            403,
          );
        }
      } else {
        const anonymousData = await getAnonymousUser(c.req.raw);
        if (!anonymousData) {
          return c.json({ error: "Authentication required" }, 401);
        }
        user = anonymousData.user;
        anonymousSession = anonymousData.session;
        isAnonymous = true;
      }
    }

    if (user.organization_id) {
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
        // error-policy:J1 the dashboard protocol exposes a cold policy cache as
        // retryable unavailability and never falls through to database policy.
        if (error instanceof OrgRateLimitCacheNotReadyError) {
          return c.json(
            {
              error:
                "Rate-limit authorization cache is warming. Retry shortly.",
              retryable: true,
            },
            503,
            { "Retry-After": "1" },
          );
        }
        throw error;
      }
      if (orgRateLimited) return orgRateLimited;
    }

    const decodedBody = await decodeRequestJson(c.req);
    if (!decodedBody.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const body = decodedBody.value;
    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const {
      messages: rawMessages,
      id,
      tier,
    } = body as {
      messages?: Array<{
        role: string;
        content?: string;
        parts?: Array<{ type: string; text?: string }>;
        metadata?: unknown;
      }>;
      id?: string;
      tier?: string;
    };
    if (!rawMessages?.length) {
      return c.json({ error: "Messages array cannot be empty" }, 400);
    }

    let messages: UIMessage[];
    try {
      messages = normalizeMessages(rawMessages);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Invalid message role")
      ) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }

    const UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const tierOrModel = tier || (id && !UUID_RE.test(id) ? id : undefined);
    const modelConfig = resolveModel(tierOrModel);
    const selectedModel = modelConfig.modelId;
    const provider = modelConfig.provider;
    const lastMessage = messages[messages.length - 1];
    const lastRawMessage = rawMessages[rawMessages.length - 1];
    const metadata =
      lastRawMessage?.metadata && typeof lastRawMessage.metadata === "object"
        ? (lastRawMessage.metadata as { conversationId?: string })
        : null;
    const conversationId = metadata?.conversationId;

    if (!hasLanguageModelProviderConfigured(selectedModel)) {
      return c.json({ error: getAiProviderConfigurationError() }, 503);
    }

    if (!moderationAlreadyChecked) {
      const blocked = await contentModerationService.shouldBlockUser(user.id);
      if (blocked) {
        logger.warn("chat-api", "User blocked due to moderation violations", {
          userId: user.id,
        });
        return c.json(
          {
            error:
              "Your account has been suspended due to policy violations. Please contact support.",
          },
          403,
        );
      }
    }

    const lastMessageText = getMessageText(lastMessage);
    if (lastMessageText) {
      const moderationTask = contentModerationService.moderateInBackground(
        lastMessageText,
        user.id,
        conversationId,
        (result) => {
          logger.warn("chat-api", "Async moderation detected violation", {
            userId: user.id,
            categories: result.flaggedCategories,
            action: result.action,
          });
          if (executionCtx && anonymousCredential) {
            executionCtx.waitUntil(
              refreshAnonymousChatModeration(anonymousCredential).catch(
                (error) => {
                  // error-policy:J7 the violation is durable in Postgres; this
                  // cache refresh failure is separately observable.
                  logger.error(
                    "chat-api",
                    "Anonymous moderation cache refresh failed",
                    {
                      userId: user.id,
                      error:
                        error instanceof Error ? error.message : String(error),
                    },
                  );
                },
              ),
            );
          }
        },
      );
      executionCtx?.waitUntil(moderationTask);
    }

    const requestId = crypto.randomUUID();
    if (isAnonymous && anonymousSession) {
      if (executionCtx && anonymousCredential) {
        const leaseResolution = await reserveAnonymousChatSlot(
          anonymousCredential,
          requestId,
          executionCtx,
        );
        if (
          leaseResolution.kind === "warming" ||
          leaseResolution.kind === "unavailable"
        ) {
          return retryableWarmingResponse(c, "Anonymous quota");
        }
        if (leaseResolution.kind === "rejected") {
          return c.json(
            { error: "Anonymous session is no longer active" },
            401,
          );
        }
        if (leaseResolution.kind === "limited") {
          return anonymousLimitResponse(c, leaseResolution);
        }

        const lease: AnonymousChatGateLease = leaseResolution.lease;
        let terminal:
          | { outcome: "commit" | "refund"; promise: Promise<void> }
          | undefined;
        const finalize = (outcome: "commit" | "refund"): Promise<void> => {
          terminal ??= {
            outcome,
            promise:
              outcome === "commit"
                ? commitAnonymousChatSlot(lease)
                : refundAnonymousChatSlot(lease, executionCtx),
          };
          return terminal.promise;
        };
        refundAnonymousMessageSlot = () => finalize("refund");
        commitAnonymousMessageSlot = () => finalize("commit");
        markAnonymousMessageSlotDispatched = () =>
          markAnonymousChatSlotDispatched(lease);
        anonymousSession.message_count += 1;
        logger.info("chat-api", "Anonymous user message allowed", {
          userId: user.id,
          remaining: leaseResolution.remaining,
          limit: leaseResolution.limit,
        });
      } else {
        const limitCheck = await reserveAnonymousMessageSlot(
          anonymousSession.session_token,
        );
        if (!limitCheck.allowed) {
          return anonymousLimitResponse(c, limitCheck);
        }
        let refunded = false;
        refundAnonymousMessageSlot = async () => {
          if (refunded || !anonymousSession) return;
          refunded = true;
          await anonymousSessionsService.refundMessageSlot(anonymousSession.id);
        };
        commitAnonymousMessageSlot = async () => undefined;
      }
    }

    const cotBudget = resolveAnthropicThinkingBudgetTokens(
      selectedModel,
      process.env,
    );
    const effectiveMaxOutputTokens =
      cotBudget != null
        ? Math.max(
            DEFAULT_MIN_OUTPUT_TOKENS,
            cotBudget + DEFAULT_MIN_OUTPUT_TOKENS,
          )
        : undefined;
    const estimatedInputTokens = estimateTokens(
      messages.map((message) => extractTextFromParts(message.parts)).join(" "),
    );
    const estimatedOutputTokens =
      effectiveMaxOutputTokens ?? DEFAULT_OUTPUT_TOKENS;
    const billingSource = resolveAiProviderSource(selectedModel) ?? "gateway";
    const affiliateCode = isAnonymous
      ? null
      : (c.req.header("X-Affiliate-Code") ?? null);

    if (user.organization_id) {
      try {
        const admission = await admitOrganizationInference({
          context: {
            organizationId: user.organization_id,
            userId: user.id,
            apiKeyId: apiKey?.id,
            model: selectedModel,
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
          return c.json(
            { error: "Insufficient balance", details: error.message },
            402,
          );
        }
        if (
          error instanceof InferenceBalanceCacheWarmingError ||
          error instanceof AiPricingCacheWarmingError ||
          error instanceof AiPricingCacheUnavailableError
        ) {
          return retryableWarmingResponse(c, "Billing");
        }
        throw error;
      }
    } else {
      const reservation = creditsService.createAnonymousReservation();
      const settle = createCreditReservationSettler(reservation);
      settleReservation = settle;
      settleUnknownReservation = () => settle(reservation.reservedAmount);
      billingReservation = reservation;
    }

    if (!settleReservation || !settleUnknownReservation) {
      throw new Error("Chat inference admission did not return settlers");
    }

    const routeTimeoutMs = getRouteTimeoutMs(ROUTE_MAX_DURATION);
    const languageModel = getLanguageModel(selectedModel);
    const modelMessages = await convertToModelMessages(messages);
    await markProviderDispatched?.();
    await markAnonymousMessageSlotDispatched?.();
    providerDispatchStarted = true;
    const result = streamText({
      model: languageModel,
      system:
        "Powered by elizaOS. Provide clear, accurate, and helpful responses about AI agents, development, and technology.",
      messages: modelMessages,
      abortSignal: c.req.raw.signal,
      timeout: routeTimeoutMs,
      ...(effectiveMaxOutputTokens != null
        ? { maxOutputTokens: effectiveMaxOutputTokens }
        : {}),
      ...mergeAnthropicCotProviderOptions(
        selectedModel,
        process.env,
        cotBudget ?? undefined,
      ),
      onFinish: async ({ text, usage }) => {
        await settleOffResponsePath(executionCtx, async () => {
          if (!usage) {
            await settleUnknownReservation?.();
            await commitAnonymousMessageSlot?.();
            logger.error("chat-api", "Provider finished without usage", {
              requestId,
              userId: user.id,
              model: selectedModel,
            });
            return;
          }

          try {
            const billing = await billUsage(
              {
                organizationId: user.organization_id || "anonymous",
                userId: user.id,
                apiKeyId: apiKey?.id,
                model: selectedModel,
                provider,
                billingSource,
                affiliateCode,
                requestId,
              },
              usage,
              billingReservation,
            );
            await settleReservation?.(billing.totalCost);
            await commitAnonymousMessageSlot?.();

            if (isAnonymous && anonymousSession) {
              await anonymousSessionsService.addTokenUsage(
                anonymousSession.id,
                (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
              );
            }

            const userMessage = messages[messages.length - 1];
            if (conversationId) {
              await conversationsService.addMessageWithSequence(
                conversationId,
                {
                  role: "user",
                  content: extractTextFromParts(userMessage.parts),
                  model: selectedModel,
                  tokens: usage.inputTokens,
                  cost: String(billing.inputCost),
                },
              );
              await conversationsService.addMessageWithSequence(
                conversationId,
                {
                  role: "assistant",
                  content: text,
                  model: selectedModel,
                  tokens: usage.outputTokens,
                  cost: String(billing.outputCost),
                },
              );
            }

            if (user.organization_id) {
              const usageRecord = await usageService.create({
                organization_id: user.organization_id,
                user_id: user.id,
                api_key_id: apiKey?.id || null,
                type: "chat",
                model: selectedModel,
                provider,
                input_tokens: usage.inputTokens,
                output_tokens: usage.outputTokens,
                input_cost: String(billing.inputCost),
                output_cost: String(billing.outputCost),
                is_successful: true,
              });
              if (apiKey) {
                await generationsService.create({
                  organization_id: user.organization_id,
                  user_id: user.id,
                  api_key_id: apiKey.id,
                  type: "chat",
                  model: selectedModel,
                  provider,
                  prompt: extractTextFromParts(userMessage.parts),
                  status: "completed",
                  content: text,
                  tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
                  cost: String(billing.totalCost),
                  credits: String(billing.totalCost),
                  usage_record_id: usageRecord.id,
                  completed_at: new Date(),
                  result: {
                    text,
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    totalTokens:
                      (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
                  },
                });
              }
            }

            logger.info("chat-api", "Cost charged", {
              requestId,
              totalCost: billing.totalCost,
              inputCost: billing.inputCost,
              outputCost: billing.outputCost,
            });
          } catch (error) {
            try {
              await settleUnknownReservation?.();
              await commitAnonymousMessageSlot?.();
            } catch (settlementError) {
              logger.error(
                "chat-api",
                "Unknown-cost settlement failed after provider completion",
                {
                  requestId,
                  error:
                    settlementError instanceof Error
                      ? settlementError.message
                      : String(settlementError),
                },
              );
            }
            // error-policy:J7 this response has already streamed; the provider
            // usage and conservative settlement remain observable in logs.
            logger.error("chat-api", "Deferred chat persistence failed", {
              requestId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
      },
      onAbort: async () => {
        await settleOffResponsePath(executionCtx, async () => {
          await commitAnonymousMessageSlot?.();
          await settleUnknownReservation?.();
        });
        logger.info("chat-api", "Aborted chat stream", {
          requestId,
          userId: user.id,
          model: selectedModel,
        });
      },
      onError: async ({ error }: { error: unknown }) => {
        await settleOffResponsePath(executionCtx, async () => {
          if (isKnownUnacceptedProviderError(error)) {
            await refundAnonymousMessageSlot?.();
            await settleReservation?.(0);
          } else {
            await commitAnonymousMessageSlot?.();
            await settleUnknownReservation?.();
          }
        });
        logger.error("chat-api", "Stream provider error", {
          requestId,
          userId: user.id,
          model: selectedModel,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });

    const streamResponse = result.toUIMessageStreamResponse();
    if (!streamResponse.body) return streamResponse;

    // Backstop: the SDK can tear down its UI-message stream without ever
    // invoking onFinish/onAbort/onError (an encoding-path throw, or a client
    // cancel racing ahead of the abort callback) — the exact gap the
    // /v1/chat/completions and /v1/messages stream-catch backstops close. Wrap
    // the response body so a read failure or cancellation still settles the
    // admission instead of leaking the hold to the 20-minute lease alarm.
    // Every settler here is first-call-wins idempotent and the anonymous
    // commit/refund is single-flighted, so a callback that already settled
    // makes this a no-op.
    const settleStreamTeardown = (error?: unknown) =>
      settleOffResponsePath(executionCtx, async () => {
        if (error !== undefined && isKnownUnacceptedProviderError(error)) {
          await refundAnonymousMessageSlot?.();
          await settleReservation?.(0);
        } else {
          // Same terminal decision as onAbort/ambiguous onError: delivered
          // provider work with unknown cost retains the admitted estimate.
          await commitAnonymousMessageSlot?.();
          await settleUnknownReservation?.();
        }
      });
    const upstreamReader = streamResponse.body.getReader();
    const guardedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await upstreamReader.read();
          if (next.done) {
            controller.close();
          } else {
            controller.enqueue(next.value);
          }
        } catch (error) {
          await settleStreamTeardown(error);
          logger.error("chat-api", "UI-message stream failed mid-flight", {
            requestId,
            error: error instanceof Error ? error.message : String(error),
          });
          // error-policy:J1 surface the SDK stream failure to the client after
          // the settlement backstop has run.
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await upstreamReader.cancel(reason);
        } finally {
          await settleStreamTeardown();
        }
      },
    });
    return new Response(guardedBody, {
      status: streamResponse.status,
      statusText: streamResponse.statusText,
      headers: streamResponse.headers,
    });
  } catch (error) {
    await settleOffResponsePath(executionCtx, async () => {
      if (
        !providerDispatchStarted ||
        isProviderConfigurationError(error) ||
        isKnownUnacceptedProviderError(error)
      ) {
        await refundAnonymousMessageSlot?.();
        await settleReservation?.(0);
      } else {
        await commitAnonymousMessageSlot?.();
        await settleUnknownReservation?.();
      }
    });
    logger.error("chat-api", "Error processing chat", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
