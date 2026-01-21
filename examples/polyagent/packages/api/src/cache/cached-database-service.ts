/**
 * Cached Database Service
 *
 * @description Wraps database-service with intelligent caching layer using Redis
 * and in-memory cache. Provides cached versions of frequently accessed queries
 * with automatic TTL management and cache invalidation. Reduces database load
 * for read-heavy operations.
 *
 * @usage
 * ```typescript
 * import { cachedDb } from '@babylon/api'
 * const posts = await cachedDb.getRecentPosts(100)
 * ```
 */

import {
  and,
  asc,
  comments,
  count,
  db,
  desc,
  eq,
  follows,
  getDbInstance,
  inArray,
  isNull,
  lt,
  lte,
  markets,
  type Post,
  positions,
  posts,
  reactions,
  tags,
  trendingTags,
  userActorFollows,
  users,
} from "@babylon/db";
import { logger } from "@babylon/shared";
import {
  CACHE_KEYS,
  DEFAULT_TTLS,
  getCacheOrFetch,
  invalidateCache,
  invalidateCachePattern,
} from "./cache-service";

/**
 * Cached Database Service Class
 *
 * @description Wrapper class that adds caching to database operations.
 * Automatically caches query results with appropriate TTLs and provides
 * cache invalidation methods.
 */
class CachedDatabaseService {
  /**
   * Get recent posts with caching (cursor-based or offset-based pagination)
   *
   * @description Retrieves recent posts with caching. Supports both cursor-based
   * and offset-based pagination. Filters out posts from test users. Cache TTL
   * is short (10 seconds) due to real-time nature of posts.
   *
   * @param {number} limit - Number of posts to fetch (default: 100)
   * @param {string | number} [cursorOrOffset] - Cursor (ISO string) or offset (number)
   * @returns {Promise<Post[]>} Array of posts
   */
  async getRecentPosts(
    limit = 100,
    cursorOrOffset?: string | number,
  ): Promise<Post[]> {
    const isCursor = typeof cursorOrOffset === "string";
    const cacheKey = isCursor
      ? `${limit}:cursor:${cursorOrOffset}`
      : `${limit}:offset:${cursorOrOffset || 0}`;

    return getCacheOrFetch(
      cacheKey,
      () => getDbInstance().getRecentPosts(limit, cursorOrOffset),
      {
        namespace: CACHE_KEYS.POSTS_LIST,
        ttl: DEFAULT_TTLS.POSTS_LIST,
      },
    );
  }

  /**
   * Get posts by actor with caching (cursor-based or offset-based pagination)
   */
  async getPostsByActor(
    authorId: string,
    limit = 100,
    cursorOrOffset?: string | number,
  ): Promise<Post[]> {
    const isCursor = typeof cursorOrOffset === "string";
    const cacheKey = isCursor
      ? `${authorId}:${limit}:cursor:${cursorOrOffset}`
      : `${authorId}:${limit}:offset:${cursorOrOffset || 0}`;

    return getCacheOrFetch(
      cacheKey,
      () => getDbInstance().getPostsByActor(authorId, limit, cursorOrOffset),
      {
        namespace: CACHE_KEYS.POSTS_BY_ACTOR,
        ttl: DEFAULT_TTLS.POSTS_BY_ACTOR,
      },
    );
  }

  /**
   * Get posts for following feed with caching (cursor-based or offset-based pagination)
   * Filters out posts from test users
   */
  async getPostsForFollowing(
    userId: string,
    followedIds: string[],
    limit = 100,
    cursorOrOffset?: string | number,
  ): Promise<Post[]> {
    const isCursor = typeof cursorOrOffset === "string";
    const cacheKey = isCursor
      ? `${userId}:${limit}:cursor:${cursorOrOffset}`
      : `${userId}:${limit}:offset:${cursorOrOffset || 0}`;

    return getCacheOrFetch(
      cacheKey,
      async () => {
        // First, filter out test users from followedIds
        const testUsers = await db
          .select({ id: users.id })
          .from(users)
          .where(and(inArray(users.id, followedIds), eq(users.isTest, true)));

        // NPC/Actor support removed
        const testAuthorIds = new Set([...testUsers.map((u) => u.id)]);

        // Remove test users from followedIds
        const nonTestFollowedIds = followedIds.filter(
          (id) => !testAuthorIds.has(id),
        );

        const cursor = isCursor ? (cursorOrOffset as string) : undefined;
        const offset =
          !isCursor && typeof cursorOrOffset === "number" ? cursorOrOffset : 0;

        const now = new Date();

        // Build conditions
        const conditions = [
          inArray(posts.authorId, nonTestFollowedIds),
          isNull(posts.deletedAt),
        ];

        if (cursor) {
          conditions.push(lt(posts.timestamp, new Date(cursor)));
          conditions.push(lte(posts.timestamp, now));
        } else {
          conditions.push(lte(posts.timestamp, now));
        }

        // Query posts from database (only from non-test users)
        const result = await db
          .select()
          .from(posts)
          .where(and(...conditions))
          .orderBy(desc(posts.timestamp))
          .limit(limit)
          .offset(cursor ? 0 : offset);

        return result;
      },
      {
        namespace: CACHE_KEYS.POSTS_FOLLOWING,
        ttl: DEFAULT_TTLS.POSTS_FOLLOWING,
      },
    );
  }

  /**
   * Get user by ID with caching
   */
  async getUserById(userId: string) {
    const cacheKey = userId;

    return getCacheOrFetch(
      cacheKey,
      async () => {
        const result = await db
          .select()
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        return result[0] ?? null;
      },
      {
        namespace: CACHE_KEYS.USER,
        ttl: DEFAULT_TTLS.USER,
      },
    );
  }

  /**
   * Get multiple users with caching
   */
  async getUsersByIds(userIds: string[]) {
    // For bulk operations, we still cache individual users
    const usersResult = await Promise.all(
      userIds.map((id) => this.getUserById(id)),
    );

    return usersResult.filter((u) => u !== null);
  }

  /**
   * Get user balance with caching
   */
  async getUserBalance(userId: string) {
    const cacheKey = userId;

    return getCacheOrFetch(
      cacheKey,
      async () => {
        const result = await db
          .select({
            virtualBalance: users.virtualBalance,
            totalDeposited: users.totalDeposited,
            totalWithdrawn: users.totalWithdrawn,
            lifetimePnL: users.lifetimePnL,
          })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        return result[0] ?? null;
      },
      {
        namespace: CACHE_KEYS.USER_BALANCE,
        ttl: DEFAULT_TTLS.USER_BALANCE,
      },
    );
  }

  /**
   * Get user profile stats with caching (followers, following, posts)
   */
  async getUserProfileStats(userId: string) {
    const cacheKey = userId;

    return getCacheOrFetch(
      cacheKey,
      async () => {
        // Count followers (users following this user)
        const followersResult = await db
          .select({ count: count() })
          .from(follows)
          .where(eq(follows.followingId, userId));

        // Count following (users this user follows)
        const followingResult = await db
          .select({ count: count() })
          .from(follows)
          .where(eq(follows.followerId, userId));

        // Count actor follows
        const actorFollowsResult = await db
          .select({ count: count() })
          .from(userActorFollows)
          .where(eq(userActorFollows.userId, userId));

        // Count positions
        const positionsResult = await db
          .select({ count: count() })
          .from(positions)
          .where(eq(positions.userId, userId));

        // Count comments
        const commentsResult = await db
          .select({ count: count() })
          .from(comments)
          .where(eq(comments.authorId, userId));

        // Count reactions
        const reactionsResult = await db
          .select({ count: count() })
          .from(reactions)
          .where(eq(reactions.userId, userId));

        // Count posts
        const postCountResult = await db
          .select({ count: count() })
          .from(posts)
          .where(eq(posts.authorId, userId));

        const followers = Number(followersResult[0]?.count ?? 0);
        const following = Number(followingResult[0]?.count ?? 0);
        const actorFollows = Number(actorFollowsResult[0]?.count ?? 0);

        return {
          followers,
          following: following + actorFollows,
          positions: Number(positionsResult[0]?.count ?? 0),
          comments: Number(commentsResult[0]?.count ?? 0),
          reactions: Number(reactionsResult[0]?.count ?? 0),
          posts: Number(postCountResult[0]?.count ?? 0),
        };
      },
      {
        namespace: "user:profile:stats",
        ttl: 60, // Cache for 1 minute
      },
    );
  }

  /**
   * Get actor by ID with caching
   */
  async getActorById(_actorId: string) {
    // NPC/Actor support removed
    return null;
  }

  /**
   * Get multiple actors with caching
   */
  async getActorsByIds(actorIds: string[]) {
    const actorsResult = await Promise.all(
      actorIds.map((id) => this.getActorById(id)),
    );

    return actorsResult.filter((a) => a !== null);
  }

  /**
   * Get organization by ID with caching
   */
  async getOrganizationById(_orgId: string) {
    // Organization support removed
    return null;
  }

  /**
   * Get active markets with caching
   */
  async getActiveMarkets() {
    const cacheKey = "active";

    return getCacheOrFetch(
      cacheKey,
      async () => {
        const result = await db
          .select()
          .from(markets)
          .where(eq(markets.resolved, false))
          .orderBy(desc(markets.createdAt));
        return result;
      },
      {
        namespace: CACHE_KEYS.MARKETS_LIST,
        ttl: DEFAULT_TTLS.MARKETS_LIST,
      },
    );
  }

  /**
   * Get trending tags with caching
   */
  async getTrendingTags(limit = 10) {
    const cacheKey = `${limit}`;

    return getCacheOrFetch(
      cacheKey,
      async () => {
        const result = await db
          .select({
            id: trendingTags.id,
            tagId: trendingTags.tagId,
            rank: trendingTags.rank,
            score: trendingTags.score,
            postCount: trendingTags.postCount,
            calculatedAt: trendingTags.calculatedAt,
            tag: {
              id: tags.id,
              name: tags.name,
              createdAt: tags.createdAt,
              updatedAt: tags.updatedAt,
            },
          })
          .from(trendingTags)
          .leftJoin(tags, eq(trendingTags.tagId, tags.id))
          .limit(limit)
          .orderBy(asc(trendingTags.rank));
        return result;
      },
      {
        namespace: CACHE_KEYS.TRENDING_TAGS,
        ttl: DEFAULT_TTLS.TRENDING_TAGS,
      },
    );
  }

  /**
   * Invalidate cache for posts
   */
  async invalidatePostsCache() {
    logger.info("Invalidating posts cache", undefined, "CachedDatabaseService");
    await Promise.all([
      invalidateCachePattern("*", { namespace: CACHE_KEYS.POSTS_LIST }),
      invalidateCachePattern("*", { namespace: CACHE_KEYS.POSTS_FOLLOWING }),
    ]);
  }

  /**
   * Invalidate cache for specific actor's posts
   */
  async invalidateActorPostsCache(actorId: string) {
    logger.info(
      "Invalidating actor posts cache",
      { actorId },
      "CachedDatabaseService",
    );
    await invalidateCachePattern(`${actorId}:*`, {
      namespace: CACHE_KEYS.POSTS_BY_ACTOR,
    });
  }

  /**
   * Invalidate cache for user
   */
  async invalidateUserCache(userId: string) {
    logger.info("Invalidating user cache", { userId }, "CachedDatabaseService");
    await Promise.all([
      invalidateCache(userId, { namespace: CACHE_KEYS.USER }),
      invalidateCache(userId, { namespace: CACHE_KEYS.USER_BALANCE }),
      invalidateCache(userId, { namespace: "user:profile:stats" }),
      invalidateCachePattern(`${userId}:*`, {
        namespace: CACHE_KEYS.POSTS_FOLLOWING,
      }),
      invalidateCachePattern("*", { namespace: "user:follows" }), // Invalidate follows cache
    ]);
  }

  /**
   * Invalidate cache for markets
   */
  async invalidateMarketsCache() {
    logger.info(
      "Invalidating markets cache",
      undefined,
      "CachedDatabaseService",
    );
    await invalidateCachePattern("*", { namespace: CACHE_KEYS.MARKETS_LIST });
  }

  /**
   * Invalidate all caches (use sparingly!)
   */
  async invalidateAllCaches() {
    logger.warn("Invalidating all caches", undefined, "CachedDatabaseService");
    await Promise.all([
      this.invalidatePostsCache(),
      this.invalidateMarketsCache(),
    ]);
  }
}

export const cachedDb = new CachedDatabaseService();
