/**
 * Moderation Blocks List API
 *
 * @route GET /api/moderation/blocks - Get blocked users
 * @access Authenticated
 *
 * @description
 * Returns list of users blocked by the current user with pagination support.
 * Includes blocked user details and block metadata.
 *
 * @openapi
 * /api/moderation/blocks:
 *   get:
 *     tags:
 *       - Moderation
 *     summary: Get blocked users
 *     description: Returns list of users blocked by current user
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Results per page
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Pagination offset
 *     responses:
 *       200:
 *         description: Blocks retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 blocks:
 *                   type: array
 *                 pagination:
 *                   type: object
 *       401:
 *         description: Unauthorized
 *
 * @example
 * ```typescript
 * const { blocks } = await fetch('/api/moderation/blocks?limit=20', {
 *   headers: { 'Authorization': `Bearer ${token}` }
 * }).then(r => r.json());
 * ```
 */

import { authenticate, successResponse, withErrorHandling } from "@feed/api";
import { db } from "@feed/db";
import { GetBlocksSchema } from "@feed/shared";
import type { NextRequest } from "next/server";

export const GET = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);

  const { searchParams } = new URL(request.url);
  const { limit, offset } = GetBlocksSchema.parse({
    limit: searchParams.get("limit") || "20",
    offset: searchParams.get("offset") || "0",
  });

  const [blocks, total] = await Promise.all([
    db.userBlock.findMany({
      where: { blockerId: authUser.userId },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      include: {
        blocked: {
          select: {
            id: true,
            username: true,
            displayName: true,
            profileImageUrl: true,
            isActor: true,
          },
        },
      },
    }),
    db.userBlock.count({
      where: { blockerId: authUser.userId },
    }),
  ]);

  return successResponse({
    blocks,
    pagination: {
      limit,
      offset,
      total,
    },
  });
});
