/**
 * Article Persistence Service
 *
 * Single source of truth for persisting articles to the database.
 * Consolidates duplicate article insertion logic from multiple locations
 * (article-tick, event-generation-helpers, game-tick) into one place.
 *
 * Features:
 * - Rate limit checking (optional)
 * - Snowflake ID generation
 * - Consistent field mapping to posts table
 * - Fire-and-forget image generation
 *
 * @module services/article-persistence
 */

import { db, eq, posts } from '@feed/db';
import type { ArticlePersistInput } from '@feed/shared';
import { generateSnowflakeId, logger } from '@feed/shared';
import { formatError } from '../utils/error-utils';
import { generateArticleImageWithRetry } from './article-image-service';
import { articleRateLimiter } from './article-rate-limiter';
import { generateTagsFromPost, storeTagsForPost } from './tag-service';

/**
 * Options for persisting an article
 */
export interface PersistArticleOptions {
  /**
   * Whether to check the rate limit before persisting.
   * Default: true
   *
   * Set to false for proof articles that should bypass rate limiting.
   */
  checkRateLimit?: boolean;

  /**
   * Whether to generate a cover image for the article.
   * Default: true if FAL_KEY environment variable is set
   */
  generateImage?: boolean;
}

/**
 * Result of a successful article persistence
 */
export interface PersistArticleSuccess {
  /** Article was successfully persisted */
  success: true;
  /** The article ID (snowflake) - always present on success */
  articleId: string;
  rateLimited?: never;
  error?: never;
}

/**
 * Result of a failed article persistence
 */
export interface PersistArticleFailure {
  /** Article was not persisted */
  success: false;
  /** Article ID is not available on failure */
  articleId?: never;
  /** Whether the article was rejected due to rate limiting */
  rateLimited?: boolean;
  /** Error message if persistence failed */
  error?: string;
}

/**
 * Result of article persistence attempt.
 * Discriminated union that guarantees articleId is present when success is true.
 */
export type PersistArticleResult =
  | PersistArticleSuccess
  | PersistArticleFailure;

/**
 * Persist an article to the database.
 *
 * This is the single source of truth for article persistence.
 * Use this function instead of directly inserting into the posts table.
 *
 * @param article - Article data to persist
 * @param options - Persistence options (rate limiting, image generation)
 * @returns Result indicating success/failure and article ID
 *
 * @example
 * ```typescript
 * const result = await persistArticle({
 *   title: 'Breaking News',
 *   summary: 'A brief summary...',
 *   content: 'Full article content...',
 *   authorOrgId: 'org-123',
 *   gameId: 'continuous',
 * });
 *
 * if (result.success) {
 *   console.log(`Article created: ${result.articleId}`);
 * } else if (result.rateLimited) {
 *   console.log('Rate limit exceeded');
 * }
 * ```
 */
export async function persistArticle(
  article: ArticlePersistInput,
  options: PersistArticleOptions = {}
): Promise<PersistArticleResult> {
  const { checkRateLimit = true, generateImage = !!process.env.FAL_KEY } =
    options;

  // Rate limit check
  if (checkRateLimit) {
    const { allowed, currentCount, maxAllowed } =
      await articleRateLimiter.canGenerateArticle();
    if (!allowed) {
      logger.debug(
        'Article persistence blocked by rate limit',
        {
          authorOrgId: article.authorOrgId,
          currentCount,
          maxAllowed,
        },
        'ArticlePersistence'
      );
      return { success: false, rateLimited: true };
    }
  }

  // Generate ID if not provided
  const articleId = article.id || (await generateSnowflakeId());
  const now = new Date();

  try {
    // Insert article into posts table
    await db.insert(posts).values({
      id: articleId,
      type: 'article',
      content: article.summary,
      fullContent: article.content,
      articleTitle: article.title,
      byline: article.byline ?? undefined,
      biasScore: article.biasScore ?? undefined,
      sentiment: article.sentiment ?? undefined,
      slant: article.slant ?? undefined,
      category: article.category || 'news',
      imageUrl: article.imageUrl ?? undefined,
      authorId: article.authorOrgId,
      gameId: article.gameId,
      dayNumber: article.dayNumber,
      timestamp: article.timestamp ?? now,
      createdAt: now,
      relatedQuestion: article.relatedQuestion,
    });

    logger.debug(
      'Article persisted successfully',
      {
        articleId,
        authorOrgId: article.authorOrgId,
        title: article.title.slice(0, 50),
        gameId: article.gameId,
      },
      'ArticlePersistence'
    );

    // Fire-and-forget image generation
    if (generateImage && !article.imageUrl) {
      void generateArticleImageWithRetry({
        title: article.title,
        summary: article.summary,
        category: article.category || 'news',
      })
        .then(async (imageUrl) => {
          if (imageUrl) {
            try {
              await db
                .update(posts)
                .set({ imageUrl })
                .where(eq(posts.id, articleId));
              logger.debug(
                'Article image updated',
                { articleId, imageUrl: imageUrl.slice(0, 50) },
                'ArticlePersistence'
              );
            } catch (updateError) {
              logger.warn(
                'Failed to update article with image URL',
                {
                  articleId,
                  error: formatError(updateError),
                },
                'ArticlePersistence'
              );
            }
          }
        })
        .catch((err) => {
          logger.debug(
            'Image generation failed (non-blocking)',
            {
              articleId,
              error: formatError(err),
            },
            'ArticlePersistence'
          );
        });
    }

    // Fire-and-forget tag generation and storage
    void generateTagsFromPost(article.summary)
      .then(async (generatedTags) => {
        if (generatedTags.length > 0) {
          await storeTagsForPost(articleId, generatedTags);
          logger.debug(
            'Article tags stored',
            { articleId, tagCount: generatedTags.length },
            'ArticlePersistence'
          );
        }
      })
      .catch((tagError) => {
        logger.warn(
          'Failed to generate/store article tags (non-blocking)',
          {
            articleId,
            error: formatError(tagError),
          },
          'ArticlePersistence'
        );
      });

    return { success: true, articleId };
  } catch (error) {
    const errorMessage = formatError(error);
    logger.error(
      'Failed to persist article',
      {
        articleId,
        authorOrgId: article.authorOrgId,
        error: errorMessage,
      },
      'ArticlePersistence'
    );
    return { success: false, error: errorMessage };
  }
}
