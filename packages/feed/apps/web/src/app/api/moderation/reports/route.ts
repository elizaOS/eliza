/**
 * Moderation Reports API
 *
 * @route POST /api/moderation/reports - Submit a user/post report
 * @route GET  /api/moderation/reports - List reports (admin, permission-gated)
 * @access POST: Authenticated | GET: Admin (view_reports)
 *
 * @description
 * POST lets any authenticated user file a report against a user or a post.
 * Reports are persisted to the `Report` table and handed to the existing
 * report-evaluation pipeline for AI triage. GET exposes a permission-gated
 * (`view_reports`) list for admins with filtering + pagination.
 *
 * @openapi
 * /api/moderation/reports:
 *   post:
 *     tags:
 *       - Moderation
 *     summary: Submit a report
 *     description: Files a report against a user or post
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - reportType
 *               - category
 *               - reason
 *             properties:
 *               reportType:
 *                 type: string
 *                 enum: [user, post]
 *               reportedUserId:
 *                 type: string
 *               reportedPostId:
 *                 type: string
 *               category:
 *                 type: string
 *                 enum:
 *                   - spam
 *                   - harassment
 *                   - hate_speech
 *                   - violence
 *                   - misinformation
 *                   - inappropriate
 *                   - impersonation
 *                   - self_harm
 *                   - other
 *               reason:
 *                 type: string
 *                 minLength: 10
 *                 maxLength: 2000
 *               evidence:
 *                 type: string
 *                 format: uri
 *     responses:
 *       201:
 *         description: Report submitted successfully
 *       400:
 *         description: Invalid report payload
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Reported user or post not found
 *   get:
 *     tags:
 *       - Moderation
 *     summary: List reports
 *     description: Permission-gated list of reports (view_reports)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, reviewing, resolved, dismissed]
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *       - in: query
 *         name: priority
 *         schema:
 *           type: string
 *           enum: [low, normal, high, critical]
 *       - in: query
 *         name: reportType
 *         schema:
 *           type: string
 *           enum: [user, post]
 *     responses:
 *       200:
 *         description: Reports retrieved successfully
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Missing view_reports permission
 *
 * @example
 * ```typescript
 * await fetch('/api/moderation/reports', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({
 *     reportType: 'user',
 *     reportedUserId: '123',
 *     category: 'harassment',
 *     reason: 'Repeated abusive DMs...',
 *   }),
 * });
 * ```
 */

import {
  authenticate,
  evaluateReport,
  requirePermission,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import { db } from "@feed/db";
import {
  CreateReportSchema,
  GetReportsSchema,
  generateSnowflakeId,
  logger,
} from "@feed/shared";
import type { NextRequest } from "next/server";

/**
 * Map a report category to a triage priority, mirroring the agent report path
 * (packages/a2a/src/executors/feed-executor.ts).
 */
function priorityForCategory(category: string): "low" | "normal" | "high" {
  if (["hate_speech", "violence", "self_harm"].includes(category)) {
    return "high";
  }
  if (category === "spam") {
    return "low";
  }
  return "normal";
}

export const POST = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);

  const body = await request.json();
  const { reportType, reportedUserId, reportedPostId, category, reason, evidence } =
    CreateReportSchema.parse(body);

  // The report target must match the declared report type so we don't persist
  // a "post" report that only carries a user id (or vice versa).
  if (reportType === "post" && !reportedPostId) {
    return successResponse(
      { success: false, error: "reportedPostId is required for post reports" },
      400,
    );
  }
  if (reportType === "user" && !reportedUserId) {
    return successResponse(
      { success: false, error: "reportedUserId is required for user reports" },
      400,
    );
  }

  // Prevent users from reporting themselves.
  if (reportType === "user" && reportedUserId === authUser.userId) {
    return successResponse(
      { success: false, error: "You cannot report yourself" },
      400,
    );
  }

  // Validate the target actually exists so we don't create dangling reports.
  if (reportType === "user" && reportedUserId) {
    const target = await db.user.findUnique({
      where: { id: reportedUserId },
      select: { id: true },
    });
    if (!target) {
      return successResponse(
        { success: false, error: "Reported user not found" },
        404,
      );
    }
  }

  if (reportType === "post" && reportedPostId) {
    const post = await db.post.findUnique({
      where: { id: reportedPostId },
      select: { id: true },
    });
    if (!post) {
      return successResponse(
        { success: false, error: "Reported post not found" },
        404,
      );
    }
  }

  const report = await db.report.create({
    data: {
      id: await generateSnowflakeId(),
      reporterId: authUser.userId,
      reportedUserId: reportType === "user" ? reportedUserId : null,
      reportedPostId: reportType === "post" ? reportedPostId : null,
      reportType,
      category,
      reason,
      evidence: evidence ?? null,
      priority: priorityForCategory(category),
      status: "pending",
      updatedAt: new Date(),
    },
  });

  // Hand off to the existing AI report-evaluation pipeline. This is best-effort:
  // a failure to evaluate must not fail the user's submission (the report row
  // is already persisted and can be evaluated later by an admin action).
  void evaluateReport(report.id).catch((error) => {
    logger.error(
      "Report evaluation failed",
      { reportId: report.id, error: String(error) },
      "ModerationReports",
    );
  });

  return successResponse({ success: true, report }, 201);
});

export const GET = withErrorHandling(async (request: NextRequest) => {
  // Permission-gated: unauthenticated -> 401 (via authenticate), non-admin or
  // missing view_reports -> 403.
  await requirePermission(request, "view_reports");

  const { searchParams } = new URL(request.url);
  const {
    limit,
    offset,
    status,
    category,
    priority,
    reportType,
    reporterId,
    reportedUserId,
    reportedPostId,
    sortBy,
    sortOrder,
  } = GetReportsSchema.parse({
    limit: searchParams.get("limit") ?? "50",
    offset: searchParams.get("offset") ?? "0",
    status: searchParams.get("status") ?? undefined,
    category: searchParams.get("category") ?? undefined,
    priority: searchParams.get("priority") ?? undefined,
    reportType: searchParams.get("reportType") ?? undefined,
    reporterId: searchParams.get("reporterId") ?? undefined,
    reportedUserId: searchParams.get("reportedUserId") ?? undefined,
    reportedPostId: searchParams.get("reportedPostId") ?? undefined,
    sortBy: searchParams.get("sortBy") ?? undefined,
    sortOrder: searchParams.get("sortOrder") ?? undefined,
  });

  const where = {
    ...(status ? { status } : {}),
    ...(category ? { category } : {}),
    ...(priority ? { priority } : {}),
    ...(reportType ? { reportType } : {}),
    ...(reporterId ? { reporterId } : {}),
    ...(reportedUserId ? { reportedUserId } : {}),
    ...(reportedPostId ? { reportedPostId } : {}),
  };

  const orderByColumn =
    sortBy === "updated"
      ? "updatedAt"
      : sortBy === "priority"
        ? "priority"
        : "createdAt";

  const [reports, total] = await Promise.all([
    db.report.findMany({
      where,
      orderBy: { [orderByColumn]: sortOrder },
      take: limit,
      skip: offset,
    }),
    db.report.count({ where }),
  ]);

  return successResponse({
    reports,
    pagination: {
      limit,
      offset,
      total,
    },
  });
});
