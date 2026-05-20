/**
 * Auto-Generate Feedback API
 *
 * @route POST /api/feedback/auto-generate - Auto-generate feedback
 * @access Public
 *
 * @description
 * Automatically generates feedback for completed games or trades. Calculates
 * performance scores and updates agent metrics. Supports game and trade completion.
 *
 * @openapi
 * /api/feedback/auto-generate:
 *   post:
 *     tags:
 *       - Feedback
 *     summary: Auto-generate feedback
 *     description: Automatically generates feedback for completed games or trades
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             oneOf:
 *               - type: object
 *                 required:
 *                   - type
 *                   - agentId
 *                   - gameId
 *                   - metrics
 *                 properties:
 *                   type:
 *                     type: string
 *                     enum: [game]
 *                   agentId:
 *                     type: string
 *                   gameId:
 *                     type: string
 *                   metrics:
 *                     type: object
 *               - type: object
 *                 required:
 *                   - type
 *                   - agentId
 *                   - tradeId
 *                   - metrics
 *                 properties:
 *                   type:
 *                     type: string
 *                     enum: [trade]
 *                   agentId:
 *                     type: string
 *                   tradeId:
 *                     type: string
 *                   metrics:
 *                     type: object
 *     responses:
 *       200:
 *         description: Feedback generated successfully
 *       400:
 *         description: Invalid input
 *
 * @example
 * ```typescript
 * await fetch('/api/feedback/auto-generate', {
 *   method: 'POST',
 *   body: JSON.stringify({
 *     type: 'game',
 *     agentId: 'agent-id',
 *     gameId: 'game-id',
 *     metrics: { won: true, pnl: 100 }
 *   })
 * });
 * ```
 */

import {
  InternalServerError,
  requireCronAuth,
  requireUserByIdentifier,
  withErrorHandling,
} from '@babylon/api';
import {
  generateGameCompletionFeedback,
  generateTradeCompletionFeedback,
} from '@babylon/engine';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const GameMetricsSchema = z.object({
  won: z.boolean(),
  pnl: z.number(),
  positionsClosed: z.number(),
  finalBalance: z.number(),
  startingBalance: z.number(),
  decisionsCorrect: z.number(),
  decisionsTotal: z.number(),
  timeToComplete: z.number().optional(),
  riskManagement: z.number().optional(),
});

const TradeMetricsSchema = z.object({
  profitable: z.boolean(),
  roi: z.number(),
  holdingPeriod: z.number(),
  timingScore: z.number(),
  riskScore: z.number(),
});

const GameFeedbackRequestSchema = z.object({
  type: z.literal('game'),
  agentId: z.string().min(1),
  gameId: z.string().min(1),
  metrics: GameMetricsSchema,
});

const TradeFeedbackRequestSchema = z.object({
  type: z.literal('trade'),
  agentId: z.string().min(1),
  tradeId: z.string().min(1),
  metrics: TradeMetricsSchema,
});

const AutoGenerateFeedbackRequestSchema = z.discriminatedUnion('type', [
  GameFeedbackRequestSchema,
  TradeFeedbackRequestSchema,
]);

export const POST = withErrorHandling(async (request: NextRequest) => {
  requireCronAuth(request, { jobName: 'AutoGenerateFeedback' });

  const json = await request.json();
  const parsed = AutoGenerateFeedbackRequestSchema.parse(json);

  const body = parsed;

  const agent = await requireUserByIdentifier(body.agentId);

  if (body.type === 'game') {
    const feedback = await generateGameCompletionFeedback(
      agent.id,
      body.gameId,
      body.metrics
    );

    if (!feedback) {
      throw new InternalServerError('Failed to create game feedback');
    }

    return NextResponse.json(
      {
        success: true,
        feedbackId: feedback.id,
        type: 'game',
        score: feedback.score,
        message: 'Game feedback generated successfully',
      },
      { status: 201 }
    );
  }
  const feedback = await generateTradeCompletionFeedback(
    agent.id,
    body.tradeId,
    body.metrics
  );

  if (!feedback) {
    throw new InternalServerError('Failed to create trade feedback');
  }

  return NextResponse.json(
    {
      success: true,
      feedbackId: feedback.id,
      type: 'trade',
      score: feedback.score,
      message: 'Trade feedback generated successfully',
    },
    { status: 201 }
  );
});
