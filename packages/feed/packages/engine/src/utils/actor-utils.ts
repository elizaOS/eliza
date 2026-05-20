/**
 * Shared Actor Utilities
 *
 * Common functions used across actor-related services
 * (ActorContextBuilder, MarketContextService, etc.)
 */

import { and, db, desc, gte, inArray, isNull, lte, posts } from '@feed/db';
import { StaticDataRegistry } from '../services/static-data-registry';
import type { FeedPostContext } from '../types/market-context';

/**
 * Resolve an actor ID to a display name via the static registry.
 * Falls back to the raw ID if the actor is not found.
 */
export function resolveActorName(actorId: string): string {
  const actor = StaticDataRegistry.getActor(actorId);
  return actor?.name ?? actorId;
}

/**
 * Find actor IDs that share affiliations with the given actor.
 */
export function findRelatedActorsByAffiliation(
  actorId: string,
  affiliations: string[]
): string[] {
  const relatedIds: string[] = [];
  if (affiliations.length === 0) return relatedIds;

  for (const other of StaticDataRegistry.getAllActors()) {
    if (other.id === actorId) continue;
    if (other.affiliations?.some((a) => affiliations.includes(a))) {
      relatedIds.push(other.id);
    }
  }
  return relatedIds;
}

/**
 * Fetch relevant feed posts for an actor.
 *
 * Prioritizes posts from actors the given actor shares affiliations with,
 * then fills remaining slots with recent general posts.
 *
 * @param relatedActorIds - Pre-computed list of related actor IDs
 * @param since - Start of the lookback window
 * @param now - Current time
 * @param options - Optional overrides for limits and content truncation
 */
export async function fetchRelevantPosts(
  relatedActorIds: string[],
  since: Date,
  now: Date,
  options?: {
    maxRelated?: number;
    maxTotal?: number;
    maxContentLength?: number;
    maxTitleLength?: number;
  }
): Promise<FeedPostContext[]> {
  const maxRelated = options?.maxRelated ?? 10;
  const maxTotal = options?.maxTotal ?? 15;
  const maxContentLength = options?.maxContentLength ?? 500;
  const maxTitleLength = options?.maxTitleLength ?? 120;

  // Fetch posts from related actors first
  let relevantPosts: (typeof posts.$inferSelect)[] = [];
  if (relatedActorIds.length > 0) {
    relevantPosts = await db
      .select()
      .from(posts)
      .where(
        and(
          isNull(posts.deletedAt),
          lte(posts.timestamp, now),
          gte(posts.timestamp, since),
          inArray(posts.authorId, relatedActorIds)
        )
      )
      .orderBy(desc(posts.timestamp))
      .limit(maxRelated);
  }

  // Fill remaining slots with general recent posts
  const remainingSlots = maxTotal - relevantPosts.length;
  if (remainingSlots > 0) {
    const existingIds = new Set(relevantPosts.map((p) => p.id));
    const general = await db
      .select()
      .from(posts)
      .where(
        and(
          isNull(posts.deletedAt),
          lte(posts.timestamp, now),
          gte(posts.timestamp, since)
        )
      )
      .orderBy(desc(posts.timestamp))
      .limit(remainingSlots + relevantPosts.length);

    relevantPosts.push(
      ...general.filter((p) => !existingIds.has(p.id)).slice(0, remainingSlots)
    );
  }

  return relevantPosts.map((post) => {
    const content =
      post.content.length > maxContentLength
        ? post.content.slice(0, maxContentLength) + '...'
        : post.content;

    const articleTitle =
      post.articleTitle && post.articleTitle.length > maxTitleLength
        ? post.articleTitle.slice(0, maxTitleLength) + '...'
        : post.articleTitle;

    return {
      author: post.authorId,
      authorName: resolveActorName(post.authorId),
      content,
      timestamp: post.timestamp.toISOString(),
      articleTitle: articleTitle || undefined,
    };
  });
}
