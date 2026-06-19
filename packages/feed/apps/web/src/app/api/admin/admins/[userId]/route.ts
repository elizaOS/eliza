/**
 * Admin Management Promote/Demote API
 *
 * @route POST /api/admin/admins/[userId] - Promote/demote admin
 * @access Admin
 *
 * @description
 * Promotes a user to admin or demotes an admin to regular user. Admin only.
 * Cannot demote yourself.
 *
 * @openapi
 * /api/admin/admins/{userId}:
 *   post:
 *     tags:
 *       - Admin
 *     summary: Promote/demote admin
 *     description: Promotes user to admin or demotes admin to user (admin only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID to promote/demote
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - action
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [promote, demote]
 *     responses:
 *       200:
 *         description: Action completed successfully
 *       400:
 *         description: Cannot demote yourself or invalid action
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       404:
 *         description: User not found
 *
 * @example
 * ```typescript
 * await fetch(`/api/admin/admins/${userId}`, {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${adminToken}` },
 *   body: JSON.stringify({ action: 'promote' })
 * });
 * ```
 */

import {
  BusinessLogicError,
  getClientIp,
  logAdminAction,
  NotFoundError,
  requireAdmin,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import { db } from "@feed/db";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";
import { z } from "zod";

const AdminActionSchema = z.object({
  action: z.enum(["promote", "demote"]),
});

export const POST = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> },
  ) => {
    // Require admin authentication
    const adminUser = await requireAdmin(request);

    // Parse params
    const { userId } = await context.params;

    // Parse request body
    const body = await request.json();
    const { action } = AdminActionSchema.parse(body);

    logger.info(
      `Admin ${action} request`,
      {
        adminUserId: adminUser.userId,
        targetUserId: userId,
        action,
      },
      "POST /api/admin/admins/[userId]",
    );

    // Get target user
    const targetUser = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        displayName: true,
        isActor: true,
        isAdmin: true,
        isBanned: true,
      },
    });

    if (!targetUser) {
      throw new NotFoundError("User", userId);
    }

    // Prevent modifying NPC/actors
    if (targetUser.isActor) {
      throw new BusinessLogicError(
        "Cannot modify admin status of game actors",
        "CANNOT_MODIFY_ACTOR",
      );
    }

    // Prevent modifying banned users
    if (targetUser.isBanned) {
      throw new BusinessLogicError(
        "Cannot modify admin status of banned users",
        "USER_BANNED",
      );
    }

    // Validate action makes sense
    if (action === "promote" && targetUser.isAdmin) {
      throw new BusinessLogicError("User is already an admin", "ALREADY_ADMIN");
    }

    if (action === "demote" && !targetUser.isAdmin) {
      throw new BusinessLogicError("User is not an admin", "NOT_ADMIN");
    }

    // Prevent demoting yourself
    if (action === "demote" && targetUser.id === adminUser.userId) {
      throw new BusinessLogicError(
        "Cannot demote yourself",
        "CANNOT_DEMOTE_SELF",
      );
    }

    // Update user admin status
    const updatedUser = await db.user.update({
      where: { id: userId },
      data: {
        isAdmin: action === "promote",
        updatedAt: new Date(),
      },
      select: {
        id: true,
        username: true,
        displayName: true,
        walletAddress: true,
        profileImageUrl: true,
        isAdmin: true,
        hasFarcaster: true,
        hasTwitter: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    logger.info(
      `User ${action}d successfully`,
      {
        adminUserId: adminUser.userId,
        targetUserId: userId,
        targetUsername: updatedUser.username,
        action,
      },
      "POST /api/admin/admins/[userId]",
    );

    // Audit log the privilege change (persist to database)
    // This is a critical security operation that MUST be logged
    logAdminAction(action === "promote" ? "PROMOTE_ADMIN" : "DEMOTE_ADMIN", {
      adminId: adminUser.userId,
      ipAddress: getClientIp(request.headers) ?? undefined,
      resourceType: "user",
      resourceId: userId,
      previousValue: {
        isAdmin: targetUser.isAdmin,
      },
      newValue: {
        isAdmin: action === "promote",
      },
      metadata: {
        targetUsername: updatedUser.username,
        action,
      },
    }).catch((err) => {
      logger.error(
        "Failed to persist critical audit log for privilege change",
        { err, userId, action },
        "POST /api/admin/admins/[userId]",
      );
    });

    return successResponse({
      message: `User ${action}d successfully`,
      user: updatedUser,
      action,
    });
  },
);
