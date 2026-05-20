/**
 * Post Embed API
 *
 * @route GET /api/embed/post/[id] - Get post embed metadata
 * @access Public
 *
 * @description
 * Returns Farcaster embed metadata for post sharing. Includes post content,
 * author info, interaction counts, and Open Graph data for rich link previews.
 *
 * @openapi
 * /api/embed/post/{id}:
 *   get:
 *     tags:
 *       - Embed
 *     summary: Get post embed metadata
 *     description: Returns Farcaster embed metadata for post sharing (Open Graph)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Post ID
 *     responses:
 *       200:
 *         description: Embed metadata retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 type:
 *                   type: string
 *                   example: post
 *                 version:
 *                   type: string
 *                   example: "1"
 *                 url:
 *                   type: string
 *                 title:
 *                   type: string
 *                 description:
 *                   type: string
 *                 author:
 *                   type: object
 *                   properties:
 *                     name:
 *                       type: string
 *                     username:
 *                       type: string
 *                       nullable: true
 *                 metadata:
 *                   type: object
 *                   properties:
 *                     likeCount:
 *                       type: integer
 *                     commentCount:
 *                       type: integer
 *                     shareCount:
 *                       type: integer
 *                     timestamp:
 *                       type: string
 *                       format: date-time
 *                 image:
 *                   type: string
 *       404:
 *         description: Post not found
 *
 * @example
 * ```typescript
 * const metadata = await fetch(`/api/embed/post/${postId}`)
 *   .then(r => r.json());
 * ```
 *
 * @see {@link https://miniapps.farcaster.xyz/docs/guides/sharing} Farcaster embed docs
 */

import { withErrorHandling } from '@babylon/api';
import { db } from '@babylon/db';
import { StaticDataRegistry } from '@babylon/engine';
import { PostIdParamSchema, toISO } from '@babylon/shared';
import { type NextRequest, NextResponse } from 'next/server';

export const GET = withErrorHandling(async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id: postId } = PostIdParamSchema.parse(await context.params);

  // Fetch post data
  const post = await db.post.findUnique({
    where: { id: postId },
    select: {
      id: true,
      content: true,
      type: true,
      articleTitle: true,
      authorId: true,
      timestamp: true,
      deletedAt: true,
    },
  });

  if (!post || post.deletedAt) {
    return NextResponse.json({ error: 'Post not found' }, { status: 404 });
  }

  // Get interaction counts
  const [likeCount, commentCount, shareCount] = await Promise.all([
    db.reaction.count({ where: { postId, type: 'like' } }),
    db.comment.count({ where: { postId } }),
    db.share.count({ where: { postId } }),
  ]);

  // Get author info - could be User, Actor, or Organization
  let authorName = 'Unknown';
  let authorUsername: string | null = null;

  // Try to find user author
  const userAuthor = await db.user.findUnique({
    where: { id: post.authorId },
    select: { displayName: true, username: true },
  });

  if (userAuthor) {
    authorName = userAuthor.displayName || 'Unknown';
    authorUsername = userAuthor.username || null;
  } else {
    // Check for actor in static registry
    const actor = StaticDataRegistry.getActor(post.authorId);

    if (actor) {
      authorName = actor.name;
    } else {
      // Check for organization in static registry
      const org = StaticDataRegistry.getOrganization(post.authorId);

      if (org) {
        authorName = org.name;
      }
    }
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://babylon.market';
  const postUrl = `${baseUrl}/post/${postId}`;

  // Truncate content for preview
  const previewText =
    post.content.length > 200
      ? post.content.substring(0, 200) + '...'
      : post.content;

  const title =
    post.type === 'article' && post.articleTitle
      ? post.articleTitle
      : `${authorName} on Babylon`;

  // Return Farcaster embed metadata
  return NextResponse.json({
    type: 'post',
    version: '1',
    url: postUrl,
    title,
    description: previewText,
    author: {
      name: authorName,
      username: authorUsername,
    },
    metadata: {
      likeCount,
      commentCount,
      shareCount,
      timestamp: toISO(post.timestamp),
    },
    image: `${baseUrl}/assets/images/og-image.png`,
  });
});
