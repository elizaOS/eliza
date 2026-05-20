/**
 * Admin Content Moderation Queue API
 *
 * @route GET /api/admin/content-queue - Get flagged content for review
 * @access Admin
 *
 * @description
 * Returns posts and comments that have been reported for moderation review.
 * Supports filtering by content type and status.
 *
 * PERFORMANCE: Uses JOIN with GROUP BY for report counts instead of subqueries
 * to avoid N+1 query patterns at scale.
 */

import { requireAdmin, successResponse, withErrorHandling } from '@feed/api';
import {
  and,
  comments,
  count,
  db,
  desc,
  eq,
  isNull,
  posts,
  reports,
  sql,
  users,
} from '@feed/db';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

// Allowed image URL domains for content moderation display
const ALLOWED_IMAGE_DOMAINS = [
  'images.unsplash.com',
  'picsum.photos',
  'cloudinary.com',
  'res.cloudinary.com',
  'feed-storage.s3.amazonaws.com',
  'storage.googleapis.com',
  'cdn.feed.market',
];

/**
 * Validate and sanitize image URL
 * Returns null for invalid/non-HTTPS/non-allowlisted URLs to prevent XSS/SSRF attacks
 */
function sanitizeImageUrl(url: string | null): string | null {
  if (!url) return null;

  const parsed = new URL(url); // Let it throw on invalid URL - handled at API boundary

  if (parsed.protocol !== 'https:') {
    logger.warn('Non-HTTPS image URL rejected', { url }, 'sanitizeImageUrl');
    return null;
  }

  const isAllowedDomain = ALLOWED_IMAGE_DOMAINS.some(
    (domain) =>
      parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`)
  );

  if (!isAllowedDomain) {
    logger.warn(
      `Image URL from non-allowlisted domain rejected: ${parsed.hostname}`,
      { url },
      'sanitizeImageUrl'
    );
    return null; // Enforce allowlist for security
  }

  return url;
}

const ContentQueueQuerySchema = z.object({
  type: z.enum(['all', 'posts', 'comments']).default('all'),
  status: z.enum(['pending', 'resolved']).default('pending'),
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().min(0).max(1000).default(0), // Max offset prevents scanning entire dataset
});

export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  const { searchParams } = new URL(request.url);

  // Validate query parameters with Zod
  const parseResult = ContentQueueQuerySchema.safeParse({
    type: searchParams.get('type') || undefined,
    status: searchParams.get('status') || undefined,
    limit: searchParams.get('limit') || undefined,
    offset: searchParams.get('offset') || undefined,
  });

  if (!parseResult.success) {
    return successResponse(
      {
        error: 'Invalid query parameters',
        details: parseResult.error.flatten(),
      },
      400
    );
  }

  const { type: contentType, status, limit, offset } = parseResult.data;

  logger.info(
    'Content queue requested',
    { contentType, status, limit, offset },
    'GET /api/admin/content-queue'
  );

  // Get reported posts with report counts using JOIN + GROUP BY (optimized, no N+1)
  const reportedPosts =
    contentType === 'comments'
      ? []
      : await db
          .select({
            id: posts.id,
            content: posts.content,
            createdAt: posts.createdAt,
            deletedAt: posts.deletedAt,
            authorId: posts.authorId,
            imageUrl: posts.imageUrl,
            authorUsername: users.username,
            authorDisplayName: users.displayName,
            authorProfileImage: users.profileImageUrl,
            authorIsActor: users.isActor,
            reportCount: count(reports.id),
          })
          .from(posts)
          .innerJoin(users, eq(posts.authorId, users.id))
          .innerJoin(
            reports,
            and(
              eq(reports.reportedPostId, posts.id),
              eq(reports.status, status)
            )
          )
          .where(status === 'pending' ? isNull(posts.deletedAt) : undefined)
          .groupBy(
            posts.id,
            posts.content,
            posts.createdAt,
            posts.deletedAt,
            posts.authorId,
            posts.imageUrl,
            users.username,
            users.displayName,
            users.profileImageUrl,
            users.isActor
          )
          .orderBy(desc(posts.createdAt))
          .limit(limit)
          .offset(offset);

  // Get reported comments with report counts using JOIN + GROUP BY
  const reportedComments =
    contentType === 'posts'
      ? []
      : await db
          .select({
            id: comments.id,
            content: comments.content,
            createdAt: comments.createdAt,
            deletedAt: comments.deletedAt,
            postId: comments.postId,
            authorId: comments.authorId,
            authorUsername: users.username,
            authorDisplayName: users.displayName,
            authorProfileImage: users.profileImageUrl,
            authorIsActor: users.isActor,
            reportCount: count(reports.id),
          })
          .from(comments)
          .innerJoin(users, eq(comments.authorId, users.id))
          .innerJoin(
            reports,
            and(
              eq(reports.reportedCommentId, comments.id),
              eq(reports.status, status)
            )
          )
          .where(status === 'pending' ? isNull(comments.deletedAt) : undefined)
          .groupBy(
            comments.id,
            comments.content,
            comments.createdAt,
            comments.deletedAt,
            comments.postId,
            comments.authorId,
            users.username,
            users.displayName,
            users.profileImageUrl,
            users.isActor
          )
          .orderBy(desc(comments.createdAt))
          .limit(limit)
          .offset(offset);

  // Get queue stats using efficient aggregation
  const [postStats] = await db
    .select({
      pending: sql<number>`COUNT(DISTINCT ${posts.id}) FILTER (WHERE ${posts.deletedAt} IS NULL)`,
      deleted: sql<number>`COUNT(DISTINCT ${posts.id}) FILTER (WHERE ${posts.deletedAt} IS NOT NULL)`,
    })
    .from(posts)
    .innerJoin(
      reports,
      and(eq(reports.reportedPostId, posts.id), eq(reports.status, 'pending'))
    );

  // Get comment stats using efficient aggregation (separate from paginated results)
  const [commentStats] = await db
    .select({
      pending: sql<number>`COUNT(DISTINCT ${comments.id}) FILTER (WHERE ${comments.deletedAt} IS NULL)`,
      deleted: sql<number>`COUNT(DISTINCT ${comments.id}) FILTER (WHERE ${comments.deletedAt} IS NOT NULL)`,
    })
    .from(comments)
    .innerJoin(
      reports,
      and(
        eq(reports.reportedCommentId, comments.id),
        eq(reports.status, 'pending')
      )
    );

  return successResponse({
    posts: reportedPosts.map((p) => {
      const sanitizedImage = sanitizeImageUrl(p.imageUrl);
      return {
        ...p,
        type: 'post' as const,
        isHidden: p.deletedAt !== null,
        reactionCount: 0,
        commentCount: 0,
        mediaUrls: sanitizedImage ? [sanitizedImage] : [],
      };
    }),
    comments: reportedComments.map((c) => ({
      ...c,
      type: 'comment' as const,
      isHidden: c.deletedAt !== null,
      reactionCount: 0,
    })),
    stats: {
      posts: {
        pending: Number(postStats?.pending ?? 0),
        hidden: Number(postStats?.deleted ?? 0),
      },
      comments: {
        pending: Number(commentStats?.pending ?? 0),
        hidden: Number(commentStats?.deleted ?? 0),
      },
      totalPending:
        Number(postStats?.pending ?? 0) + Number(commentStats?.pending ?? 0),
    },
  });
});
