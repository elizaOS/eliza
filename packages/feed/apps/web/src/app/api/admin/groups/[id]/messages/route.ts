/**
 * Admin Group Messages API
 *
 * @route GET /api/admin/groups/[id]/messages - Get group messages
 * @access Admin
 *
 * @description
 * Returns all messages in a specific group chat for admin verification
 * and debugging. Includes pagination support.
 *
 * @openapi
 * /api/admin/groups/{id}/messages:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Get group messages
 *     description: Returns all messages in a group chat (admin only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Group chat ID
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Messages per page
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *         description: Pagination offset
 *     responses:
 *       200:
 *         description: Messages retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 messages:
 *                   type: array
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       400:
 *         description: Chat is not a group (DM messages not accessible via this endpoint)
 *       404:
 *         description: Group not found
 *
 * @example
 * ```typescript
 * const { messages } = await fetch(`/api/admin/groups/${groupId}/messages`, {
 *   headers: { 'Authorization': `Bearer ${adminToken}` }
 * }).then(r => r.json());
 * ```
 */

import {
  getClientIp,
  logAdminView,
  requireAdmin,
  withErrorHandling,
} from '@babylon/api';
import { db } from '@babylon/db';
import { StaticDataRegistry } from '@babylon/engine';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

/**
 * GET /api/admin/groups/[id]/messages
 * Get all messages in a group chat
 * Admin only
 */
export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    const admin = await requireAdmin(request);
    const { id: chatId } = await context.params;

    // Audit log the admin access
    logAdminView({
      adminId: admin.userId,
      ipAddress: getClientIp(request.headers) ?? undefined,
      resourceType: 'group_messages',
      resourceId: chatId,
      metadata: { action: 'view_group_messages' },
    });

    // Get query parameters
    const { searchParams } = new URL(request.url);
    const limit = Number.parseInt(searchParams.get('limit') || '100');
    const offset = Number.parseInt(searchParams.get('offset') || '0');

    // Get chat details
    const chat = await db.chat.findUnique({
      where: { id: chatId },
      select: {
        id: true,
        name: true,
        isGroup: true,
        createdAt: true,
      },
    });

    if (!chat) {
      return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
    }

    // Ensure this is a group chat, not a DM
    if (!chat.isGroup) {
      return NextResponse.json(
        { error: 'This endpoint is only for group chats' },
        { status: 400 }
      );
    }

    // Get total message count
    const totalMessages = await db.message.count({
      where: { chatId },
    });

    // Get messages with pagination
    const messages = await db.message.findMany({
      where: { chatId },
      orderBy: {
        createdAt: 'desc',
      },
      skip: offset,
      take: limit,
    });

    const senderIds = [...new Set(messages.map((m) => m.senderId))];
    const users = await db.user.findMany({
      where: { id: { in: senderIds } },
      select: {
        id: true,
        username: true,
        displayName: true,
        isActor: true,
        profileImageUrl: true,
      },
    });
    const actors = senderIds
      .map((id) => StaticDataRegistry.getActor(id))
      .filter((a): a is NonNullable<typeof a> => a !== null);

    const enrichedMessages = messages.map((m) => {
      const user = users.find((u) => u.id === m.senderId);
      const actor = actors.find((a) => a.id === m.senderId);

      return {
        id: m.id,
        content: m.content,
        createdAt: m.createdAt,
        sender: {
          id: m.senderId,
          name: user?.displayName || user?.username || actor?.name || 'Unknown',
          username: user?.username || null,
          isNPC: !!actor || user?.isActor,
          profileImageUrl: user?.profileImageUrl || actor?.profileImageUrl,
        },
      };
    });

    return NextResponse.json({
      success: true,
      data: {
        chat: {
          id: chat.id,
          name: chat.name,
          isGroup: chat.isGroup,
          createdAt: chat.createdAt,
        },
        messages: enrichedMessages,
        pagination: {
          total: totalMessages,
          offset,
          limit,
          hasMore: offset + limit < totalMessages,
        },
      },
    });
  }
);
