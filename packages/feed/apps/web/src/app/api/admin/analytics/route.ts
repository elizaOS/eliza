/**
 * Admin Analytics API
 *
 * @route GET /api/admin/analytics - Get analytics time series data
 * @access Admin
 *
 * @description
 * Returns time-series analytics data for the admin dashboard charts.
 * Supports various periods (day, week, month) and metrics.
 *
 * @openapi
 * /api/admin/analytics:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Get analytics data
 *     description: Returns time-series analytics data for charts (admin only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - name: period
 *         in: query
 *         description: Time period granularity for analytics data
 *         schema:
 *           type: string
 *           enum: [day, week, month]
 *           default: week
 *     responses:
 *       200:
 *         description: Analytics data retrieved successfully
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 */

import { requireAdmin, successResponse, withErrorHandling } from '@babylon/api';
import {
  and,
  comments,
  count,
  db,
  follows,
  gte,
  lte,
  posts,
  reactions,
  sql,
  users,
} from '@babylon/db';
import { logger, toISO } from '@babylon/shared';
import type { NextRequest } from 'next/server';

type PeriodType = 'day' | 'week' | 'month';

function getDateRange(period: PeriodType): { start: Date; end: Date } {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  let start: Date;

  switch (period) {
    case 'day':
      start = new Date(end);
      start.setDate(start.getDate() - 7); // Last 7 days for daily view
      break;
    case 'week':
      start = new Date(end);
      start.setDate(start.getDate() - 28); // Last 4 weeks
      break;
    case 'month':
      start = new Date(end);
      start.setMonth(start.getMonth() - 6); // Last 6 months
      break;
    default:
      start = new Date(end);
      start.setDate(start.getDate() - 7);
  }

  return { start, end };
}

function formatDateKey(date: Date, period: PeriodType): string {
  if (period === 'month') {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }
  const isoDate = toISO(date).split('T')[0];
  return isoDate ?? '';
}

const VALID_PERIODS: PeriodType[] = ['day', 'week', 'month'];

export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  const { searchParams } = new URL(request.url);
  const periodParam = searchParams.get('period') || 'week';
  const period: PeriodType = VALID_PERIODS.includes(periodParam as PeriodType)
    ? (periodParam as PeriodType)
    : 'week';

  logger.info(
    'Admin analytics requested',
    { period },
    'GET /api/admin/analytics'
  );

  const { start, end } = getDateRange(period);

  // Maximum data points to prevent memory issues with large datasets
  // (month=6, week=28, day=7 by date range, but we limit to 200 as safety margin)
  const MAX_DATA_POINTS = 200;

  // Execute all queries in parallel for better performance
  const [
    userSignups,
    postsCreated,
    commentsCreated,
    reactionsCreated,
    followsCreated,
  ] = await Promise.all([
    // User signups
    db
      .select({
        date: (period === 'month'
          ? sql<string>`TO_CHAR(DATE_TRUNC('month', ${users.createdAt}), 'YYYY-MM')`
          : sql<string>`DATE(${users.createdAt})`
        ).as('date'),
        count: count(),
      })
      .from(users)
      .where(and(gte(users.createdAt, start), lte(users.createdAt, end)))
      .groupBy(
        period === 'month'
          ? sql`DATE_TRUNC('month', ${users.createdAt})`
          : sql`DATE(${users.createdAt})`
      )
      .orderBy(
        period === 'month'
          ? sql`DATE_TRUNC('month', ${users.createdAt})`
          : sql`DATE(${users.createdAt})`
      )
      .limit(MAX_DATA_POINTS),

    // Posts
    db
      .select({
        date: (period === 'month'
          ? sql<string>`TO_CHAR(DATE_TRUNC('month', ${posts.createdAt}), 'YYYY-MM')`
          : sql<string>`DATE(${posts.createdAt})`
        ).as('date'),
        count: count(),
      })
      .from(posts)
      .where(and(gte(posts.createdAt, start), lte(posts.createdAt, end)))
      .groupBy(
        period === 'month'
          ? sql`DATE_TRUNC('month', ${posts.createdAt})`
          : sql`DATE(${posts.createdAt})`
      )
      .orderBy(
        period === 'month'
          ? sql`DATE_TRUNC('month', ${posts.createdAt})`
          : sql`DATE(${posts.createdAt})`
      )
      .limit(MAX_DATA_POINTS),

    // Comments
    db
      .select({
        date: (period === 'month'
          ? sql<string>`TO_CHAR(DATE_TRUNC('month', ${comments.createdAt}), 'YYYY-MM')`
          : sql<string>`DATE(${comments.createdAt})`
        ).as('date'),
        count: count(),
      })
      .from(comments)
      .where(and(gte(comments.createdAt, start), lte(comments.createdAt, end)))
      .groupBy(
        period === 'month'
          ? sql`DATE_TRUNC('month', ${comments.createdAt})`
          : sql`DATE(${comments.createdAt})`
      )
      .orderBy(
        period === 'month'
          ? sql`DATE_TRUNC('month', ${comments.createdAt})`
          : sql`DATE(${comments.createdAt})`
      )
      .limit(MAX_DATA_POINTS),

    // Reactions
    db
      .select({
        date: (period === 'month'
          ? sql<string>`TO_CHAR(DATE_TRUNC('month', ${reactions.createdAt}), 'YYYY-MM')`
          : sql<string>`DATE(${reactions.createdAt})`
        ).as('date'),
        count: count(),
      })
      .from(reactions)
      .where(
        and(gte(reactions.createdAt, start), lte(reactions.createdAt, end))
      )
      .groupBy(
        period === 'month'
          ? sql`DATE_TRUNC('month', ${reactions.createdAt})`
          : sql`DATE(${reactions.createdAt})`
      )
      .orderBy(
        period === 'month'
          ? sql`DATE_TRUNC('month', ${reactions.createdAt})`
          : sql`DATE(${reactions.createdAt})`
      )
      .limit(MAX_DATA_POINTS),

    // Follows
    db
      .select({
        date: (period === 'month'
          ? sql<string>`TO_CHAR(DATE_TRUNC('month', ${follows.createdAt}), 'YYYY-MM')`
          : sql<string>`DATE(${follows.createdAt})`
        ).as('date'),
        count: count(),
      })
      .from(follows)
      .where(and(gte(follows.createdAt, start), lte(follows.createdAt, end)))
      .groupBy(
        period === 'month'
          ? sql`DATE_TRUNC('month', ${follows.createdAt})`
          : sql`DATE(${follows.createdAt})`
      )
      .orderBy(
        period === 'month'
          ? sql`DATE_TRUNC('month', ${follows.createdAt})`
          : sql`DATE(${follows.createdAt})`
      )
      .limit(MAX_DATA_POINTS),
  ]);

  // Build unified time-series data
  const dateMap = new Map<
    string,
    {
      date: string;
      users: number;
      posts: number;
      comments: number;
      reactions: number;
      follows: number;
    }
  >();

  // Initialize all dates in range
  const currentDate = new Date(start);
  while (currentDate < end) {
    const key = formatDateKey(currentDate, period);
    dateMap.set(key, {
      date: key,
      users: 0,
      posts: 0,
      comments: 0,
      reactions: 0,
      follows: 0,
    });
    if (period === 'month') {
      currentDate.setMonth(currentDate.getMonth() + 1);
    } else {
      currentDate.setDate(currentDate.getDate() + 1);
    }
  }

  // Fill in data from queries
  for (const row of userSignups) {
    const key = row.date;
    const entry = dateMap.get(key);
    if (entry) entry.users = row.count;
  }

  for (const row of postsCreated) {
    const key = row.date;
    const entry = dateMap.get(key);
    if (entry) entry.posts = row.count;
  }

  for (const row of commentsCreated) {
    const key = row.date;
    const entry = dateMap.get(key);
    if (entry) entry.comments = row.count;
  }

  for (const row of reactionsCreated) {
    const key = row.date;
    const entry = dateMap.get(key);
    if (entry) entry.reactions = row.count;
  }

  for (const row of followsCreated) {
    const key = row.date;
    const entry = dateMap.get(key);
    if (entry) entry.follows = row.count;
  }

  // Convert to array, sort, and calculate totals in a single pass for efficiency
  const timeSeries = Array.from(dateMap.values()).sort((a, b) =>
    a.date.localeCompare(b.date)
  );

  // Calculate totals in single pass (more efficient than multiple reduce calls)
  const totals = { users: 0, posts: 0, comments: 0, reactions: 0, follows: 0 };
  for (const d of timeSeries) {
    totals.users += d.users;
    totals.posts += d.posts;
    totals.comments += d.comments;
    totals.reactions += d.reactions;
    totals.follows += d.follows;
  }

  return successResponse({
    period,
    startDate: toISO(start),
    endDate: toISO(end),
    timeSeries,
    totals,
  });
});
