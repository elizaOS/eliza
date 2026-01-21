/**
 * User Search API
 *
 * @description
 * Search for users by username or display name with fuzzy matching.
 * Returns real users only by default (excludes NPCs, agents, banned users, and current user).
 * Designed for user mention autocomplete, friend finding, and social discovery.
 *
 * **Features:**
 * - Case-insensitive search
 * - Matches username OR display name
 * - Excludes current user (no self-mentions)
 * - Excludes NPCs/actors by default
 * - Excludes agents by default (use includeAgents=true to include)
 * - Excludes banned users
 * - Limits to 20 results (performance)
 * - Alphabetically sorted results
 *
 * **Search Behavior:**
 * - Minimum 2 characters required
 * - Substring matching (contains)
 * - Searches both username and display name fields
 * - Returns empty array if query too short
 *
 * **Use Cases:**
 * - User mention autocomplete (@username)
 * - Friend search
 * - DM recipient selection
 * - Group chat member addition
 * - Follow/unfollow user search
 *
 * @openapi
 * /api/users/search:
 *   get:
 *     tags:
 *       - Users
 *     summary: Search for users
 *     description: Search for users by username or display name (min 2 chars, max 20 results)
 *     security:
 *       - PrivyAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *           minLength: 2
 *         description: Search query (username or display name)
 *         example: alice
 *       - in: query
 *         name: includeAgents
 *         required: false
 *         schema:
 *           type: boolean
 *         description: Include AI agents in results (default false)
 *         example: false
 *     responses:
 *       200:
 *         description: Search results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 users:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       username:
 *                         type: string
 *                       displayName:
 *                         type: string
 *                       profileImageUrl:
 *                         type: string
 *                       bio:
 *                         type: string
 *       401:
 *         description: Unauthorized
 *
 * @example
 * ```typescript
 * // Search for users
 * const response = await fetch('/api/users/search?q=alice', {
 *   headers: { 'Authorization': `Bearer ${token}` }
 * });
 * const { users } = await response.json();
 *
 * // Display in autocomplete
 * users.forEach(user => {
 *   console.log(`@${user.username} - ${user.displayName}`);
 * });
 *
 * // Include agents in search
 * const withAgents = await fetch('/api/users/search?q=alice&includeAgents=true');
 *
 * // Too short query
 * const empty = await fetch('/api/users/search?q=a');
 * // Returns { users: [] }
 * ```
 *
 * @see {@link /lib/db/context} RLS context
 * @see {@link /src/components/MentionAutocomplete} Autocomplete UI
 */

import {
  authenticate,
  successResponse,
  withErrorHandling,
} from "@polyagent/api";
import {
  asUser,
  getBlockedByUserIds,
  getBlockedUserIds,
  getMutedUserIds,
} from "@polyagent/db";
import { logger } from "@polyagent/shared";
import type { NextRequest } from "next/server";

/**
 * GET /api/users/search
 * Search for users by username or display name
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const user = await authenticate(request);

  // Get query parameters
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q");
  const includeAgents = searchParams.get("includeAgents") === "true";

  if (!query || query.trim().length < 2) {
    return successResponse({ users: [] });
  }

  const searchTerm = query.trim().toLowerCase();

  // Get blocked/muted users to exclude from search
  const [blockedIds, mutedIds, blockedByIds] = await Promise.all([
    getBlockedUserIds(user.userId),
    getMutedUserIds(user.userId),
    getBlockedByUserIds(user.userId),
  ]);

  const excludedUserIds = [...blockedIds, ...mutedIds, ...blockedByIds];

  // Search for users (excluding the current user, NPCs, and blocked/muted users)
  // Optionally include AI agents if includeAgents=true
  const users = await asUser(user, async (db) => {
    return await db.user.findMany({
      where: {
        AND: [
          {
            OR: [
              {
                username: {
                  contains: searchTerm,
                  mode: "insensitive",
                },
              },
              {
                displayName: {
                  contains: searchTerm,
                  mode: "insensitive",
                },
              },
            ],
          },
          {
            id: {
              not: user.userId, // Exclude current user
            },
          },
          // Conditionally exclude blocked/muted users only if the array is not empty
          ...(excludedUserIds.length > 0
            ? [{ id: { notIn: excludedUserIds } }]
            : []),
          {
            isActor: false, // Always exclude NPCs (use /api/agents/search for those)
          },
          // Exclude agents unless includeAgents is true
          ...(includeAgents ? [] : [{ isAgent: false }]),
          {
            isBanned: false, // Exclude banned users
          },
        ],
      },
      select: {
        id: true,
        displayName: true,
        username: true,
        profileImageUrl: true,
        bio: true,
      },
      take: 20, // Limit results
      orderBy: [
        {
          username: "asc",
        },
      ],
    });
  });

  logger.info(
    "User search completed",
    {
      userId: user.userId,
      query: searchTerm,
      results: users.length,
      includeAgents,
    },
    "GET /api/users/search",
  );

  return successResponse({
    users,
  });
});
