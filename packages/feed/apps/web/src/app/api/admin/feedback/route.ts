/**
 * Admin Feedback API
 *
 * Provides endpoints for admins to view and manage game feedback submissions.
 */

import {
  errorResponse,
  requireAdmin,
  successResponse,
  withErrorHandling,
} from '@babylon/api';
import {
  and,
  db,
  desc,
  eq,
  feedbacks,
  gte,
  ilike,
  lte,
  sql,
  users,
} from '@babylon/db';
import { FeedbackTypeSchema, toISO } from '@babylon/shared';
import type { NextRequest } from 'next/server';

/** Valid feedback types for SQL filter validation */
const VALID_FEEDBACK_TYPES = FeedbackTypeSchema.options;

interface FeedbackMetadata {
  feedbackType?: string;
  stepsToReproduce?: string | null;
  screenshotUrl?: string | null;
  rating?: number | null;
  linearIssueId?: string | null;
  linearIssueIdentifier?: string | null;
  linearIssueUrl?: string | null;
}

/**
 * Safely parse an integer from a string, returning a default if invalid.
 */
function safeParseInt(value: string | null, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && !Number.isNaN(parsed)
    ? parsed
    : defaultValue;
}

/**
 * Escape SQL ILIKE metacharacters to prevent pattern injection.
 */
function escapeIlike(str: string): string {
  return str.replace(/[%_\\]/g, (char) => `\\${char}`);
}

/**
 * Validate and parse a date string, returning null if invalid.
 */
function parseDate(dateStr: string | null): Date | null {
  if (!dateStr) return null;
  const parsed = new Date(dateStr);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * GET /api/admin/feedback
 *
 * Fetches game feedback submissions with optional filtering.
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  const { searchParams } = new URL(request.url);

  // Safely parse pagination params with fallbacks
  const rawLimit = safeParseInt(searchParams.get('limit'), 50);
  const limit = Math.min(Math.max(rawLimit, 1), 200); // Clamp between 1-200
  const offset = Math.max(safeParseInt(searchParams.get('offset'), 0), 0);

  const feedbackType = searchParams.get('type'); // bug, feature_request, performance
  const hasLinearIssue = searchParams.get('hasLinearIssue'); // true, false
  const search = searchParams.get('search'); // search in comment

  // Validate date params
  const fromDate = parseDate(searchParams.get('fromDate'));
  const toDate = parseDate(searchParams.get('toDate'));

  // Build conditions using SQL for JSON field access
  const conditions = [eq(feedbacks.interactionType, 'general_game_feedback')];

  // CRITICAL: Validate feedbackType against allowed enum values to prevent SQL injection
  if (feedbackType) {
    if (
      !VALID_FEEDBACK_TYPES.includes(
        feedbackType as (typeof VALID_FEEDBACK_TYPES)[number]
      )
    ) {
      return errorResponse(
        'Invalid feedback type',
        'INVALID_FEEDBACK_TYPE',
        400
      );
    }
    conditions.push(
      sql`${feedbacks.metadata}->>'feedbackType' = ${feedbackType}`
    );
  }

  if (hasLinearIssue === 'true') {
    conditions.push(sql`${feedbacks.metadata}->>'linearIssueId' IS NOT NULL`);
  } else if (hasLinearIssue === 'false') {
    conditions.push(sql`${feedbacks.metadata}->>'linearIssueId' IS NULL`);
  }

  if (search) {
    // Escape ILIKE metacharacters to prevent pattern injection
    conditions.push(ilike(feedbacks.comment, `%${escapeIlike(search)}%`));
  }

  if (fromDate) {
    conditions.push(gte(feedbacks.createdAt, fromDate));
  }

  if (toDate) {
    conditions.push(lte(feedbacks.createdAt, toDate));
  }

  // Combine all conditions for reuse in count query
  const whereClause = and(...conditions);

  // Fetch feedback with user info via join
  const feedbackItems = await db
    .select({
      id: feedbacks.id,
      score: feedbacks.score,
      comment: feedbacks.comment,
      metadata: feedbacks.metadata,
      createdAt: feedbacks.createdAt,
      fromUserId: feedbacks.fromUserId,
      user: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        profileImageUrl: users.profileImageUrl,
        email: users.email,
      },
    })
    .from(feedbacks)
    .leftJoin(users, eq(feedbacks.fromUserId, users.id))
    .where(whereClause)
    .orderBy(desc(feedbacks.createdAt))
    .limit(limit)
    .offset(offset);

  // Get total count for pagination - use same filters as main query
  const countResult = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(feedbacks)
    .where(whereClause);
  const totalCount = countResult[0]?.count ?? 0;

  // Get stats by feedback type (unfiltered to show overall distribution)
  const statsResult = await db
    .select({
      feedbackType: sql<string>`${feedbacks.metadata}->>'feedbackType'`,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(feedbacks)
    .where(eq(feedbacks.interactionType, 'general_game_feedback'))
    .groupBy(sql`${feedbacks.metadata}->>'feedbackType'`);

  // Format response
  const formattedFeedback = feedbackItems.map((item) => {
    const metadata = (item.metadata ?? {}) as FeedbackMetadata;
    return {
      id: item.id,
      feedbackType: metadata.feedbackType ?? 'unknown',
      description: item.comment,
      score: item.score,
      rating: metadata.rating,
      stepsToReproduce: metadata.stepsToReproduce,
      screenshotUrl: metadata.screenshotUrl,
      linearIssue: metadata.linearIssueId
        ? {
            id: metadata.linearIssueId,
            identifier: metadata.linearIssueIdentifier,
            url: metadata.linearIssueUrl,
          }
        : null,
      createdAt: toISO(item.createdAt),
      user: item.user?.id
        ? {
            id: item.user.id,
            username: item.user.username,
            displayName: item.user.displayName,
            profileImageUrl: item.user.profileImageUrl,
            email: item.user.email,
          }
        : null,
    };
  });

  return successResponse({
    feedback: formattedFeedback,
    pagination: {
      total: totalCount,
      limit,
      offset,
      hasMore: offset + feedbackItems.length < totalCount,
    },
    stats: {
      total: statsResult.reduce((acc, s) => acc + s.count, 0),
      byType: Object.fromEntries(
        statsResult.map((s) => [s.feedbackType ?? 'unknown', s.count])
      ),
    },
  });
});
