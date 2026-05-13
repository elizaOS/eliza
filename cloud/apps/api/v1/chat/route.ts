/**
 * POST /api/v1/chat
 *
 * Streaming chat endpoint (Pattern A: AI SDK `toUIMessageStreamResponse()`).
 * Supports authenticated and anonymous users. Returns a `ReadableStream`
 * Response — Hono passes it through unchanged.
 */

import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { Hono } from "hono";
import type { AnonymousSession } from "@/db/repositories/anonymous-sessions";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { getCurrentUser } from "@/lib/auth/workers-hono-auth";
import { checkAnonymousLimit, getAnonymousUser } from "@/lib/auth-anonymous";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
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
} from "@/lib/providers/language-model";
import { billUsage } from "@/lib/services/ai-billing";
import { anonymousSessionsService } from "@/lib/services/anonymous-sessions";
import { contentModerationService } from "@/lib/services/content-moderation";
import { conversationsService } from "@/lib/services/conversations";
import {
  type CreditReconciliationResult,
  type CreditReservation,
  creditsService,
  InsufficientCreditsError,
} from "@/lib/services/credits";
import { generationsService } from "@/lib/services/generations";
import { usageService } from "@/lib/services/usage";
import type { ApiKey } from "@/lib/types";
import { createCreditReservationSettler } from "@/lib/utils/credit-reservation";
import { logger } from "@/lib/utils/logger";
import { getRouteTimeoutMs } from "@/lib/utils/request-timeout";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const ROUTE_MAX_DURATION = 800;

const VALID_MESSAGE_ROLES = ["user", "assistant", "system", "tool"] as const;
type ValidRole = (typeof VALID_MESSAGE_ROLES)[number];
type ChatBillingUser = {
  id: string;
  organization_id?: string | null;
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
  return messages.map((msg, index) => {
    if (!isValidRole(msg.role)) {
      throw new Error(
        `Invalid message role "${msg.role}" at index ${index}. Valid roles: ${VALID_MESSAGE_ROLES.join(", ")}`,
      );
    }
    if (msg.parts && Array.isArray(msg.parts)) {
      return msg as UIMessage;
    }
    let content = "";
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content.join("");
    }
    return {
      role: msg.role,
      parts: [{ type: "text" as const, text: content }],
    } as UIMessage;
  });
}

function extractTextFromParts(parts: Array<{ type: string; text?: string }>): string {
  return parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}

function getMessageText(msg: UIMessage | { content?: string }): string {
  if ("parts" in msg && Array.isArray(msg.parts)) {
    return extractTextFromParts(msg.parts);
  }
  if ("content" in msg && typeof msg.content === "string") {
    return msg.content;
  }
  return "";
}

/**
 * Look up the validated apiKey row for the current request, if the caller
 * authenticated via X-API-Key / Bearer eliza_*. The Workers auth shim
 * validates the key but does not surface the row to handlers, so we repeat
 * the lookup here to preserve the Next-era billing attribution.
 */
async function getRequestApiKey(c: AppContext): Promise<ApiKey | undefined> {
  const apiKeyHeader = c.req.header("X-API-Key") || c.req.header("x-api-key");
  const auth = c.req.header("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const elizaBearer = bearer && bearer.startsWith("eliza_") ? bearer : null;
  const apiKey = apiKeyHeader || elizaBearer;
  if (!apiKey) return undefined;
  const { apiKeysService } = await import("@/lib/services/api-keys");
  const validated = await apiKeysService.validateApiKey(apiKey);
  return validated ?? undefined;
}

const app = new Hono<AppEnv>();
app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  let settleReservation:
    | ((actualCost: number) => Promise<CreditReconciliationResult | null>)
    | null = null;

  try {
    let user: ChatBillingUser;
    let apiKey: ApiKey | undefined;
    let isAnonymous = false;
    let anonymousSession: AnonymousSession | null = null;

    const authedUser = await getCurrentUser(c);
    if (authedUser) {
      user = authedUser;
      apiKey = await getRequestApiKey(c);
    } else {
      const anonData = await getAnonymousUser(c.req.raw);
      if (!anonData) {
        return c.json({ error: "Authentication required" }, 401);
      }
      user = anonData.user;
      anonymousSession = anonData.session;
      isAnonymous = true;
      logger.info("chat-api", "Anonymous user request", {
        userId: user.id,
        sessionId: anonymousSession?.id,
        messageCount: anonymousSession?.message_count,
      });
    }

    const body = await c.req.json();
    const {
      messages: rawMessages,
      id,
      tier,
    }: {
      messages: Array<{
        role: string;
        content?: string;
        parts?: Array<{ type: string; text?: string }>;
        metadata?: unknown;
      }>;
      id?: string;
      tier?: string;
    } = body;

    if (!rawMessages || rawMessages.length === 0) {
      return c.json({ error: "Messages array cannot be empty" }, 400);
    }

    let messages: UIMessage[];
    try {
      messages = normalizeMessages(rawMessages);
    } catch (error) {
      if (error instanceof Error && error.message.includes("Invalid message role")) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const tierOrModel = tier || (id && !UUID_RE.test(id) ? id : undefined);
    const modelConfig = resolveModel(tierOrModel);
    const selectedModel = modelConfig.modelId;
    const provider = modelConfig.provider;
    const lastMessage = messages[messages.length - 1];
    const lastRawMessage = rawMessages[rawMessages.length - 1];
    interface MessageMetadata {
      conversationId?: string;
    }
    const metadata =
      lastRawMessage?.metadata && typeof lastRawMessage.metadata === "object"
        ? (lastRawMessage.metadata as MessageMetadata)
        : null;
    const conversationId = metadata?.conversationId;

    if (!hasLanguageModelProviderConfigured(selectedModel)) {
      return c.json({ error: getAiProviderConfigurationError() }, 503);
    }

    if (await contentModerationService.shouldBlockUser(user.id)) {
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

    const lastMessageText = getMessageText(lastMessage);
    if (lastMessageText) {
      contentModerationService.moderateInBackground(
        lastMessageText,
        user.id,
        conversationId,
        (result) => {
          logger.warn("chat-api", "Async moderation detected violation", {
            userId: user.id,
            categories: result.flaggedCategories,
            action: result.action,
          });
        },
      );
    }

    if (isAnonymous && anonymousSession) {
      const limitCheck = await checkAnonymousLimit(anonymousSession.session_token);
      if (!limitCheck.allowed) {
        const errorMessage =
          limitCheck.reason === "message_limit"
            ? `You've reached your free message limit (${limitCheck.limit} messages). Sign up to continue chatting!`
            : `You've reached the hourly rate limit. Please wait an hour or sign up for unlimited access.`;
        logger.warn("chat-api", "Anonymous user limit reached", {
          userId: user.id,
          sessionId: anonymousSession.id,
          reason: limitCheck.reason,
          limit: limitCheck.limit,
        });
        return c.json(
          {
            error: errorMessage,
            requiresSignup: true,
            reason: limitCheck.reason,
            limit: limitCheck.limit,
            remaining: limitCheck.remaining,
          },
          429,
        );
      }
      logger.info("chat-api", "Anonymous user message allowed", {
        userId: user.id,
        remaining: limitCheck.remaining,
        limit: limitCheck.limit,
      });
    }

    let reservation: CreditReservation = creditsService.createAnonymousReservation();
    const affiliateCode = c.req.header("X-Affiliate-Code") ?? null;

    if (!isAnonymous && user.organization_id) {
      const messageText = messages.map((m) => extractTextFromParts(m.parts)).join(" ");
      const estimatedInputTokens = estimateTokens(messageText);
      try {
        reservation = await creditsService.reserve({
          organizationId: user.organization_id,
          model: selectedModel,
          provider,
          estimatedInputTokens,
          userId: user.id,
          description: `Chat: ${selectedModel}`,
        });
      } catch (error) {
        if (error instanceof InsufficientCreditsError) {
          return c.json({ error: "Insufficient balance", details: error.message }, 402);
        }
        throw error;
      }
    }

    settleReservation = createCreditReservationSettler(reservation);
    const routeTimeoutMs = getRouteTimeoutMs(ROUTE_MAX_DURATION);

    const DEFAULT_MIN_OUTPUT_TOKENS = 4096;
    const cotBudget = resolveAnthropicThinkingBudgetTokens(selectedModel, process.env);
    const effectiveMaxOutputTokens =
      cotBudget != null
        ? Math.max(DEFAULT_MIN_OUTPUT_TOKENS, cotBudget + DEFAULT_MIN_OUTPUT_TOKENS)
        : undefined;

    const result = streamText({
      model: getLanguageModel(selectedModel),
      system: `You are a helpful AI assistant powered by elizaOS. You provide clear, accurate, and helpful responses.
      You are knowledgeable about AI agents, development, and technology.`,
      messages: await convertToModelMessages(messages),
      abortSignal: c.req.raw.signal,
      timeout: routeTimeoutMs,
      ...(effectiveMaxOutputTokens != null ? { maxOutputTokens: effectiveMaxOutputTokens } : {}),
      ...mergeAnthropicCotProviderOptions(selectedModel, process.env, cotBudget ?? undefined),
      onFinish: async ({ text, usage }) => {
        try {
          if (!usage) {
            await settleReservation?.(0);
            return;
          }

          if (isAnonymous && anonymousSession) {
            await anonymousSessionsService.incrementMessageCount(anonymousSession.id);
            logger.info("chat-api", "Incremented anonymous message count after success", {
              sessionId: anonymousSession.id,
              newCount: anonymousSession.message_count + 1,
            });
          }

          const userMessage = messages[messages.length - 1];
          const billing = await billUsage(
            {
              organizationId: user.organization_id || "anonymous",
              userId: user.id,
              apiKeyId: apiKey?.id,
              model: selectedModel,
              provider,
              affiliateCode,
            },
            usage,
          );
          await settleReservation?.(billing.totalCost);

          const totalCostBilled = billing.totalCost;
          const inputCostBilled = billing.inputCost;
          const outputCostBilled = billing.outputCost;

          if (isAnonymous && anonymousSession) {
            await anonymousSessionsService.addTokenUsage(
              anonymousSession.id,
              (usage.inputTokens || 0) + (usage.outputTokens || 0),
            );
            logger.info("chat-api", "Anonymous user token usage tracked", {
              userId: user.id,
              tokens: (usage.inputTokens || 0) + (usage.outputTokens || 0),
              model: selectedModel,
            });
          }

          if (conversationId) {
            await conversationsService.addMessageWithSequence(conversationId, {
              role: "user",
              content: extractTextFromParts(userMessage.parts),
              model: selectedModel,
              tokens: usage.inputTokens,
              cost: String(inputCostBilled),
            });
            await conversationsService.addMessageWithSequence(conversationId, {
              role: "assistant",
              content: text,
              model: selectedModel,
              tokens: usage.outputTokens,
              cost: String(outputCostBilled),
            });
          }

          if (user.organization_id) {
            const usageRecord = await usageService.create({
              organization_id: user.organization_id,
              user_id: user.id,
              api_key_id: apiKey?.id || null,
              type: "chat",
              model: selectedModel,
              provider: provider,
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
              input_cost: String(inputCostBilled),
              output_cost: String(outputCostBilled),
              is_successful: true,
            });

            if (apiKey) {
              const lastMessageParts = messages[messages.length - 1]?.parts;
              const userPrompt = lastMessageParts ? extractTextFromParts(lastMessageParts) : "";
              await generationsService.create({
                organization_id: user.organization_id,
                user_id: user.id,
                api_key_id: apiKey.id,
                type: "chat",
                model: selectedModel,
                provider: provider,
                prompt: userPrompt,
                status: "completed",
                content: text,
                tokens: (usage.inputTokens || 0) + (usage.outputTokens || 0),
                cost: String(totalCostBilled),
                credits: String(totalCostBilled),
                usage_record_id: usageRecord.id,
                completed_at: new Date(),
                result: {
                  text: text,
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  totalTokens: (usage.inputTokens || 0) + (usage.outputTokens || 0),
                },
              });
            }
          }

          logger.info("chat-api", "Cost charged", {
            totalCost: totalCostBilled,
            inputCost: inputCostBilled,
            outputCost: outputCostBilled,
          });
        } catch (error) {
          await settleReservation?.(0);
          logger.error("chat-api", "Error persisting messages or deducting credits", {
            error: error instanceof Error ? error.message : "Unknown error",
          });

          if (usage && user.organization_id) {
            try {
              const errorUsageRecord = await usageService.create({
                organization_id: user.organization_id,
                user_id: user.id,
                api_key_id: apiKey?.id || null,
                type: "chat",
                model: selectedModel,
                provider: provider,
                input_tokens: usage.inputTokens || 0,
                output_tokens: usage.outputTokens || 0,
                input_cost: String(0),
                output_cost: String(0),
                is_successful: false,
                error_message: error instanceof Error ? error.message : "Unknown error",
              });

              if (apiKey) {
                const lastMessageParts = messages[messages.length - 1]?.parts;
                const userPrompt = lastMessageParts ? extractTextFromParts(lastMessageParts) : "";
                await generationsService.create({
                  organization_id: user.organization_id,
                  user_id: user.id,
                  api_key_id: apiKey.id,
                  type: "chat",
                  model: selectedModel,
                  provider: provider,
                  prompt: userPrompt,
                  status: "failed",
                  error: error instanceof Error ? error.message : "Unknown error",
                  usage_record_id: errorUsageRecord.id,
                  completed_at: new Date(),
                });
              }
            } catch (usageError) {
              logger.error("chat-api", "Error creating usage record", {
                error: usageError instanceof Error ? usageError.message : "Unknown error",
              });
            }
          }
        }
      },
      onAbort: async () => {
        await settleReservation?.(0);
        logger.info("chat-api", "Aborted chat stream before completion", {
          userId: user.id,
          model: selectedModel,
        });
      },
    });

    return result.toUIMessageStreamResponse();
  } catch (error) {
    await settleReservation?.(0);
    logger.error("chat-api", "Error processing chat", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return failureResponse(c, error);
  }
});

export default app;
