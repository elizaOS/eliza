import { NextResponse } from "next/server";
import { agentRuntime } from "@/lib/eliza/agent-runtime";
import { requireAuthOrApiKey } from "@/lib/auth";
import { getAnonymousUser, checkAnonymousLimit } from "@/lib/auth-anonymous";
import {
  creditsService,
  InsufficientCreditsError,
  type CreditReservation,
} from "@/lib/services/credits";
import { usageService } from "@/lib/services/usage";
import { discordService } from "@/lib/services/discord";
import { anonymousSessionsService } from "@/lib/services/anonymous-sessions";
import { contentModerationService } from "@/lib/services/content-moderation";
import {
  calculateCost,
  getProviderFromModel,
  estimateTokens,
} from "@/lib/pricing";
import { logger } from "@/lib/utils/logger";
import type { NextRequest } from "next/server";
import { roomsRepository } from "@/db/repositories";
import { dbRead } from "@/db/client";
import { sql } from "drizzle-orm";
import type { UserWithOrganization, ApiKey } from "@/lib/types";
import type { AnonymousSession } from "@/db/schemas/anonymous-sessions";

export const maxDuration = 60;

// POST /api/eliza/rooms/[roomId]/messages - Send a message
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ roomId: string }> },
) {
  try {
    // Support both authenticated and anonymous users
    let user: UserWithOrganization;
    let apiKey: ApiKey | undefined = undefined;
    let isAnonymous = false;
    let anonymousSession: AnonymousSession | null = null;

    try {
      const authResult = await requireAuthOrApiKey(request);
      user = authResult.user;
      apiKey = authResult.apiKey;
    } catch {
      // Fallback to anonymous user
      logger.info("[Messages API] Privy auth failed, trying anonymous...");

      let anonData = await getAnonymousUser();

      if (!anonData) {
        // Create new anonymous session if none exists
        logger.info(
          "[Messages API] No session cookie - creating new anonymous session",
        );
        const { getOrCreateAnonymousUser } =
          await import("@/lib/auth-anonymous");
        const newAnonData = await getOrCreateAnonymousUser();
        anonData = {
          user: newAnonData.user,
          session: newAnonData.session,
        };
        logger.info("[Messages API] Created anonymous user:", anonData.user.id);
      }

      user = anonData.user;
      anonymousSession = anonData.session;
      isAnonymous = true;

      logger.info("[Messages API] Anonymous user authenticated:", {
        userId: user.id,
        sessionId: anonymousSession?.id,
        messageCount: anonymousSession?.message_count,
      });
    }

    const { roomId } = await ctx.params;
    const body = await request.json();
    const { text, attachments } = body;

    if (!roomId) {
      logger.error("[Eliza Messages API] Missing roomId");
      return NextResponse.json(
        { error: "roomId is required" },
        { status: 400 },
      );
    }

    if (!text || typeof text !== "string" || text.trim().length === 0) {
      logger.error("[Eliza Messages API] Invalid or missing text", { text });
      return NextResponse.json(
        { error: "text is required and must be a non-empty string" },
        { status: 400 },
      );
    }

    // Check if user is blocked due to moderation violations
    if (await contentModerationService.shouldBlockUser(user.id)) {
      logger.warn(
        "[Eliza Messages API] User blocked due to moderation violations",
        {
          userId: user.id,
        },
      );
      return NextResponse.json(
        {
          error:
            "Your account has been suspended due to policy violations. Please contact support.",
        },
        { status: 403 },
      );
    }

    // Start async content moderation (runs in background, doesn't block)
    contentModerationService.moderateInBackground(
      text,
      user.id,
      roomId,
      (result) => {
        logger.warn(
          "[Eliza Messages API] Async moderation detected violation",
          {
            userId: user.id,
            roomId,
            categories: result.flaggedCategories,
            action: result.action,
          },
        );
      },
    );

    // Handle anonymous user rate limiting
    if (isAnonymous && anonymousSession) {
      const limitCheck = await checkAnonymousLimit(
        anonymousSession.session_token,
      );

      if (!limitCheck.allowed) {
        const errorMessage =
          limitCheck.reason === "message_limit"
            ? `You've reached your free message limit (${limitCheck.limit} messages). Sign up to continue chatting!`
            : `You've reached the hourly rate limit. Please wait an hour or sign up for unlimited access.`;

        logger.warn("eliza-messages-api", "Anonymous user limit reached", {
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

      logger.info("eliza-messages-api", "Anonymous user message allowed", {
        userId: user.id,
        remaining: limitCheck.remaining,
        limit: limitCheck.limit,
      });
    }

    // For authenticated users: Reserve credits BEFORE processing
    let reservation: CreditReservation | null = null;
    if (!isAnonymous) {
      if (!user.organization_id || !user.organization) {
        logger.error(
          "[Eliza Messages API] User has no organization - cannot proceed",
          { userId: user.id },
        );
        return NextResponse.json(
          { error: "User has no organization" },
          { status: 400 },
        );
      }

      try {
        reservation = await creditsService.reserve({
          organizationId: user.organization_id,
          model: "gpt-4o",
          provider: "openai",
          estimatedInputTokens: estimateTokens(text),
          estimatedOutputTokens: 100,
          userId: user.id,
          description: "Message processing (gpt-4o)",
        });
      } catch (error) {
        if (error instanceof InsufficientCreditsError) {
          return NextResponse.json(
            {
              error: "Insufficient credits",
              required: error.required,
            },
            { status: 402 },
          );
        }
        throw error;
      }
    }

    // Process message via agent runtime (backward compatibility layer)
    logger.info("[Eliza Messages API] Processing message:", {
      roomId,
      userId: user.id,
    });

    const room = await roomsRepository.findById(roomId);
    const characterId = room?.agentId || undefined;

    let result;
    try {
      result = await agentRuntime.handleMessage(
        roomId,
        { text, attachments },
        characterId,
        {
          userId: user.id,
          apiKey: apiKey?.key,
        },
      );
    } catch (error) {
      if (reservation) {
        await reservation.reconcile(0);
      }
      throw error;
    }

    // Reconcile credits and track usage for authenticated users
    if (!isAnonymous && result.usage && reservation) {
      try {
        const provider = getProviderFromModel(result.usage.model);
        const { totalCost: cost } = await calculateCost(
          result.usage.model,
          provider,
          result.usage.inputTokens,
          result.usage.outputTokens,
        );

        await reservation.reconcile(cost);

        await usageService.create({
          organization_id: user.organization_id!,
          user_id: user.id,
          type: "eliza",
          model: result.usage.model,
          provider,
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
        });

        logger.info("[Eliza Messages API] Credits reconciled:", {
          cost,
          model: result.usage.model,
          tokens: {
            input: result.usage.inputTokens,
            output: result.usage.outputTokens,
          },
        });
      } catch (error) {
        logger.error("[Eliza Messages API] Failed to handle credits:", error);
      }
    }

    // Track anonymous usage
    if (isAnonymous && anonymousSession) {
      await anonymousSessionsService.incrementMessageCount(anonymousSession.id);

      logger.info("[Eliza Messages API] Anonymous message tracked:", {
        sessionId: anonymousSession.id,
        newCount: (anonymousSession.message_count || 0) + 1,
      });
    }

    // Note: Room title generation is now handled by roomTitleEvaluator
    // It will automatically generate a title after 4+ messages

    // Send to Discord thread if configured
    const discordThreadId = room?.metadata?.discordThreadId as
      | string
      | undefined;
    if (discordThreadId) {
      try {
        const userMessage = `**${user.name || user.email || user.id}:** ${text}`;
        await discordService.sendToThread(discordThreadId, userMessage);

        const responseText =
          typeof result.message.content === "string"
            ? result.message.content
            : result.message.content?.text || "";

        const character =
          characterId &&
          (await dbRead.execute<{ name: string }>(
            sql`SELECT name FROM user_characters WHERE id = ${characterId}::uuid LIMIT 1`,
          ));

        const agentMessage = `**${character?.rows[0]?.name || "Agent"}:** ${responseText}`;
        await discordService.sendToThread(discordThreadId, agentMessage);

        logger.info("[Eliza Messages API] Sent to Discord thread:", {
          threadId: discordThreadId,
        });
      } catch (error) {
        logger.error(
          "[Eliza Messages API] Failed to send to Discord thread:",
          error,
        );
      }
    }

    return NextResponse.json({
      message: result.message,
      usage: result.usage,
    });
  } catch (error) {
    logger.error("[Eliza Messages API] Error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to process message",
      },
      { status: 500 },
    );
  }
}
