/**
 * Admin Content Moderation Action API
 *
 * @route POST /api/admin/content-queue/[contentId] - Moderate content
 * @access Admin
 *
 * @description
 * Performs moderation actions on flagged content (approve, hide, delete).
 * Uses soft delete (deletedAt) for hiding content.
 */

import {
  checkRateLimitAndDuplicates,
  logAdminModify,
  RATE_LIMIT_CONFIGS,
  requireAdmin,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { comments, db, eq, posts, reports, withTransaction } from '@feed/db';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

/**
 * Moderation action types:
 * - approve: Mark content as reviewed and acceptable, dismiss associated reports
 * - hide: Soft delete content (set deletedAt), keeps data for potential recovery
 *
 * NOTE: "delete" was removed as it was redundant with "hide". Both performed
 * soft deletes. If hard delete is needed in the future, it should be a
 * separate, more privileged action with additional safeguards.
 */
const ModerateRequestSchema = z.object({
  action: z.enum(['approve', 'hide']),
  contentType: z.enum(['post', 'comment']),
  reason: z.string().max(500).optional(), // Max 500 chars for reason
});

/**
 * Get real client IP address from x-forwarded-for header
 * Takes the last IP in the chain which is the most reliable (added by our proxy)
 */
function getClientIp(request: NextRequest): string | undefined {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (!forwardedFor) return undefined;
  // Take the last IP (most reliable - added by our reverse proxy)
  return forwardedFor
    .split(',')
    .map((s) => s.trim())
    .pop();
}

export const POST = withErrorHandling(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ contentId: string }> }
  ) => {
    const admin = await requireAdmin(request);

    // Rate limit admin actions to prevent abuse
    const rateLimitResponse = checkRateLimitAndDuplicates(
      admin.userId,
      null,
      RATE_LIMIT_CONFIGS.ADMIN_ACTION
    );
    if (rateLimitResponse) return rateLimitResponse;

    const { contentId } = await params;

    // Validate request body with Zod schema
    const parseResult = ModerateRequestSchema.safeParse(await request.json());
    if (!parseResult.success) {
      return successResponse(
        { error: 'Invalid request', details: parseResult.error.flatten() },
        400
      );
    }
    const { action, contentType, reason } = parseResult.data;

    logger.info(
      'Content moderation action',
      { contentId, action, contentType, adminId: admin.userId },
      'POST /api/admin/content-queue/[contentId]'
    );

    if (contentType === 'post') {
      // Handle post moderation
      const [existingPost] = await db
        .select({ id: posts.id, deletedAt: posts.deletedAt })
        .from(posts)
        .where(eq(posts.id, contentId))
        .limit(1);

      if (!existingPost) {
        return successResponse({ error: 'Post not found' }, 404);
      }

      const clientIp = getClientIp(request);
      const userAgent = request.headers.get('user-agent') ?? undefined;

      if (action === 'approve') {
        // Mark reports as dismissed
        await db
          .update(reports)
          .set({
            status: 'dismissed',
            resolution: 'Content approved by admin',
            resolvedBy: admin.userId,
            resolvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(reports.reportedPostId, contentId));

        await logAdminModify({
          adminId: admin.userId,
          resourceType: 'post',
          resourceId: contentId,
          previousValue: { status: 'pending' },
          newValue: { status: 'approved' },
          ipAddress: clientIp,
          userAgent,
          metadata: { action: 'approve' },
        });
      } else if (action === 'hide') {
        // Use transaction to ensure atomic update of content + reports
        await withTransaction(async (tx) => {
          // Soft delete by setting deletedAt (content can be recovered if needed)
          await tx
            .update(posts)
            .set({ deletedAt: new Date() })
            .where(eq(posts.id, contentId));

          // Mark reports as resolved
          await tx
            .update(reports)
            .set({
              status: 'resolved',
              resolution: reason || 'Content hidden by admin',
              resolvedBy: admin.userId,
              resolvedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(reports.reportedPostId, contentId));
        });

        await logAdminModify({
          adminId: admin.userId,
          resourceType: 'post',
          resourceId: contentId,
          previousValue: { deletedAt: null },
          newValue: {
            deletedAt: new Date().toISOString(),
            reason: reason ?? null,
          },
          ipAddress: clientIp,
          userAgent,
          metadata: { action: 'hide' },
        });
      }
    } else if (contentType === 'comment') {
      // Handle comment moderation
      const [existingComment] = await db
        .select({
          id: comments.id,
          deletedAt: comments.deletedAt,
          postId: comments.postId,
        })
        .from(comments)
        .where(eq(comments.id, contentId))
        .limit(1);

      if (!existingComment) {
        return successResponse({ error: 'Comment not found' }, 404);
      }

      const clientIp = getClientIp(request);
      const userAgent = request.headers.get('user-agent') ?? undefined;

      if (action === 'approve') {
        // Dismiss reports for this comment
        await db
          .update(reports)
          .set({
            status: 'dismissed',
            resolution: 'Comment approved by admin',
            resolvedBy: admin.userId,
            resolvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(reports.reportedCommentId, contentId));

        await logAdminModify({
          adminId: admin.userId,
          resourceType: 'comment',
          resourceId: contentId,
          previousValue: { status: 'pending' },
          newValue: { status: 'approved' },
          ipAddress: clientIp,
          userAgent,
          metadata: { action: 'approve' },
        });
      } else if (action === 'hide') {
        // Use transaction to ensure atomic update of content + reports
        await withTransaction(async (tx) => {
          // Soft delete by setting deletedAt (content can be recovered if needed)
          await tx
            .update(comments)
            .set({
              deletedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(comments.id, contentId));

          // Mark reports as resolved (matching post hide behavior)
          await tx
            .update(reports)
            .set({
              status: 'resolved',
              resolution: reason || 'Comment hidden by admin',
              resolvedBy: admin.userId,
              resolvedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(reports.reportedCommentId, contentId));
        });

        await logAdminModify({
          adminId: admin.userId,
          resourceType: 'comment',
          resourceId: contentId,
          previousValue: { deletedAt: null },
          newValue: {
            deletedAt: new Date().toISOString(),
            reason: reason ?? null,
          },
          ipAddress: clientIp,
          userAgent,
          metadata: { action: 'hide' },
        });
      }
    }

    return successResponse({
      success: true,
      action,
      contentId,
      contentType,
    });
  }
);
