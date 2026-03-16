import { streamText, type UIMessage, convertToModelMessages } from "ai";
import { gateway } from "@ai-sdk/gateway";
import { requireAuthOrApiKey } from "@/lib/auth";
import { getAnonymousUser, checkAnonymousLimit } from "@/lib/auth-anonymous";
import { conversationsService } from "@/lib/services/conversations";
import { usageService } from "@/lib/services/usage";
import { generationsService } from "@/lib/services/generations";
import { anonymousSessionsService } from "@/lib/services/anonymous-sessions";
import { contentModerationService } from "@/lib/services/content-moderation";
import {
  creditsService,
  InsufficientCreditsError,
  type CreditReservation,
} from "@/lib/services/credits";
import { calculateCost, estimateTokens } from "@/lib/pricing";
import { resolveModel } from "@/lib/models";
import { logger } from "@/lib/utils/logger";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { UserWithOrganization, ApiKey } from "@/lib/types";
import type { AnonymousSession } from "@/db/schemas";

export const maxDuration = 60;

const VALID_MESSAGE_ROLES = ["user", "assistant", "system", "tool"] as const;
type ValidRole = (typeof VALID_MESSAGE_ROLES)[number];

function isValidRole(role: string): role is ValidRole {
  return VALID_MESSAGE_ROLES.includes(role as ValidRole);
}

/**
 * Normalize messages to UIMessage format.
 * Accepts both UIMessage format (with parts) and OpenAI format (with content).
 * @throws Error if a message has an invalid role.
 */
function normalizeMessages(
  messages: Array<{
    role: string;
    content?: string | string[];
    parts?: Array<{ type: string; text?: string }>;
  }>,
): UIMessage[] {
  return messages.map((msg, index) => {
    // Validate role
    if (!isValidRole(msg.role)) {
      throw new Error(
        `Invalid message role "${msg.role}" at index ${index}. Valid roles: ${VALID_MESSAGE_ROLES.join(", ")}`,
      );
    }

    // If message already has parts array, use it
    if (msg.parts && Array.isArray(msg.parts)) {
      return msg as UIMessage;
    }

    // Convert content string to parts format
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

/**
 * Extract text content from message parts.
 */
function extractTextFromParts(
  parts: Array<{ type: string; text?: string }>,
): string {
  return parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/**
 * Extract text content from a message (handles both formats).
 */
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
 * POST /api/v1/chat
 * Chat completion endpoint supporting both authenticated and anonymous users.
 * Processes chat messages and returns AI responses with credit deduction.
 *
 * @param req - Request body with messages array and optional conversation ID.
 * @returns Streaming text response or JSON error.
 */
async function handlePOST(req: NextRequest) {
  try {
    let user: UserWithOrganization;
    let apiKey: ApiKey | undefined = undefined;
    let isAnonymous = false;
    let anonymousSession: AnonymousSession | null = null;

    // Try authenticated user first
    try {
      const authResult = await requireAuthOrApiKey(req);
      user = authResult.user;
      apiKey = authResult.apiKey;
    } catch {
      // Fallback to anonymous user
      const anonData = await getAnonymousUser();
      if (!anonData) {
        throw new Error("Authentication required");
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

    const body = await req.json();
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

    // Validate messages array is not empty
    if (!rawMessages || rawMessages.length === 0) {
      return NextResponse.json(
        { error: "Messages array cannot be empty" },
        { status: 400 },
      );
    }

    // Normalize messages to UIMessage format (handles both OpenAI and UIMessage formats)
    let messages: UIMessage[];
    try {
      messages = normalizeMessages(rawMessages);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Invalid message role")
      ) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }

    const modelConfig = resolveModel(tier || id);
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

    // Check if user is blocked due to moderation violations
    if (await contentModerationService.shouldBlockUser(user.id)) {
      logger.warn("chat-api", "User blocked due to moderation violations", {
        userId: user.id,
      });
      return NextResponse.json(
        {
          error:
            "Your account has been suspended due to policy violations. Please contact support.",
        },
        { status: 403 },
      );
    }

    // Start async content moderation (runs in background, doesn't block)
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

    // Handle anonymous user rate limiting
    if (isAnonymous && anonymousSession) {
      // Check message limit for anonymous users
      const limitCheck = await checkAnonymousLimit(
        anonymousSession.session_token,
      );

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

        return NextResponse.json(
          {
            error: errorMessage,
            requiresSignup: true,
            reason: limitCheck.reason,
            limit: limitCheck.limit,
            remaining: limitCheck.remaining,
          },
          { status: 429 },
        );
      }

      logger.info("chat-api", "Anonymous user message allowed", {
        userId: user.id,
        remaining: limitCheck.remaining,
        limit: limitCheck.limit,
      });
    }

    // Reserve credits BEFORE making API call (prevents TOCTOU race condition)
    let reservation: CreditReservation =
      creditsService.createAnonymousReservation();

    if (!isAnonymous && user.organization_id) {
      const messageText = messages
        .map((m) => extractTextFromParts(m.parts))
        .join(" ");
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
          return NextResponse.json(
            {
              error: "Insufficient balance",
              details: error.message,
            },
            { status: 402 },
          );
        }
        throw error;
      }
    }

    const result = streamText({
      model: gateway.languageModel(selectedModel),
      system: `You are a helpful AI assistant powered by elizaOS. You provide clear, accurate, and helpful responses.
      You are knowledgeable about AI agents, development, and technology.`,
      messages: await convertToModelMessages(messages),
      onFinish: async ({ text, usage }) => {
        if (!usage) return;

        try {
          // Increment message count AFTER successful completion (for anonymous users)
          if (isAnonymous && anonymousSession) {
            await anonymousSessionsService.incrementMessageCount(
              anonymousSession.id,
            );

            logger.info(
              "chat-api",
              "Incremented anonymous message count after success",
              {
                sessionId: anonymousSession.id,
                newCount: anonymousSession.message_count + 1,
              },
            );
          }

          const userMessage = messages[messages.length - 1];

          const { inputCost, outputCost, totalCost } = await calculateCost(
            selectedModel,
            provider,
            usage.inputTokens || 0,
            usage.outputTokens || 0,
          );

          // Reconcile credits (refund excess if actual < reserved)
          // For anonymous users, reservation.reconcile is a no-op
          await reservation.reconcile(totalCost);

          // Track token usage for anonymous users (no credits, just analytics)
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
            // Add user message
            await conversationsService.addMessageWithSequence(conversationId, {
              role: "user",
              content: extractTextFromParts(userMessage.parts),
              model: selectedModel,
              tokens: usage.inputTokens,
              cost: String(inputCost),
            });

            // Add assistant message
            await conversationsService.addMessageWithSequence(conversationId, {
              role: "assistant",
              content: text,
              model: selectedModel,
              tokens: usage.outputTokens,
              cost: String(outputCost),
            });
          }

          // Create usage/generation records only for authenticated users with org
          // Anonymous users are tracked via anonymousSessionsService
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
              input_cost: String(inputCost),
              output_cost: String(outputCost),
              is_successful: true,
            });

            if (apiKey) {
              const lastMessageParts = messages[messages.length - 1]?.parts;
              const userPrompt = lastMessageParts
                ? extractTextFromParts(lastMessageParts)
                : "";
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
                cost: String(totalCost),
                credits: String(totalCost),
                usage_record_id: usageRecord.id,
                completed_at: new Date(),
                result: {
                  text: text,
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  totalTokens:
                    (usage.inputTokens || 0) + (usage.outputTokens || 0),
                },
              });
            }
          }

          logger.info("chat-api", "Cost charged", {
            totalCost,
            inputCost,
            outputCost,
          });
        } catch (error) {
          logger.error(
            "chat-api",
            "Error persisting messages or deducting credits",
            { error: error instanceof Error ? error.message : "Unknown error" },
          );

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
                error_message:
                  error instanceof Error ? error.message : "Unknown error",
              });

              if (apiKey) {
                const lastMessageParts = messages[messages.length - 1]?.parts;
                const userPrompt = lastMessageParts
                  ? extractTextFromParts(lastMessageParts)
                  : "";
                await generationsService.create({
                  organization_id: user.organization_id,
                  user_id: user.id,
                  api_key_id: apiKey.id,
                  type: "chat",
                  model: selectedModel,
                  provider: provider,
                  prompt: userPrompt,
                  status: "failed",
                  error:
                    error instanceof Error ? error.message : "Unknown error",
                  usage_record_id: errorUsageRecord.id,
                  completed_at: new Date(),
                });
              }
            } catch (usageError) {
              logger.error("chat-api", "Error creating usage record", {
                error:
                  usageError instanceof Error
                    ? usageError.message
                    : "Unknown error",
              });
            }
          }
        }
      },
    });

    return result.toUIMessageStreamResponse();
  } catch (error) {
    logger.error("chat-api", "Error processing chat", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return new Response(JSON.stringify({ error: "Failed to process chat" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export const POST = withRateLimit(handlePOST, RateLimitPresets.STANDARD);
