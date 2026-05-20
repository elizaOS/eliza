/**
 * Trending Tags Widget API
 *
 * @route GET /api/feed/widgets/trending - Get trending tags
 * @access Public
 *
 * @description
 * Returns current trending tags with post counts, summaries, and recent post
 * samples. Uses cached trending data from tag storage service. Includes AI-generated
 * summaries for each trending tag. Groups related tags together using LLM analysis.
 *
 * @openapi
 * /api/feed/widgets/trending:
 *   get:
 *     tags:
 *       - Feed
 *     summary: Get trending tags (grouped)
 *     description: Returns current trending tags with summaries and post counts, intelligently grouped
 *     responses:
 *       200:
 *         description: Trending tags retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 trending:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       tags:
 *                         type: array
 *                         items:
 *                           type: string
 *                       tagSlugs:
 *                         type: array
 *                         items:
 *                           type: string
 *                       tagIds:
 *                         type: array
 *                         items:
 *                           type: string
 *                       category:
 *                         type: string
 *                       totalPostCount:
 *                         type: integer
 *                       summary:
 *                         type: string
 *                       rank:
 *                         type: integer
 *                 message:
 *                   type: string
 *                   nullable: true
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/feed/widgets/trending');
 * const { trending } = await response.json();
 * // trending[0] might have tags: ["OpenAGI", "Sam Altman"]
 * ```
 *
 * @see {@link /lib/services/tag-service} Tag service
 * @see {@link /lib/services/trending-summary-service} Trending summary service
 * @see {@link /lib/services/trending-grouping-service} Trending grouping service
 */

import {
  type AuthenticatedUser,
  optionalAuth,
  withErrorHandling,
} from '@babylon/api';
import { asPublic, asUser, desc, eq, posts, postTags } from '@babylon/db';
import {
  generateTrendingSummary,
  getCurrentTrendingTags,
  groupTrendingTags,
  type TrendingTag,
} from '@babylon/engine';
import { logger } from '@babylon/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

// Server-side cache with longer TTL
interface CachedTrendingData {
  data: unknown[];
  timestamp: number;
}

let trendingCache: CachedTrendingData | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Request deduplication: prevent concurrent requests from all running expensive LLM calls
let ongoingRequest: Promise<unknown[]> | null = null;

export const GET = withErrorHandling(async (request: NextRequest) => {
  const startTime = Date.now();

  // Check server-side cache first
  if (trendingCache && Date.now() - trendingCache.timestamp < CACHE_TTL_MS) {
    logger.debug(
      'Returning cached trending data',
      {
        age: Date.now() - trendingCache.timestamp,
        durationMs: Date.now() - startTime,
      },
      'GET /api/feed/widgets/trending'
    );

    return NextResponse.json({
      success: true,
      trending: trendingCache.data,
    });
  }

  // Request deduplication: if another request is already processing, wait for it
  if (ongoingRequest) {
    logger.debug(
      'Waiting for ongoing trending request to complete',
      undefined,
      'GET /api/feed/widgets/trending'
    );
    const result = await ongoingRequest;
    return NextResponse.json({
      success: true,
      trending: result,
    });
  }

  // Create the processing promise
  const processingPromise = (async () => {
    // Get trending tags from cache (get more tags for better grouping)
    const trending = await getCurrentTrendingTags(10);

    if (!trending || trending.length === 0) {
      logger.info(
        'No trending tags available',
        undefined,
        'GET /api/feed/widgets/trending'
      );
      return [];
    }

    // Optional auth - trending tags are public but RLS still applies
    const authUser: AuthenticatedUser | null = await optionalAuth(
      request
    ).catch(() => null);

    // First, get all trending items with summaries
    const trendingItems: TrendingTag[] = await Promise.all(
      trending.map(async (item) => {
        const recentPosts =
          authUser && authUser.userId
            ? await asUser(authUser, async (db) => {
                return await db
                  .select({
                    postId: postTags.postId,
                    postContent: posts.content,
                  })
                  .from(postTags)
                  .innerJoin(posts, eq(postTags.postId, posts.id))
                  .where(eq(postTags.tagId, item.tag.id))
                  .orderBy(desc(postTags.createdAt))
                  .limit(3);
              })
            : await asPublic(async (db) => {
                return await db
                  .select({
                    postId: postTags.postId,
                    postContent: posts.content,
                  })
                  .from(postTags)
                  .innerJoin(posts, eq(postTags.postId, posts.id))
                  .where(eq(postTags.tagId, item.tag.id))
                  .orderBy(desc(postTags.createdAt))
                  .limit(3);
              });

        const postContents = recentPosts.map((pt) => pt.postContent);

        const summary = await generateTrendingSummary(
          item.tag.displayName,
          item.tag.category,
          postContents
        );

        return {
          id: item.tag.id, // Use actual tag ID, not trending record ID
          tag: item.tag.displayName,
          tagSlug: item.tag.name,
          category: item.tag.category,
          postCount: item.postCount,
          summary,
          rank: item.rank,
        };
      })
    );

    // Filter out null values
    const validItems = trendingItems.filter(
      (item): item is NonNullable<typeof item> => item !== null
    );

    // Group related tags using LLM analysis
    const groupedTrending = await groupTrendingTags(validItems);

    // Return top 5 groups
    const topGroups = groupedTrending.slice(0, 5);

    // Cache the result
    trendingCache = {
      data: topGroups,
      timestamp: Date.now(),
    };

    const duration = Date.now() - startTime;
    logger.info(
      'Generated trending data',
      {
        groups: topGroups.length,
        durationMs: duration,
      },
      'GET /api/feed/widgets/trending'
    );

    return topGroups;
  })();

  ongoingRequest = processingPromise;

  const result = await processingPromise;

  if (result.length === 0) {
    return NextResponse.json({
      success: true,
      trending: [],
      message: 'No trending data yet - check back after first game tick',
    });
  }

  return NextResponse.json({
    success: true,
    trending: result,
  });
});
