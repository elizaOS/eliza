/**
 * Group Invite Decline API
 *
 * @route POST /api/groups/invites/[inviteId]/decline - Decline group invite
 * @access Authenticated
 */

import {
  ApiError,
  authenticate,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { asUser } from '@feed/db';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';

/**
 * POST /api/groups/invites/[inviteId]/decline
 * Decline a group invitation
 */
export const POST = withErrorHandling(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ inviteId: string }> }
  ) => {
    const user = await authenticate(request);
    const { inviteId } = await params;

    await asUser(user, async (db) => {
      // Get the invite
      const invite = await db.groupInvite.findUnique({
        where: { id: inviteId },
      });

      if (!invite) {
        throw new ApiError('Invite not found', 404);
      }

      if (invite.invitedUserId !== user.userId) {
        throw new ApiError('This invite is not for you', 403);
      }

      if (invite.status !== 'pending') {
        throw new ApiError('This invite has already been processed', 400);
      }

      // Update invite status
      await db.groupInvite.update({
        where: { id: inviteId },
        data: {
          status: 'declined',
          respondedAt: new Date(),
        },
      });

      // Mark only this specific invite's notification as read
      await db.notification.updateMany({
        where: {
          userId: user.userId,
          type: 'group_invite',
          inviteId: inviteId,
        },
        data: {
          read: true,
        },
      });
    });

    logger.info(
      'Group invite declined',
      { userId: user.userId, inviteId },
      'POST /api/groups/invites/:inviteId/decline'
    );

    return successResponse({ success: true });
  }
);
