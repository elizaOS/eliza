/**
 * Game-to-Agent Feedback API
 *
 * @route POST /api/feedback/game-to-agent - Submit game feedback for agent
 * @access Public
 *
 * @description
 * Allows games to submit performance feedback for agents. Primary mechanism
 * for rating agent performance in games. Updates agent metrics and reputation.
 *
 * @openapi
 * /api/feedback/game-to-agent:
 *   post:
 *     tags:
 *       - Feedback
 *     summary: Submit game feedback for agent
 *     description: Submits game performance feedback for agent
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - agentId
 *               - gameId
 *               - score
 *               - won
 *             properties:
 *               agentId:
 *                 type: string
 *               gameId:
 *                 type: string
 *               score:
 *                 type: number
 *                 minimum: 0
 *                 maximum: 100
 *               won:
 *                 type: boolean
 *               comment:
 *                 type: string
 *                 maxLength: 5000
 *               metadata:
 *                 type: object
 *     responses:
 *       200:
 *         description: Feedback submitted successfully
 *       400:
 *         description: Invalid input
 *
 * @example
 * ```typescript
 * await fetch('/api/feedback/game-to-agent', {
 *   method: 'POST',
 *   body: JSON.stringify({
 *     agentId: 'agent-id',
 *     gameId: 'game-id',
 *     score: 85,
 *     won: true
 *   })
 * });
 * ```
 */

import {
  requireCronAuth,
  requireUserByIdentifier,
  withErrorHandling,
} from "@feed/api";
import type { JsonValue } from "@feed/db";
import { db } from "@feed/db";
import { updateFeedbackMetrics, updateGameMetrics } from "@feed/engine";
import { generateSnowflakeId, logger } from "@feed/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

const GameFeedbackSchema = z.object({
  agentId: z.string().min(1, "agentId is required"),
  gameId: z.string().min(1, "gameId is required"),
  score: z.number().min(0).max(100),
  won: z.boolean(),
  comment: z.string().max(5000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const POST = withErrorHandling(async (request: NextRequest) => {
  requireCronAuth(request, { jobName: "GameFeedback" });
  const json = await request.json();
  const parsed = GameFeedbackSchema.parse(json);

  const body = parsed;

  const agent = await requireUserByIdentifier(body.agentId);

  // Check if feedback already exists for this game
  const existingFeedback = await db.feedback.findFirst({
    where: {
      toUserId: agent.id,
      gameId: body.gameId,
      interactionType: "game_to_agent",
    },
  });

  if (existingFeedback) {
    logger.warn("Feedback already exists for this game", {
      feedbackId: existingFeedback.id,
      agentId: agent.id,
      gameId: body.gameId,
    });
    return NextResponse.json(
      {
        success: false,
        error: "Feedback already exists for this game",
        feedbackId: existingFeedback.id,
      },
      { status: 409 },
    );
  }

  const now = new Date();
  const feedback = await db.feedback.create({
    data: {
      id: await generateSnowflakeId(),
      toUserId: agent.id,
      score: body.score,
      comment: body.comment,
      gameId: body.gameId,
      interactionType: "game_to_agent",
      metadata: body.metadata as JsonValue | undefined,
      createdAt: now,
      updatedAt: now,
    },
  });

  logger.info("Game feedback created", {
    feedbackId: feedback.id,
    agentId: agent.id,
    gameId: body.gameId,
    score: body.score,
    won: body.won,
  });

  await updateGameMetrics(agent.id, body.score, body.won);
  await updateFeedbackMetrics(agent.id, body.score, {
    category: "game_performance",
    interactionType: "game_to_agent",
  });

  // Agent0 feedback submission removed (Agent0 deleted in Phase 1)
  void (() => {
    logger.debug("Agent0 feedback submission skipped (Agent0 removed)", {
      feedbackId: feedback.id,
      agentId: agent.id,
      gameId: body.gameId,
    });
  });

  const metrics = await db.agentPerformanceMetrics.findUnique({
    where: { userId: agent.id },
    select: {
      reputationScore: true,
      trustLevel: true,
      confidenceScore: true,
      gamesPlayed: true,
      gamesWon: true,
      averageGameScore: true,
      averageFeedbackScore: true,
    },
  });

  return NextResponse.json(
    {
      success: true,
      feedbackId: feedback.id,
      reputation: metrics,
    },
    { status: 201 },
  );
});
