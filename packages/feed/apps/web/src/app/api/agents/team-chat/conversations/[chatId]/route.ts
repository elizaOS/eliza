/**
 * Team Chat Conversation Management API
 *
 * @route PUT /api/agents/team-chat/conversations/[chatId] - Switch to/rename conversation
 * @route DELETE /api/agents/team-chat/conversations/[chatId] - Delete conversation
 */

import { teamChatService } from '@babylon/agents';
import { authenticateUser, withErrorHandling } from '@babylon/api';
import { logger } from '@babylon/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

// =============================================================================
// PUT: Switch to conversation or rename it
// =============================================================================

const updateConversationSchema = z.object({
  action: z.enum(['switch', 'rename']),
  title: z.string().max(100).optional(), // Required for rename
});

export const PUT = withErrorHandling(
  async (
    req: NextRequest,
    { params }: { params: Promise<{ chatId: string }> }
  ) => {
    const user = await authenticateUser(req);
    const { chatId } = await params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid JSON in request body' },
        { status: 400 }
      );
    }

    const parseResult = updateConversationSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid request body' },
        { status: 400 }
      );
    }

    const { action, title } = parseResult.data;

    if (action === 'switch') {
      const teamChat = await teamChatService.switchConversation(
        user.id,
        chatId
      );

      logger.info(
        `Switched conversation`,
        { userId: user.id, chatId },
        'TeamChatConversationsAPI'
      );

      return NextResponse.json({
        success: true,
        activeChatId: teamChat.chatId,
      });
    }

    if (action === 'rename') {
      if (!title) {
        return NextResponse.json(
          { success: false, error: 'Title is required for rename action' },
          { status: 400 }
        );
      }

      await teamChatService.renameConversation(user.id, chatId, title);

      logger.info(
        `Renamed conversation`,
        { userId: user.id, chatId, title },
        'TeamChatConversationsAPI'
      );

      return NextResponse.json({
        success: true,
        title,
      });
    }

    return NextResponse.json(
      { success: false, error: 'Invalid action' },
      { status: 400 }
    );
  }
);

// =============================================================================
// DELETE: Delete conversation
// =============================================================================

export const DELETE = withErrorHandling(
  async (
    req: NextRequest,
    { params }: { params: Promise<{ chatId: string }> }
  ) => {
    const user = await authenticateUser(req);
    const { chatId } = await params;

    const newActiveChatId = await teamChatService.deleteConversation(
      user.id,
      chatId
    );

    logger.info(
      `Deleted conversation`,
      { userId: user.id, chatId, newActiveChatId },
      'TeamChatConversationsAPI'
    );

    return NextResponse.json({
      success: true,
      newActiveChatId,
    });
  }
);
