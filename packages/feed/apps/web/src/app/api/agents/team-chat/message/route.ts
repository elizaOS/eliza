/**
 * Team Chat Message API
 *
 * @route POST /api/agents/team-chat/message - Send message to team chat
 * @access Authenticated
 *
 * @description
 * Sends a message to the user's Agents team chat.
 * Agent responses are triggered separately by the frontend calling /api/agents/[agentId]/chat
 * for each selected agent (parallel execution model).
 *
 * On the first user message, an LLM-generated title is created for the conversation.
 *
 * @openapi
 * /api/agents/team-chat/message:
 *   post:
 *     tags:
 *       - Agents
 *     summary: Send team chat message
 *     description: |
 *       Sends a message to Agents.
 *       Agent responses are triggered separately via /api/agents/[agentId]/chat.
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - content
 *             properties:
 *               content:
 *                 type: string
 *                 description: Message content
 *               replyToMessageId:
 *                 type: string
 *                 description: Optional ID of the message being replied to
 *     responses:
 *       201:
 *         description: Message sent successfully
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: No team chat exists
 */

import { createGroq } from "@ai-sdk/groq";
import { teamChatService } from "@feed/agents";
import {
  authenticateUser,
  broadcastChatMessage,
  checkRateLimitAsync,
  RATE_LIMIT_CONFIGS,
  withErrorHandling,
} from "@feed/api";
import { and, db, eq, generateSnowflakeId, messages, users } from "@feed/db";
import { logger, toISO } from "@feed/shared";
import { generateText } from "ai";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

// =============================================================================
// Title Generation
// =============================================================================

/**
 * Generate a chat title from the first user message using LLM.
 * Returns the generated title or null if generation failed.
 */
async function generateAndUpdateChatTitle(
  chatId: string,
  firstMessage: string,
  userId: string,
): Promise<string | null> {
  try {
    if (!process.env.GROQ_API_KEY) {
      logger.warn(
        "GROQ_API_KEY not set, skipping title generation",
        { chatId },
        "TeamChatMessageAPI",
      );
      return null;
    }

    const groq = createGroq({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
    });

    const prompt = `Create a brief chat title (2-5 words) that captures the topic of this message.

Rules:
- Just the topic, no meta commentary (NOT "Question about X" or "User asks about X")
- No quotes, prefixes, or formatting

Message: "${firstMessage.slice(0, 200)}"

Title:`;

    // Add timeout to prevent hanging on slow API responses
    const GENERATE_TIMEOUT_MS = 10000;
    const abortController = new AbortController();
    const timeoutId = setTimeout(
      () => abortController.abort(),
      GENERATE_TIMEOUT_MS,
    );

    let result: { text: string };
    try {
      result = await generateText({
        model: groq("llama-3.1-8b-instant"),
        prompt,
        temperature: 0.7,
        maxOutputTokens: 50,
        abortSignal: abortController.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const title = result.text.trim().slice(0, 50);

    if (title) {
      // Use atomic update to prevent race conditions when multiple first messages
      // arrive simultaneously - only the first one to update will succeed
      const updated = await teamChatService.updateChatTitleIfNull(
        chatId,
        title,
        userId,
      );
      if (updated) {
        logger.info(
          "Generated chat title from first message",
          { chatId, title },
          "TeamChatMessageAPI",
        );
        return title;
      }
      // Another message already set the title - this is fine, no error needed
      logger.debug(
        "Chat title already set by concurrent request",
        { chatId },
        "TeamChatMessageAPI",
      );
      return null;
    }
    return null;
  } catch (error) {
    logger.error(
      "Failed to generate chat title",
      { chatId, error: error instanceof Error ? error.message : "Unknown" },
      "TeamChatMessageAPI",
    );
    return null;
  }
}

// =============================================================================
// Request Validation
// =============================================================================

/** Request body schema for team chat messages */
const messageSchema = z.object({
  content: z
    .string()
    .min(1, "Message content is required")
    .max(4000, "Message too long. Maximum 4000 characters allowed."),
  // Target IDs for message routing in team chat
  // - Array of agent IDs when @mentioning agents
  // - Empty array or undefined = coordinator (no @mentions)
  targetIds: z.array(z.string()).optional(),
  // Reply to a specific message (Telegram/Discord-style)
  replyToMessageId: z.string().min(1).optional(),
});

export const POST = withErrorHandling(async function POST(req: NextRequest) {
  const user = await authenticateUser(req);

  // Rate limit to prevent spam (especially important with agent auto-responses)
  const rateCheck = await checkRateLimitAsync(
    user.id,
    RATE_LIMIT_CONFIGS.SEND_MESSAGE,
  );
  if (!rateCheck.allowed) {
    return NextResponse.json(
      {
        success: false,
        error: "Rate limit exceeded. Please wait before sending more messages.",
        retryAfter: rateCheck.retryAfter,
      },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON in request body" },
      { status: 400 },
    );
  }

  const parseResult = messageSchema.safeParse(body);

  if (!parseResult.success) {
    const firstError = parseResult.error.issues[0];
    return NextResponse.json(
      { success: false, error: firstError?.message || "Invalid request body" },
      { status: 400 },
    );
  }

  const {
    content,
    targetIds: providedTargetIds,
    replyToMessageId,
  } = parseResult.data;

  // Get user's team chat
  const teamChat = await teamChatService.getTeamChat(user.id);

  if (!teamChat) {
    return NextResponse.json(
      {
        success: false,
        error: "No team chat exists",
        message: "Create your first agent to initialize your Agents chat.",
      },
      { status: 404 },
    );
  }

  // Determine target IDs for message routing
  const targetIds =
    providedTargetIds && providedTargetIds.length > 0 ? providedTargetIds : [];

  // Validate reply target and build reply snippet (if replying)
  let replyToMessage: {
    id: string;
    content: string;
    senderId: string;
    senderName?: string;
  } | null = null;

  if (replyToMessageId) {
    const [replyMsg] = await db
      .select({
        id: messages.id,
        content: messages.content,
        senderId: messages.senderId,
        senderName: users.displayName,
      })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.senderId))
      .where(
        and(
          eq(messages.id, replyToMessageId),
          eq(messages.chatId, teamChat.chatId),
        ),
      )
      .limit(1);

    if (!replyMsg) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid replyToMessageId: message not found in this chat",
        },
        { status: 400 },
      );
    }

    replyToMessage = {
      id: replyMsg.id,
      content: replyMsg.content.slice(0, 200),
      senderId: replyMsg.senderId,
      senderName: replyMsg.senderName ?? undefined,
    };
  }

  // Create the message
  const messageId = await generateSnowflakeId();
  const now = new Date();

  await db.insert(messages).values({
    id: messageId,
    chatId: teamChat.chatId,
    senderId: user.id,
    content: content.trim(),
    type: "user",
    createdAt: now,
    targetIds,
    replyToMessageId: replyToMessageId ?? null,
  });

  logger.info(
    `Team chat message sent by user ${user.id}`,
    { chatId: teamChat.chatId, messageId },
    "TeamChatMessageAPI",
  );

  // Broadcast the message via SSE
  await broadcastChatMessage(teamChat.chatId, {
    id: messageId,
    content: content.trim(),
    chatId: teamChat.chatId,
    senderId: user.id,
    type: "user",
    createdAt: toISO(now),
    isGameChat: false,
    isDMChat: false,
    replyToMessageId: replyToMessageId ?? undefined,
    replyToMessage,
  });

  // Generate chat title on first message
  // Check if chat needs title (name is null) and this is the first user message
  let generatedTitle: string | null = null;
  const needsTitle = await teamChatService.chatNeedsTitle(
    teamChat.chatId,
    user.id,
  );
  if (needsTitle) {
    const messageCount = await teamChatService.getUserMessageCount(
      teamChat.chatId,
      user.id,
    );
    // Only generate on first message (count is 1 after insert)
    if (messageCount === 1) {
      generatedTitle = await generateAndUpdateChatTitle(
        teamChat.chatId,
        content.trim(),
        user.id,
      );
    }
  }

  // Note: Agent responses are now triggered by the frontend calling
  // /api/agents/[agentId]/chat for each selected agent (parallel execution).
  // The old broadcastToAllAgents flow has been removed to prevent duplicate responses.

  return NextResponse.json(
    {
      success: true,
      message: {
        id: messageId,
        content: content.trim(),
        chatId: teamChat.chatId,
        senderId: user.id,
        type: "user",
        createdAt: toISO(now),
      },
      // Include generated title if one was created
      generatedTitle,
    },
    { status: 201 },
  );
});
