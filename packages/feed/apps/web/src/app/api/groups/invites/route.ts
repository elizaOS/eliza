/**
 * Group Invites API
 *
 * @route GET /api/groups/invites - Get pending group invites
 * @access Authenticated
 */

import { authenticate, successResponse, withErrorHandling } from '@babylon/api';
import { asUser } from '@babylon/db';
import { logger } from '@babylon/shared';
import type { NextRequest } from 'next/server';

/**
 * GET /api/groups/invites
 * Get all pending group invites for the current user
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const user = await authenticate(request);

  const invites = await asUser(user, async (db) => {
    // Get pending invites
    const pendingInvites = await db.groupInvite.findMany({
      where: {
        invitedUserId: user.userId,
        status: 'pending',
      },
      orderBy: {
        invitedAt: 'desc',
      },
    });

    if (pendingInvites.length === 0) {
      return [];
    }

    // Fetch group details
    const groupIds = pendingInvites.map((inv) => inv.groupId);
    const groups = await db.group.findMany({
      where: {
        id: { in: groupIds },
      },
    });

    // Get member counts for each group
    const memberCounts = await Promise.all(
      groupIds.map((gid) =>
        db.groupMember.count({ where: { groupId: gid, isActive: true } })
      )
    );
    const memberCountMap = new Map(
      groupIds.map((gid, i) => [gid, memberCounts[i] ?? 0])
    );
    const groupMap = new Map(groups.map((g) => [g.id, g]));

    return pendingInvites.map((invite) => {
      const group = groupMap.get(invite.groupId);
      return {
        inviteId: invite.id,
        groupId: invite.groupId,
        groupName: group?.name || 'Unknown Group',
        groupDescription: group?.description,
        groupType: group?.type,
        memberCount: memberCountMap.get(invite.groupId) ?? 0,
        invitedAt: invite.invitedAt,
        invitedBy: invite.invitedBy,
        message: invite.message,
      };
    });
  });

  logger.info(
    'Group invites retrieved',
    { userId: user.userId, inviteCount: invites.length },
    'GET /api/groups/invites'
  );

  return successResponse({ invites });
});
