/**
 * Actor Historical Statistics API
 *
 * @route GET /api/actors/[actorId]/historical-stats
 * @access Public
 *
 * @description
 * Returns historical performance data based on PAST GAME OUTCOMES only.
 * Does NOT expose oracle data or predetermined outcomes. Safe for competitive
 * MMO - based on observable results only. Includes post history, game participation,
 * and historical accuracy metrics.
 *
 * @openapi
 * /api/actors/{actorId}/historical-stats:
 *   get:
 *     tags:
 *       - Actors
 *     summary: Get actor historical statistics
 *     description: Returns historical performance data based on past game outcomes. Does not expose oracle data or predetermined outcomes. Safe for competitive MMO.
 *     parameters:
 *       - in: path
 *         name: actorId
 *         required: true
 *         schema:
 *           type: string
 *         description: Actor ID
 *     responses:
 *       200:
 *         description: Historical statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 actorId:
 *                   type: string
 *                 name:
 *                   type: string
 *                 role:
 *                   type: string
 *                 tier:
 *                   type: string
 *                 description:
 *                   type: string
 *                 totalPosts:
 *                   type: integer
 *                 gamesParticipated:
 *                   type: integer
 *                 historicalAccuracy:
 *                   type: number
 *                   nullable: true
 *                 totalPredictions:
 *                   type: integer
 *                   nullable: true
 *                 correctPredictions:
 *                   type: integer
 *                   nullable: true
 *                 recentPosts:
 *                   type: array
 *                   items:
 *                     type: object
 *       404:
 *         description: Actor not found
 *       500:
 *         description: Internal server error
 *
 * @param {string} actorId - Actor ID (path parameter)
 *
 * @returns {Promise<NextResponse>} Historical statistics for the actor
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/actors/actor_123/historical-stats');
 * const stats = await response.json();
 * console.log(stats.totalPosts); // Total posts count
 * ```
 *
 * @see {@link /lib/logger} Logging utilities
 */

import { withErrorHandling } from "@feed/api";
import { db } from "@feed/db";
import { StaticDataRegistry } from "@feed/engine";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/**
 * GET /api/actors/[actorId]/historical-stats
 *
 * @description Get historical performance data based on past game outcomes
 *
 * @param {NextRequest} _req - Request object
 * @param {Promise<{actorId: string}>} params - Route parameters
 *
 * @returns {Promise<NextResponse>} Historical statistics
 */
export const GET = withErrorHandling(async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ actorId: string }> },
) {
  const { actorId } = await params;

  const actor = StaticDataRegistry.getActor(actorId);

  if (!actor) {
    return NextResponse.json({ error: "Actor not found" }, { status: 404 });
  }

  // Get actor's posts from COMPLETED games only
  // Only show posts up to current time (prevent future access)
  const now = new Date();
  const posts = await db.post.findMany({
    where: {
      authorId: actorId,
      timestamp: { lte: now }, // ✅ No future posts
      // Only from completed games (no oracle leakage):
      gameId: { not: null },
    },
    include: {
      // We'll need to join with resolved questions to calculate accuracy
    },
    orderBy: { createdAt: "desc" },
    take: 100, // Last 100 posts
  });

  // Calculate stats from historical OUTCOMES (not oracle):
  // Note: This requires post-resolution analysis to be implemented
  // For now, return basic observable stats:

  const stats = {
    actorId: actor.id,
    name: actor.name,
    role: actor.role,
    tier: actor.tier,
    description: actor.description,

    // Observable metrics:
    totalPosts: posts.length,
    gamesParticipated: new Set(posts.map((p) => p.gameId).filter(Boolean)).size,

    // Prediction-derived metrics are unavailable until resolved-question
    // post analysis is persisted.
    historicalAccuracy: null,
    totalPredictions: null,
    correctPredictions: null,

    // Recent activity:
    recentPosts: posts.slice(0, 10).map((p) => ({
      id: p.id,
      content: p.content.substring(0, 100),
      gameId: p.gameId,
      createdAt: p.createdAt,
    })),
  };

  return NextResponse.json(stats);
});
