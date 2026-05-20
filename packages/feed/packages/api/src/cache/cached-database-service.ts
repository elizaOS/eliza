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
 * import { cachedDb } from '@feed/api'
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
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { logger, resolveUserIdentifierKind } from '@feed/shared';
import {
  CACHE_KEYS,
  DEFAULT_TTLS,
  getCacheBatchOrFetch,
  getCacheOrFetch,
  invalidateCache,
  invalidateCachePattern,
} from './cache-service';

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
    cursorOrOffset?: string | number
  ): Promise<Post[]> {
    const isCursor = typeof cursorOrOffset === 'string';
    const cacheKey = isCursor
      ? `${limit}:cursor:${cursorOrOffset}`
      : `${limit}:offset:${cursorOrOffset || 0}`;

    return getCacheOrFetch(
      cacheKey,
      () => getDbInstance().getRecentPosts(limit, cursorOrOffset),
      {
        namespace: CACHE_KEYS.POSTS_LIST,
        ttl: DEFAULT_TTLS.POSTS_LIST,
      }
    );
  }

  /**
   * Get posts by actor with caching (cursor-based or offset-based pagination)
   */
  async getPostsByActor(
    authorId: string,
    limit = 100,
    cursorOrOffset?: string | number
  ): Promise<Post[]> {
    const isCursor = typeof cursorOrOffset === 'string';
    const cacheKey = isCursor
      ? `${authorId}:${limit}:cursor:${cursorOrOffset}`
      : `${authorId}:${limit}:offset:${cursorOrOffset || 0}`;

    return getCacheOrFetch(
      cacheKey,
      () => getDbInstance().getPostsByActor(authorId, limit, cursorOrOffset),
      {
        namespace: CACHE_KEYS.POSTS_BY_ACTOR,
        ttl: DEFAULT_TTLS.POSTS_BY_ACTOR,
      }
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
    cursorOrOffset?: string | number
  ): Promise<Post[]> {
    const isCursor = typeof cursorOrOffset === 'string';
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

        // Get test actors from static registry
        const testActorIds = StaticDataRegistry.getAllActors()
          .filter((a) => a.isTest && followedIds.includes(a.id))
          .map((a) => a.id);

        const testAuthorIds = new Set([
          ...testUsers.map((u) => u.id),
          ...testActorIds,
        ]);

        // Remove test users from followedIds
        const nonTestFollowedIds = followedIds.filter(
          (id) => !testAuthorIds.has(id)
        );

        const cursor = isCursor ? (cursorOrOffset as string) : undefined;
        const offset =
          !isCursor && typeof cursorOrOffset === 'number' ? cursorOrOffset : 0;

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
      }
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
      }
    );
  }

  /**
   * Get multiple users with caching using batch operations
   *
   * PERFORMANCE OPTIMIZATION: Uses batch cache get/set to reduce Redis
   * round-trips from N to 2 (one MGET, one pipeline SET for misses).
   * Critical for 400k+ users where N+1 cache lookups cause latency spikes.
   */
  async getUsersByIds(userIds: string[]) {
    if (userIds.length === 0) return [];

    // Use batch cache operation instead of N individual lookups
    const usersMap = await getCacheBatchOrFetch(
      userIds,
      async (missingIds) => {
        // Single database query for all missing users
        const rows = await db
          .select()
          .from(users)
          .where(inArray(users.id, missingIds));

        return new Map(rows.map((user) => [user.id, user]));
      },
      {
        namespace: CACHE_KEYS.USER,
        ttl: DEFAULT_TTLS.USER,
      }
    );

    // Return users in the same order as requested, filtering nulls
    return userIds
      .map((id) => usersMap.get(id))
      .filter((u): u is NonNullable<typeof u> => u != null);
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
      }
    );
  }

  /**
   * Get user profile stats with caching (followers, following, posts)
   *
   * PERFORMANCE OPTIMIZATION: Uses parallel Promise.all to execute all
   * count queries simultaneously, reducing latency by ~70% compared to
   * sequential execution. Combined with 1-minute caching.
   */
  async getUserProfileStats(userId: string): Promise<{
    followers: number;
    following: number;
    positions: number;
    comments: number;
    reactions: number;
    posts: number;
  }> {
    const cacheKey = userId;

    return getCacheOrFetch(
      cacheKey,
      async () => {
        // Execute all count queries in parallel for minimum latency
        const [
          followersResult,
          followingResult,
          actorFollowsResult,
          positionsResult,
          commentsResult,
          reactionsResult,
          postCountResult,
        ] = await Promise.all([
          // Count followers (users following this user)
          db
            .select({ count: count() })
            .from(follows)
            .where(eq(follows.followingId, userId)),

          // Count following (users this user follows)
          db
            .select({ count: count() })
            .from(follows)
            .where(eq(follows.followerId, userId)),

          // Count actor follows
          db
            .select({ count: count() })
            .from(userActorFollows)
            .where(eq(userActorFollows.userId, userId)),

          // Count positions
          db
            .select({ count: count() })
            .from(positions)
            .where(eq(positions.userId, userId)),

          // Count comments
          db
            .select({ count: count() })
            .from(comments)
            .where(eq(comments.authorId, userId)),

          // Count reactions
          db
            .select({ count: count() })
            .from(reactions)
            .where(eq(reactions.userId, userId)),

          // Count posts
          db
            .select({ count: count() })
            .from(posts)
            .where(eq(posts.authorId, userId)),
        ]);

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
        namespace: 'user:profile:stats',
        ttl: 60, // Cache for 1 minute
      }
    );
  }

  /**
   * Get actor by ID with caching
   */
  async getActorById(actorId: string) {
    // Static data from registry - no caching needed (already in memory)
    const staticActor = StaticDataRegistry.getActor(actorId);
    if (!staticActor) return null;

    // Optionally combine with dynamic state
    const state = await getDbInstance().getActorState(actorId);
    return {
      ...staticActor,
      tradingBalance: state?.tradingBalance ?? '10000',
      reputationPoints: state?.reputationPoints ?? 10000,
      hasPool: state?.hasPool ?? false,
    };
  }

  /**
   * Get multiple actors with caching
   */
  async getActorsByIds(actorIds: string[]) {
    const actorsResult = await Promise.all(
      actorIds.map((id) => this.getActorById(id))
    );

    return actorsResult.filter((a) => a !== null);
  }

  /**
   * Get organization by ID with caching
   */
  async getOrganizationById(orgId: string) {
    // Static data from registry - no caching needed (already in memory)
    const staticOrg = StaticDataRegistry.getOrganization(orgId);
    if (!staticOrg) return null;

    // Optionally combine with dynamic state
    const state = await getDbInstance().getOrganizationState(orgId);
    return {
      ...staticOrg,
      currentPrice: state?.currentPrice ?? staticOrg.initialPrice,
    };
  }

  /**
   * Get active markets with caching
   */
  async getActiveMarkets() {
    const cacheKey = 'active';

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
      }
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
      }
    );
  }

  /**
   * Invalidate cache for posts
   */
  async invalidatePostsCache() {
    logger.info('Invalidating posts cache', undefined, 'CachedDatabaseService');
    await Promise.all([
      invalidateCachePattern('*', { namespace: CACHE_KEYS.POSTS_LIST }),
      invalidateCachePattern('*', { namespace: CACHE_KEYS.POSTS_FOLLOWING }),
    ]);
  }

  /**
   * Invalidate cache for specific actor's posts
   */
  async invalidateActorPostsCache(actorId: string) {
    logger.info(
      'Invalidating actor posts cache',
      { actorId },
      'CachedDatabaseService'
    );
    await invalidateCachePattern(`${actorId}:*`, {
      namespace: CACHE_KEYS.POSTS_BY_ACTOR,
    });
  }

  /**
   * Invalidate cache for user
   */
  async invalidateUserCache(userId: string) {
    logger.info('Invalidating user cache', { userId }, 'CachedDatabaseService');
    await Promise.all([
      invalidateCache(userId, { namespace: CACHE_KEYS.USER }),
      invalidateCache(userId, { namespace: CACHE_KEYS.USER_BALANCE }),
      invalidateCache(userId, { namespace: 'user:profile:stats' }),
      invalidateCachePattern(`${userId}:*`, {
        namespace: CACHE_KEYS.POSTS_FOLLOWING,
      }),
      invalidateCachePattern('*', { namespace: 'user:follows' }), // Invalidate follows cache
    ]);
  }

  /**
   * Invalidate user identifier caches (id, privyId, username)
   *
   * @description Invalidates all identifier-based caches for a user. This includes
   * caches for id, privyId, and username lookups. Must be called whenever user
   * identifiers change (username update, privyId update, user creation).
   *
   * **WHY invalidate both old and new values?**
   * - Old values: When username changes from "alice" to "bob", the old cache key
   *   `username:alice` must be invalidated to prevent stale data
   * - New values: The new cache key `username:bob` should be invalidated so it gets
   *   refreshed on next lookup with the latest data from database
   * - This ensures cache stays in sync with database state
   *
   * **WHY invalidate on user creation?**
   * - Clears negative cache entries (cached null results for non-existent users)
   * - If user "alice" didn't exist, we cached null. When user is created, we must
   *   invalidate so next lookup finds the new user instead of returning cached null
   * - This is critical for signup flows - without invalidation, new users can't be found
   *
   * **WHY unified namespace?**
   * - All identifier caches in one namespace (`user:identifier`) reduces desync risk
   * - Single helper call invalidates all identifier caches for a user
   * - Easier to reason about and maintain than multiple namespaces
   *
   * @param {object} user - User object with id, privyId, and username
   * @param {object} [oldValues] - Old values for fields that changed (for invalidation of old cache keys)
   *
   * @example
   * ```typescript
   * // On username change
   * await cachedDb.invalidateUserIdentifierCaches(
   *   { id: userId, username: newUsername },
   *   { username: oldUsername }
   * );
   *
   * // On user creation (clears negative cache)
   * await cachedDb.invalidateUserIdentifierCaches({
   *   id: newUser.id,
   *   privyId: newUser.privyId,
   *   username: newUser.username,
   * });
   * ```
   */
  async invalidateUserIdentifierCaches(
    user: { id: string; privyId?: string | null; username?: string | null },
    oldValues?: { privyId?: string | null; username?: string | null }
  ) {
    // WHY unified namespace? Single namespace for all identifier caches reduces desync risk
    // If we used separate namespaces (user:id, user:privyId, user:username), we'd need to
    // remember to invalidate in all three places. With unified namespace, one helper call
    // invalidates everything, making it harder to miss an invalidation
    const namespace = CACHE_KEYS.USER_IDENTIFIER;

    // WHY always invalidate by ID? ID never changes, but we invalidate to ensure fresh data
    // after user updates (e.g., profile changes that affect cached user object)
    await invalidateCache(`id:${user.id}`, { namespace });

    // Some users have their did:privy:… value stored as users.id rather than
    // users.privyId. Lookups for those users cache under privy:${user.id}, so
    // we must invalidate that key too — otherwise stale/negative entries persist.
    if (resolveUserIdentifierKind(user.id) === 'privyId') {
      await invalidateCache(`privy:${user.id}`, { namespace });
    }

    // WHY check oldValues?.privyId? Only invalidate old privyId if it actually changed
    // This avoids unnecessary cache operations when privyId hasn't changed
    if (oldValues?.privyId && oldValues.privyId !== user.privyId) {
      await invalidateCache(`privy:${oldValues.privyId}`, { namespace });
    }

    // WHY invalidate new privyId even if it didn't change? Ensures fresh data on next lookup
    // If privyId didn't change but other user fields did, we want to refresh the cache
    if (user.privyId) {
      await invalidateCache(`privy:${user.privyId}`, { namespace });
    }

    // WHY lowercase old username? Cache keys use lowercase for usernames (matches query normalization)
    // Must match the cache key format used in getUserIdentifierCacheKey()
    if (oldValues?.username && oldValues.username !== user.username) {
      await invalidateCache(`username:${oldValues.username.toLowerCase()}`, {
        namespace,
      });
    }

    // WHY invalidate new username? Same reason as privyId - ensures fresh data
    if (user.username) {
      await invalidateCache(`username:${user.username.toLowerCase()}`, {
        namespace,
      });
    }

    // WHY also invalidate user data cache? User data cache (CACHE_KEYS.USER namespace) is separate
    // from identifier cache, but both contain user data. When identifiers change, we should
    // refresh both to maintain consistency
    await this.invalidateUserCache(user.id);
  }

  /**
   * Invalidate cache for markets
   */
  async invalidateMarketsCache() {
    logger.info(
      'Invalidating markets cache',
      undefined,
      'CachedDatabaseService'
    );
    await invalidateCachePattern('*', { namespace: CACHE_KEYS.MARKETS_LIST });
  }

  /**
   * Invalidate all caches (use sparingly!)
   */
  async invalidateAllCaches() {
    logger.warn('Invalidating all caches', undefined, 'CachedDatabaseService');
    await Promise.all([
      this.invalidatePostsCache(),
      this.invalidateMarketsCache(),
    ]);
  }
}

export const cachedDb = new CachedDatabaseService();
