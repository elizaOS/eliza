/**
 * Agent/NPC Search API
 *
 * @description
 * Search for agents and NPCs by username or display name with fuzzy matching.
 * Returns AI agents (isAgent=true) and NPC actors (isActor=true).
 * Designed for group chat member addition and social discovery.
 *
 * **Features:**
 * - Case-insensitive search
 * - Matches username OR display name
 * - Excludes current user
 * - Excludes banned users
 * - Limits to 20 results (performance)
 * - Alphabetically sorted results
 * - Returns type indicator (agent vs npc)
 *
 * **Search Behavior:**
 * - Minimum 2 characters required
 * - Substring matching (contains)
 * - Searches both username and display name fields
 * - Returns empty array if query too short
 *
 * **Use Cases:**
 * - Group chat member addition (agents/NPCs tab)
 * - Agent discovery
 * - NPC search for interaction
 *
 * @openapi
 * /api/agents/search:
 *   get:
 *     tags:
 *       - Agents
 *     summary: Search for agents and NPCs
 *     description: Search for agents/NPCs by username or display name (min 2 chars, max 20 results)
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
 *         example: trading
 *     responses:
 *       200:
 *         description: Search results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 agents:
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
 *                       type:
 *                         type: string
 *                         enum: [agent, npc]
 *       401:
 *         description: Unauthorized
 *
 * @example
 * ```typescript
 * // Search for agents/NPCs
 * const response = await fetch('/api/agents/search?q=trading', {
 *   headers: { 'Authorization': `Bearer ${token}` }
 * });
 * const { agents } = await response.json();
 *
 * // Display in search results
 * agents.forEach(agent => {
 *   console.log(`${agent.displayName} (${agent.type})`);
 * });
 * ```
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

/** Maximum number of search results to return */
const AGENT_SEARCH_LIMIT = 20;

/** Maximum length for search query input */
const MAX_QUERY_LENGTH = 100;

/**
 * GET /api/agents/search
 * Search for agents and NPCs by username or display name
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const user = await authenticate(request);

  // Get query parameter
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q");

  if (!query || query.trim().length < 2) {
    return successResponse({ agents: [] });
  }

  // Cap query length to prevent abuse
  const searchTerm = query.trim().toLowerCase().slice(0, MAX_QUERY_LENGTH);

  // Get blocked/muted users to exclude from search
  const [blockedIds, mutedIds, blockedByIds] = await Promise.all([
    getBlockedUserIds(user.userId),
    getMutedUserIds(user.userId),
    getBlockedByUserIds(user.userId),
  ]);

  const excludedUserIds = [...blockedIds, ...mutedIds, ...blockedByIds];

  // Search for agents (isAgent=true) and NPCs (isActor=true)
  const agents = await asUser(user, async (db) => {
    const results = await db.user.findMany({
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
          // Only add notIn clause if there are users to exclude
          ...(excludedUserIds.length > 0
            ? [{ id: { notIn: excludedUserIds } }]
            : []),
          {
            // Include agents OR NPCs (non-human participants)
            OR: [{ isAgent: true }, { isActor: true }],
          },
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
        isAgent: true,
        isActor: true,
      },
      take: AGENT_SEARCH_LIMIT,
      orderBy: [
        {
          username: "asc",
        },
      ],
    });

    // Add type indicator for each result
    return results.map((result) => ({
      id: result.id,
      displayName: result.displayName,
      username: result.username,
      profileImageUrl: result.profileImageUrl,
      bio: result.bio,
      // Determine type: prefer 'npc' if isActor, otherwise 'agent'
      type: result.isActor ? "npc" : "agent",
    }));
  });

  logger.info(
    "Agent/NPC search completed",
    { userId: user.userId, query: searchTerm, results: agents.length },
    "GET /api/agents/search",
  );

  return successResponse({
    agents,
  });
});
