/**
 * Profiles Favorites API
 *
 * @route GET /api/profiles/favorites - Get favorited profiles
 * @access Authenticated
 *
 * @description
 * Returns list of profiles favorited by the authenticated user. Supports
 * pagination.
 *
 * @openapi
 * /api/profiles/favorites:
 *   get:
 *     tags:
 *       - Profiles
 *     summary: Get favorited profiles
 *     description: Returns profiles favorited by authenticated user
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Results per page
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *         description: Pagination offset
 *     responses:
 *       200:
 *         description: Favorites retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 favorites:
 *                   type: array
 *                 pagination:
 *                   type: object
 *       401:
 *         description: Unauthorized
 *
 * @example
 * ```typescript
 * const { favorites } = await fetch('/api/profiles/favorites?limit=20', {
 *   headers: { 'Authorization': `Bearer ${token}` }
 * }).then(r => r.json());
 * ```
 */

import { authenticate, successResponse, withErrorHandling } from "@feed/api";
import { asUser } from "@feed/db";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";
import { z } from "zod";

const FavoritesPaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

/**
 * GET /api/profiles/favorites
 * Get list of profiles the authenticated user has favorited
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const user = await authenticate(request);

  const { searchParams } = new URL(request.url);
  const { page, limit } = FavoritesPaginationSchema.parse({
    page: searchParams.get("page") ?? undefined,
    limit: searchParams.get("limit") ?? undefined,
  });
  const offset = (page - 1) * limit;

  const { profiles: favoritedProfiles, total } = await asUser(
    user,
    async (db) => {
      const [totalFavorites, favorites] = await Promise.all([
        db.favorite.count({
          where: {
            userId: user.userId,
          },
        }),
        db.favorite.findMany({
          where: {
            userId: user.userId,
          },
          orderBy: {
            createdAt: "desc",
          },
          skip: offset,
          take: limit,
        }),
      ]);

      if (favorites.length === 0) {
        return {
          profiles: [],
          total: totalFavorites,
        };
      }

      const targetUserIds = favorites.map((favorite) => favorite.targetUserId);
      const targetUsers = await db.user.findMany({
        where: {
          id: { in: targetUserIds },
        },
        select: {
          id: true,
          displayName: true,
          username: true,
          profileImageUrl: true,
          bio: true,
          isActor: true,
        },
      });
      const userMap = new Map(
        targetUsers.map((targetUser) => [targetUser.id, targetUser]),
      );

      const profiles = await Promise.all(
        favorites.map(async (favorite) => {
          const targetUser = userMap.get(favorite.targetUserId);
          if (!targetUser) return null;

          const [postCount, favoriteCount] = await Promise.all([
            db.post.count({
              where: { authorId: targetUser.id },
            }),
            db.favorite.count({
              where: { targetUserId: targetUser.id },
            }),
          ]);

          return {
            id: targetUser.id,
            displayName: targetUser.displayName,
            username: targetUser.username,
            profileImageUrl: targetUser.profileImageUrl,
            bio: targetUser.bio,
            isActor: targetUser.isActor,
            postCount,
            favoriteCount,
            favoritedAt: favorite.createdAt,
            isFavorited: true,
          };
        }),
      );

      return {
        profiles: profiles.filter(
          (profile): profile is NonNullable<typeof profile> => profile !== null,
        ),
        total: totalFavorites,
      };
    },
  );

  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

  logger.info(
    "Favorited profiles fetched successfully",
    {
      userId: user.userId,
      count: favoritedProfiles.length,
      total,
      page,
      limit,
    },
    "GET /api/profiles/favorites",
  );

  return successResponse({
    profiles: favoritedProfiles,
    total,
    page,
    limit,
    pagination: {
      page,
      limit,
      total,
      totalPages,
    },
  });
});
