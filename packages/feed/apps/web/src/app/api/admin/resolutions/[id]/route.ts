/**
 * Admin Resolution Review Action API
 *
 * @route POST /api/admin/resolutions/[id] - Approve or reject a pending resolution
 * @access Admin
 */

import {
  checkRateLimitAndDuplicates,
  errorResponse,
  RATE_LIMIT_CONFIGS,
  requireAdmin,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import { db, eq, questions } from "@feed/db";
import { logger, toISO } from "@feed/shared";
import type { NextRequest } from "next/server";
import { z } from "zod";

/** Hours to postpone resolution after rejection (default: 24h) */
const POSTPONE_HOURS = (() => {
  const val = Number(process.env.RESOLUTION_POSTPONE_HOURS);
  return Number.isFinite(val) && val > 0 ? val : 24;
})();

const ParamsSchema = z.object({
  id: z.string().min(1),
});

const BodySchema = z.object({
  action: z.enum(["approve", "reject"]),
});

export const POST = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => {
    const admin = await requireAdmin(request);

    // Rate limit admin actions to prevent accidental rapid-fire approvals/rejections
    const rateLimitResponse = checkRateLimitAndDuplicates(
      admin.userId,
      null,
      RATE_LIMIT_CONFIGS.ADMIN_ACTION,
    );
    if (rateLimitResponse) return rateLimitResponse;

    const { id } = ParamsSchema.parse(await context.params);
    const { action } = BodySchema.parse(await request.json());

    const [existing] = await db
      .select({
        id: questions.id,
        questionNumber: questions.questionNumber,
        status: questions.status,
        requiresManualReview: questions.requiresManualReview,
        resolutionReviewStatus: questions.resolutionReviewStatus,
      })
      .from(questions)
      .where(eq(questions.id, id))
      .limit(1);

    if (!existing) {
      return errorResponse("Question not found", "NOT_FOUND", 404);
    }

    // Validate the question is in a valid state for review
    if (existing.status !== "active") {
      return errorResponse(
        "Question is not active and cannot be reviewed",
        "INVALID_STATE",
        400,
      );
    }

    if (!existing.requiresManualReview) {
      return errorResponse(
        "Question does not require manual review",
        "NOT_REVIEWABLE",
        400,
      );
    }

    if (existing.resolutionReviewStatus === "approved") {
      return errorResponse(
        "Question already approved",
        "ALREADY_APPROVED",
        400,
      );
    }

    const now = new Date();

    if (action === "approve") {
      await db
        .update(questions)
        .set({
          resolutionReviewStatus: "approved",
          resolutionReviewedAt: now,
          resolutionReviewedBy: admin.userId,
          updatedAt: now,
        })
        .where(eq(questions.id, id));

      logger.info(
        "Resolution approved",
        {
          questionId: id,
          questionNumber: existing.questionNumber,
          reviewedBy: admin.userId,
        },
        "AdminResolutions",
      );

      return successResponse({ success: true });
    }

    // Reject: clear the review flag and postpone resolution to avoid immediate retry loops.
    const postponed = new Date(now.getTime() + POSTPONE_HOURS * 60 * 60 * 1000);

    await db
      .update(questions)
      .set({
        requiresManualReview: false,
        resolutionReviewStatus: "rejected",
        resolutionReviewedAt: now,
        resolutionReviewedBy: admin.userId,
        resolutionConfidence: null,
        resolutionProofUrl: null,
        resolutionDescription: null,
        resolutionDate: postponed,
        updatedAt: now,
      })
      .where(eq(questions.id, id));

    logger.info(
      "Resolution rejected",
      {
        questionId: id,
        questionNumber: existing.questionNumber,
        reviewedBy: admin.userId,
        postponedUntil: toISO(postponed),
      },
      "AdminResolutions",
    );

    return successResponse({
      success: true,
      postponedUntil: toISO(postponed),
    });
  },
);
