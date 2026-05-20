/**
 * Team Chat Conversations API
 *
 * Manages conversation sessions within the team chat (Agents).
 * Supports "New Chat" feature like ChatGPT.
 *
 * @route GET /api/agents/team-chat/conversations - List all conversations
 * @route POST /api/agents/team-chat/conversations - Create new conversation
 */

import { teamChatService } from '@feed/agents';
import { authenticateUser, withErrorHandling } from '@feed/api';
import { logger, toISO } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

// =============================================================================
// GET: List conversations
// =============================================================================

export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticateUser(req);

  const conversations = await teamChatService.listConversations(user.id);

  // Get current active chatId
  const teamChat = await teamChatService.getTeamChat(user.id);

  return NextResponse.json({
    success: true,
    conversations: conversations.map((c) => ({
      id: c.id,
      name: c.name,
      createdAt: toISO(c.createdAt),
      updatedAt: toISO(c.updatedAt),
      isActive: c.id === teamChat?.chatId,
    })),
    activeChatId: teamChat?.chatId,
  });
});

// =============================================================================
// POST: Create new conversation
// =============================================================================

const createConversationSchema = z.object({
  title: z.string().max(100).optional(),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = await authenticateUser(req);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const parseResult = createConversationSchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { success: false, error: 'Invalid request body' },
      { status: 400 }
    );
  }

  const { title } = parseResult.data;

  const { chat, teamChat } = await teamChatService.createConversation(
    user.id,
    title
  );

  logger.info(
    `New conversation created`,
    { userId: user.id, chatId: chat.id, title: chat.name },
    'TeamChatConversationsAPI'
  );

  return NextResponse.json(
    {
      success: true,
      conversation: {
        id: chat.id,
        name: chat.name,
        createdAt: toISO(chat.createdAt),
        updatedAt: toISO(chat.updatedAt),
        isActive: true,
      },
      activeChatId: teamChat.chatId,
    },
    { status: 201 }
  );
});
