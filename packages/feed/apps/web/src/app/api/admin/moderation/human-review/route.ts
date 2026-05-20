/**
 * Admin Moderation Human Review API
 *
 * @route GET /api/admin/moderation/human-review - Get appeals for review
 * @access Admin
 *
 * @description
 * Returns list of user appeals that need human review. Shows banned users
 * with appeal status 'human_review' and their appeal details.
 *
 * @openapi
 * /api/admin/moderation/human-review:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Get appeals for human review
 *     description: Returns appeals needing human review (admin only)
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Appeals retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 appeals:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       username:
 *                         type: string
 *                       bannedAt:
 *                         type: string
 *                         format: date-time
 *                       appealStaked:
 *                         type: number
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *
 * @example
 * ```typescript
 * const { appeals } = await fetch('/api/admin/moderation/human-review', {
 *   headers: { 'Authorization': `Bearer ${adminToken}` }
 * }).then(r => r.json());
 * ```
 */

import { requireAdmin, successResponse, withErrorHandling } from "@feed/api";
import { db } from "@feed/db";
import type { NextRequest } from "next/server";

export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  const appeals = await db.user.findMany({
    where: {
      appealStatus: "human_review",
      isBanned: true,
    },
    select: {
      id: true,
      username: true,
      displayName: true,
      profileImageUrl: true,
      bannedAt: true,
      bannedReason: true,
      bannedBy: true,
      isScammer: true,
      isCSAM: true,
      appealCount: true,
      appealStaked: true,
      appealStakeAmount: true,
      appealStakeTxHash: true,
      appealSubmittedAt: true,
      falsePositiveHistory: true,
      earnedPoints: true,
      totalDeposited: true,
      totalWithdrawn: true,
      lifetimePnL: true,
    },
    orderBy: {
      appealSubmittedAt: "asc", // Oldest first
    },
  });

  return successResponse({ appeals });
});
