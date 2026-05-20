/**
 * Manual Feedback Submission API
 *
 * @route POST /api/feedback/submit - Submit feedback
 * @access Public
 *
 * @description
 * Allows users to submit feedback manually with star ratings or scores.
 * Supports various feedback categories and optional comments.
 *
 * @openapi
 * /api/feedback/submit:
 *   post:
 *     tags:
 *       - Feedback
 *     summary: Submit feedback
 *     description: Submits manual feedback with star ratings or scores
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - fromUserId
 *               - toUserId
 *             properties:
 *               fromUserId:
 *                 type: string
 *               toUserId:
 *                 type: string
 *               score:
 *                 type: number
 *                 minimum: 0
 *                 maximum: 100
 *                 description: Score (0-100) or converted from stars
 *               stars:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 5
 *                 description: Star rating (1-5, alternative to score)
 *               comment:
 *                 type: string
 *               category:
 *                 type: string
 *                 enum: [trade_performance, game_performance, general]
 *     responses:
 *       200:
 *         description: Feedback submitted successfully
 *       400:
 *         description: Invalid input
 *
 * @example
 * ```typescript
 * await fetch('/api/feedback/submit', {
 *   method: 'POST',
 *   body: JSON.stringify({
 *     fromUserId: 'user-1',
 *     toUserId: 'user-2',
 *     stars: 5,
 *     comment: 'Great trader!'
 *   })
 * });
 * ```
 */

import {
  authenticate,
  BusinessLogicError,
  requireUserByIdentifier,
  withErrorHandling,
} from '@babylon/api';
import { db } from '@babylon/db';
import { updateFeedbackMetrics } from '@babylon/engine';
import { generateSnowflakeId, logger } from '@babylon/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const FeedbackSubmitSchema = z
  .object({
    toUserId: z.string().min(1, 'toUserId is required'),
    score: z.number().min(0).max(100).optional(),
    stars: z.number().int().min(1).max(5).optional(),
    comment: z.string().max(5000).optional(),
    category: z.string().min(1).optional(),
  })
  .refine(({ score, stars }) => score !== undefined || stars !== undefined, {
    message: 'Either score or stars must be provided',
    path: ['score'],
  });

export const POST = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);

  const json = await request.json();
  const parsed = FeedbackSubmitSchema.parse(json);

  const body = parsed;

  const score = body.stars !== undefined ? body.stars * 20 : body.score!;

  const fromUser = await requireUserByIdentifier(authUser.userId);
  const toUser = await requireUserByIdentifier(body.toUserId);

  if (fromUser.id === toUser.id) {
    throw new BusinessLogicError(
      'Cannot submit feedback to yourself',
      'SELF_FEEDBACK'
    );
  }

  const now = new Date();
  const feedback = await db.feedback.create({
    data: {
      id: await generateSnowflakeId(),
      fromUserId: fromUser.id,
      toUserId: toUser.id,
      score,
      comment: body.comment ?? null,
      category: body.category ?? 'general',
      interactionType: 'user_to_agent',
      createdAt: now,
      updatedAt: now,
    },
  });

  logger.info('Feedback submitted successfully', {
    feedbackId: feedback.id,
    fromUserId: fromUser.id,
    toUserId: toUser.id,
    score,
  });

  // Update feedback metrics
  await updateFeedbackMetrics(toUser.id, score, {
    category: body.category ?? 'general',
    interactionType: 'user_to_agent',
  });

  return NextResponse.json(
    {
      success: true,
      feedbackId: feedback.id,
      score,
      message: 'Feedback submitted successfully',
    },
    { status: 201 }
  );
});
