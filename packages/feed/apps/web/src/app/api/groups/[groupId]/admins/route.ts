/**
 * Group Admins Management API
 *
 * @route POST /api/groups/[groupId]/admins - Promote member to admin
 * @route DELETE /api/groups/[groupId]/admins - Demote admin to member
 * @access Authenticated (group admin/owner only)
 */

import {
  ApiError,
  authenticate,
  successResponse,
  withErrorHandling,
} from '@babylon/api';
import { asUser } from '@babylon/db';
import { logger } from '@babylon/shared';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

const PromoteAdminSchema = z.object({
  userId: z.string(),
});

/**
 * POST /api/groups/[groupId]/admins
 * Promote a member to admin (admin/owner only)
 */
export const POST = withErrorHandling(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ groupId: string }> }
  ) => {
    const user = await authenticate(request);
    const { groupId } = await params;
    const body = await request.json();
    const data = PromoteAdminSchema.parse(body);

    await asUser(user, async (db) => {
      // Check if user is admin or owner
      const userMembership = await db.groupMember.findFirst({
        where: {
          groupId,
          userId: user.userId,
          isActive: true,
        },
      });

      if (
        !userMembership ||
        !['admin', 'owner'].includes(userMembership.role)
      ) {
        throw new ApiError(
          'Only group admins can promote members to admin',
          403
        );
      }

      // Get target user's membership
      const targetMembership = await db.groupMember.findFirst({
        where: {
          groupId,
          userId: data.userId,
          isActive: true,
        },
      });

      if (!targetMembership) {
        throw new ApiError('User must be a member of the group', 400);
      }

      if (targetMembership.role === 'admin') {
        throw new ApiError('User is already an admin', 400);
      }

      if (targetMembership.role === 'owner') {
        throw new ApiError('Cannot change owner role', 400);
      }

      // Promote to admin by updating role
      await db.groupMember.update({
        where: { id: targetMembership.id },
        data: { role: 'admin' },
      });
    });

    logger.info(
      'Member promoted to admin',
      { userId: user.userId, groupId, promotedUserId: data.userId },
      'POST /api/groups/:groupId/admins'
    );

    return successResponse({ success: true });
  }
);

/**
 * DELETE /api/groups/[groupId]/admins
 * Demote admin to member (admin/owner only)
 */
export const DELETE = withErrorHandling(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ groupId: string }> }
  ) => {
    const user = await authenticate(request);
    const { groupId } = await params;
    const { searchParams } = new URL(request.url);
    const userIdToDemote = searchParams.get('userId');

    if (!userIdToDemote) {
      throw new ApiError('userId parameter is required', 400);
    }

    await asUser(user, async (db) => {
      // Check if user is admin or owner
      const userMembership = await db.groupMember.findFirst({
        where: {
          groupId,
          userId: user.userId,
          isActive: true,
        },
      });

      if (
        !userMembership ||
        !['admin', 'owner'].includes(userMembership.role)
      ) {
        throw new ApiError('Only group admins can demote admins', 403);
      }

      // Get target user's membership
      const targetMembership = await db.groupMember.findFirst({
        where: {
          groupId,
          userId: userIdToDemote,
          isActive: true,
        },
      });

      if (!targetMembership) {
        throw new ApiError('User is not a member of this group', 404);
      }

      if (targetMembership.role === 'owner') {
        throw new ApiError('Cannot demote the group owner', 400);
      }

      if (targetMembership.role === 'member') {
        throw new ApiError('User is not an admin', 400);
      }

      // Demote to member by updating role
      await db.groupMember.update({
        where: { id: targetMembership.id },
        data: { role: 'member' },
      });
    });

    logger.info(
      'Admin demoted to member',
      { userId: user.userId, groupId, demotedUserId: userIdToDemote },
      'DELETE /api/groups/:groupId/admins'
    );

    return successResponse({ success: true });
  }
);
