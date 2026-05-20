/**
 * Admin Resolution Review Queue API
 *
 * @route GET /api/admin/resolutions - List pending resolution reviews
 * @access Admin
 *
 * Returns prediction questions that were flagged as low-confidence and require
 * manual review before the market can be resolved.
 */

import { requireAdmin, successResponse, withErrorHandling } from '@babylon/api';
import { and, asc, db, eq, isNull, or, questions } from '@babylon/db';
import { toISOOrNull } from '@babylon/shared';
import type { NextRequest } from 'next/server';

export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  const pending = await db
    .select({
      id: questions.id,
      questionNumber: questions.questionNumber,
      text: questions.text,
      outcome: questions.outcome,
      resolutionDate: questions.resolutionDate,
      resolutionProofUrl: questions.resolutionProofUrl,
      resolutionDescription: questions.resolutionDescription,
      resolutionConfidence: questions.resolutionConfidence,
      resolutionReviewStatus: questions.resolutionReviewStatus,
      requiresManualReview: questions.requiresManualReview,
      updatedAt: questions.updatedAt,
    })
    .from(questions)
    .where(
      and(
        eq(questions.status, 'active'),
        eq(questions.requiresManualReview, true),
        or(
          isNull(questions.resolutionReviewStatus),
          eq(questions.resolutionReviewStatus, 'pending')
        )
      )
    )
    .orderBy(asc(questions.resolutionDate))
    .limit(200);

  return successResponse({
    success: true,
    items: pending.map((q) => ({
      id: q.id,
      questionNumber: q.questionNumber,
      text: q.text,
      outcome: q.outcome,
      resolutionDate: toISOOrNull(q.resolutionDate),
      resolutionProofUrl: q.resolutionProofUrl ?? null,
      resolutionDescription: q.resolutionDescription ?? null,
      resolutionConfidence:
        typeof q.resolutionConfidence === 'number'
          ? q.resolutionConfidence
          : null,
      resolutionReviewStatus: q.resolutionReviewStatus ?? 'pending',
      requiresManualReview: Boolean(q.requiresManualReview),
      updatedAt: toISOOrNull(q.updatedAt),
    })),
    count: pending.length,
  });
});
