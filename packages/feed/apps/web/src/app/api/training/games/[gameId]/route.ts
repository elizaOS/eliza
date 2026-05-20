/**
 * Training Data API
 *
 * @route GET /api/training/games/[gameId] - Get training data for game
 * @access Public (post-game only)
 *
 * @description
 * Returns full ground truth training data for completed games. Only accessible
 * after all questions are resolved. Used for offline agent training. NOT
 * accessible during active gameplay.
 *
 * @openapi
 * /api/training/games/{gameId}:
 *   get:
 *     tags:
 *       - Training
 *     summary: Get training data for completed game
 *     description: Returns ground truth data for offline training (post-game only)
 *     parameters:
 *       - in: path
 *         name: gameId
 *         required: true
 *         schema:
 *           type: string
 *         description: Game ID
 *     responses:
 *       200:
 *         description: Training data retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 gameId:
 *                   type: string
 *                 questions:
 *                   type: array
 *                 resolvedAt:
 *                   type: string
 *                   format: date-time
 *       403:
 *         description: Game still active - training data not available
 *
 * @example
 * ```typescript
 * const data = await fetch(`/api/training/games/${gameId}`)
 *   .then(r => r.json());
 * ```
 */

import { withErrorHandling } from '@feed/api';
import { db } from '@feed/db';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export const GET = withErrorHandling(async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ gameId: string }> }
) {
  const { gameId } = await params;

  // SECURITY CHECK: Verify game is completed
  // For now, check if all questions for this game are resolved
  const activeQuestions = await db.question.findMany({
    where: {
      // gameId: gameId,  // Add gameId to Question model if not exists
      status: 'active',
    },
  });

  // If any questions still active, game is not complete
  if (activeQuestions.length > 0) {
    logger.warn(
      'Training data requested for active game - rejected',
      {
        gameId,
        activeQuestions: activeQuestions.length,
      },
      'TrainingDataAPI'
    );

    return NextResponse.json(
      {
        error: 'Training data only available for completed games',
        status: 'GAME_ACTIVE',
        message:
          'This game has active questions. Training data will be available after all questions resolve.',
      },
      { status: 403 }
    );
  }

  // Get all resolved questions
  const questions = await db.question.findMany({
    where: {
      status: 'resolved',
    },
    orderBy: { createdDate: 'asc' },
  });

  // Get all posts from this time period, filtered by related question if available
  const questionNumbers = questions.map((q) => q.questionNumber);

  // Handle empty questionNumbers - avoid sending { in: [] } to Prisma
  const posts = await db.post.findMany({
    where: {
      gameId: gameId,
      ...(questionNumbers.length === 0
        ? { relatedQuestion: null } // Only get posts without question association
        : {
            OR: [
              { relatedQuestion: { in: questionNumbers } },
              { relatedQuestion: null }, // Include posts without question association
            ],
          }),
    },
    select: {
      id: true,
      content: true,
      authorId: true,
      gameId: true,
      dayNumber: true,
      sentiment: true,
      createdAt: true,
      relatedQuestion: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  // Collect posts that aren't associated with any question
  const unassociatedPosts = posts.filter((p) => p.relatedQuestion === null);

  // Group posts by question (only include posts with matching relatedQuestion)
  const questionData = questions.map((q) => {
    // Filter posts to those strictly related to this question
    const questionPosts = posts.filter(
      (p) => p.relatedQuestion === q.questionNumber
    );

    return {
      questionId: q.questionNumber,
      questionText: q.text,
      finalOutcome: q.resolvedOutcome, // ✅ Safe - game completed
      createdDate: q.createdDate,
      resolutionDate: q.resolutionDate,

      // Posts with analysis:
      posts: questionPosts.map((p) => ({
        id: p.id,
        content: p.content,
        authorId: p.authorId,
        dayNumber: p.dayNumber,
        sentiment: p.sentiment,

        // For training: was the content's sentiment correct?
        contentSentiment: p.sentiment,
        finalOutcome: q.resolvedOutcome,
        sentimentMatchedOutcome:
          (p.sentiment === 'positive' && q.resolvedOutcome === true) ||
          (p.sentiment === 'negative' && q.resolvedOutcome === false),
      })),
    };
  });

  return NextResponse.json({
    gameId,
    status: 'completed',
    questionsAnalyzed: questions.length,
    totalPosts: posts.length,
    questions: questionData,
    // Posts not associated with any specific question
    unassociatedPosts: unassociatedPosts.map((p) => ({
      id: p.id,
      content: p.content,
      authorId: p.authorId,
      dayNumber: p.dayNumber,
      sentiment: p.sentiment,
    })),

    // Metadata for training:
    trainingMetadata: {
      generatedAt: new Date().toISOString(),
      purpose: 'offline_reinforcement_learning',
      safetyNote: 'This data is only available after game completion',
    },
  });
});
