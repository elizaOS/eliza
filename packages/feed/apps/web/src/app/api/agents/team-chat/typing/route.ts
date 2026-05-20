/**
 * Team Chat Typing Indicator API
 *
 * @route POST /api/agents/team-chat/typing - Broadcast typing status
 * @access Authenticated
 *
 * @description
 * Broadcasts typing indicator status to the user's Agents team chat.
 * This allows other participants (and agents) to see when someone is typing.
 */

import { teamChatService } from '@babylon/agents';
import {
  authenticateUser,
  broadcastTypingIndicator,
  checkRateLimitAsync,
  RATE_LIMIT_CONFIGS,
  withErrorHandling,
} from '@babylon/api';
import { db, eq, users } from '@babylon/db';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

/** Request body schema for typing indicator */
const typingSchema = z.object({
  isTyping: z.boolean(),
});

export const POST = withErrorHandling(async function POST(req: NextRequest) {
  const user = await authenticateUser(req);

  // Rate limit typing indicators (more lenient than messages)
  const rateLimitResult = await checkRateLimitAsync(
    user.id,
    RATE_LIMIT_CONFIGS.TYPING_INDICATOR
  );
  if (!rateLimitResult.allowed) {
    return NextResponse.json(
      {
        success: false,
        error: 'Rate limit exceeded',
        retryAfter: rateLimitResult.retryAfter,
      },
      { status: 429 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON in request body' },
      { status: 400 }
    );
  }

  const parseResult = typingSchema.safeParse(body);
  if (!parseResult.success) {
    const firstError = parseResult.error.issues[0];
    return NextResponse.json(
      {
        success: false,
        error: firstError?.message || 'isTyping must be a boolean',
      },
      { status: 400 }
    );
  }

  const { isTyping } = parseResult.data;

  // Get user's team chat
  const teamChat = await teamChatService.getTeamChat(user.id);

  if (!teamChat) {
    return NextResponse.json(
      { success: false, error: 'No team chat exists' },
      { status: 404 }
    );
  }

  // Get user display name
  const [userInfo] = await db
    .select({ displayName: users.displayName, username: users.username })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);

  const displayName = userInfo?.displayName || userInfo?.username || 'User';

  // Broadcast typing indicator
  await broadcastTypingIndicator(
    teamChat.chatId,
    user.id,
    displayName,
    isTyping
  );

  return NextResponse.json({ success: true });
});
