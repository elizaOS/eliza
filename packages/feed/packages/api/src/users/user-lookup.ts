/**
 * User Lookup Utilities
 *
 * @description Utilities for finding users by various identifiers (ID, privyId, username).
 */

import { db, eq, users } from "@feed/db";
import { type StaticActor, StaticDataRegistry } from "@feed/engine";
import { resolveUserIdentifierKind } from "@feed/shared";
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  CACHE_KEYS,
  DEFAULT_TTLS,
  getCacheOrFetch,
} from "../cache/cache-service";
import { NotFoundError } from "../errors";

type User = InferSelectModel<typeof users>;

function projectUser(
  user: User | null,
  select?: Record<string, boolean>,
): User | null {
  if (!user || !select) {
    return user;
  }

  const projected = Object.entries(select).reduce<Record<string, unknown>>(
    (result, [key, enabled]) => {
      if (enabled && key in user) {
        result[key] = (user as Record<string, unknown>)[key];
      }
      return result;
    },
    {},
  );

  return projected as User;
}

/**
 * Fetch a user row by classified identifier kind.
 *
 * For `privyId` lookups that miss, falls back to a PK lookup because some
 * users have their `did:privy:…` value stored as `users.id` rather than
 * `users.privyId`. Both queries use single-column indexes (no OR).
 */
async function fetchUserByClassifiedIdentifier(
  identifier: string,
  kind: "id" | "privyId" | "stewardId" | "username",
): Promise<User | null> {
  const condition =
    kind === "id"
      ? eq(users.id, identifier)
      : kind === "privyId"
        ? eq(users.privyId, identifier)
        : kind === "stewardId"
          ? eq(users.stewardId, identifier)
          : sql`lower(${users.username}) = lower(${identifier})`;

  const [user] = await db.select().from(users).where(condition).limit(1);
  if (user) return user;

  // Fallback: did:privy: identifiers may be stored as the primary key
  // instead of in the privyId column. PK lookup is O(1).
  if (kind === "privyId") {
    const [byId] = await db
      .select()
      .from(users)
      .where(eq(users.id, identifier))
      .limit(1);
    return byId ?? null;
  }

  return null;
}

/**
 * Generate cache key for user identifier lookup
 *
 * @description Creates a cache key based on the identifier kind and value.
 * Uses prefixed keys within the unified USER_IDENTIFIER namespace.
 *
 * **WHY prefixed keys?**
 * - Allows us to use a single unified namespace (`user:identifier`) for all identifier types
 * - Prefixes (`id:`, `privy:`, `username:`) distinguish identifier types within the namespace
 * - Makes cache keys self-documenting and easier to debug
 * - Enables pattern-based invalidation if needed (e.g., `user:identifier:id:*`)
 *
 * **WHY unified namespace instead of separate namespaces?**
 * - Reduces desync risk: single namespace means we can't accidentally miss invalidating a namespace
 * - Simpler invalidation: one helper call invalidates all identifier caches for a user
 * - Lower cognitive load: "invalidate identifier caches" = one namespace, not three
 * - Still uses classification: classification determines the prefix, we're just organizing differently
 *
 * @param {string} identifier - The identifier value
 * @param {'id' | 'privyId' | 'username'} kind - The identifier kind
 * @returns {string} Cache key with appropriate prefix
 */
function getUserIdentifierCacheKey(
  identifier: string,
  kind: "id" | "privyId" | "stewardId" | "username",
): string {
  if (kind === "id") {
    return `id:${identifier}`;
  } else if (kind === "privyId") {
    return `privy:${identifier}`;
  } else if (kind === "stewardId") {
    return `steward:${identifier}`;
  } else {
    return `username:${identifier.toLowerCase()}`;
  }
}

/**
 * Find user by identifier (ID, privyId, or username)
 *
 * @description Searches for a user by their ID, privyId, or username.
 * Returns null if no user is found. Username matching is case-insensitive.
 *
 * **Performance Optimization:**
 * This function was optimized to address a performance bottleneck where the original
 * OR-based query averaged 668ms per call. The optimization includes:
 * 1. **Query optimization**: Classification-based routing to single indexed query (removes OR overhead)
 * 2. **Redis caching**: 5-minute TTL cache with negative caching to reduce database load by ~80%
 *
 * **WHY classification before caching?**
 * - Classification determines both the query path AND the cache key
 * - We classify once and use the result for both query routing and cache key generation
 * - This ensures cache keys match query paths, maximizing cache hit rate
 *
 * **WHY negative caching (caching null results)?**
 * - Prevents repeated database queries for non-existent users
 * - Safe as long as we invalidate identifier caches on user creation (which we do)
 * - Reduces database load for invalid identifier lookups
 *
 * @param {string} identifier - The user ID, privyId, or username
 * @param {Record<string, boolean>} [_select] - Optional select fields projection
 * @returns {Promise<User | null>} User object or null if not found
 *
 * @example
 * ```typescript
 * const user = await findUserByIdentifier('alice');
 * if (user) {
 *   console.log(user.displayName);
 * }
 * ```
 */
export async function findUserByIdentifier(
  identifier: string,
  select?: Record<string, boolean>,
): Promise<User | null> {
  // WHY early return for empty/null? Avoids unnecessary classification and cache lookup
  // Empty strings can't match any identifier type, so return null immediately
  if (!identifier || identifier.trim() === "") {
    return null;
  }

  // Classify once - use result for both query routing and cache key generation
  const kind = resolveUserIdentifierKind(identifier);
  const cacheKey = getUserIdentifierCacheKey(identifier, kind);

  // Fetch from cache or database
  // WHY getCacheOrFetch? Implements cache-aside pattern with thundering herd protection
  // If cache miss, executes the fetch function and caches the result (including null for negative caching)
  const user = await getCacheOrFetch(
    cacheKey,
    async () => fetchUserByClassifiedIdentifier(identifier, kind),
    {
      namespace: CACHE_KEYS.USER_IDENTIFIER,
      ttl: DEFAULT_TTLS.USER,
    },
  );

  return projectUser(user, select);
}

/**
 * Find user by identifier with custom select fields
 *
 * @description Searches for a user with a custom selection of fields.
 * Username matching is case-insensitive.
 *
 * **Caching Strategy:**
 * This function caches the full user object and filters in memory for different
 * select patterns. This maximizes cache hits across different select field combinations.
 *
 * **WHY cache full object instead of per-select-pattern?**
 * - Different callers request different field combinations (e.g., {id, username} vs {id, displayName})
 * - If we cached per-select-pattern, we'd have multiple cache entries for the same user
 * - Caching full object means one cache entry serves all select patterns
 * - Trade-off: Slightly more memory per cache entry, but significantly more cache hits
 * - In-memory filtering is fast (microseconds) compared to database query (milliseconds)
 *
 * @param {string} identifier - The user ID, privyId, or username
 * @param {T} select - Fields to select (Drizzle column objects)
 * @returns {Promise<T | null>} Selected fields or null if not found
 *
 * @example
 * ```typescript
 * const user = await findUserByIdentifierWithSelect('alice', {
 *   id: users.id,
 *   username: users.username,
 * });
 * ```
 */
export async function findUserByIdentifierWithSelect<
  T extends Record<string, unknown>,
>(identifier: string, select: T): Promise<T | null> {
  // WHY early return for empty/null? Same as findUserByIdentifier - avoid unnecessary work
  if (!identifier || identifier.trim() === "") {
    return null;
  }

  const kind = resolveUserIdentifierKind(identifier);
  // WHY same cache key as findUserByIdentifier? Both functions look up the same user
  // Using the same cache key means cache entries are shared between the two functions
  // This further maximizes cache hit rate across the codebase
  const cacheKey = getUserIdentifierCacheKey(identifier, kind);

  // Fetch from cache or database
  const user = await getCacheOrFetch(
    cacheKey,
    async () => fetchUserByClassifiedIdentifier(identifier, kind),
    {
      namespace: CACHE_KEYS.USER_IDENTIFIER,
      ttl: DEFAULT_TTLS.USER, // WHY 300s? Same as other user caches - balances freshness vs hit rate
    },
  );

  if (!user) return null;

  // WHY filter in memory? Drizzle select objects have field names as keys
  // Object.keys({ id: users.id, username: users.username }) returns ["id", "username"]
  // These keys match the field names in the cached user object, so we can filter directly
  // This is fast (microseconds) compared to a database query (milliseconds)
  const filtered: Record<string, unknown> = {};
  for (const key of Object.keys(select)) {
    if (key in user) {
      filtered[key] = (user as Record<string, unknown>)[key];
    }
  }

  return filtered as T;
}

/**
 * Require user by identifier (throws if not found)
 *
 * @description Searches for a user and throws NotFoundError if not found.
 *
 * @param {string} identifier - The user ID, privyId, or username
 * @param {Record<string, boolean>} [_select] - Optional select fields (for compatibility)
 * @returns {Promise<User>} User object
 * @throws {NotFoundError} If user is not found
 *
 * @example
 * ```typescript
 * try {
 *   const user = await requireUserByIdentifier('alice');
 *   console.log(user.displayName);
 * } catch (e) {
 *   // Handle not found
 * }
 * ```
 */
export async function requireUserByIdentifier(
  identifier: string,
  _select?: Record<string, boolean>,
): Promise<User> {
  const user = await findUserByIdentifier(identifier);
  if (!user) {
    throw new NotFoundError("User", undefined, { identifier });
  }
  return user;
}

/**
 * Result of finding a target by identifier
 */
export interface TargetLookupResult {
  /** The user if found, null otherwise */
  user: User | null;
  /** The actor if found, null otherwise */
  actor: StaticActor | null;
  /** The resolved target ID (user.id or actor.id) */
  targetId: string | null;
  /** Whether the target is an actor (NPC) */
  isActor: boolean;
}

/**
 * Find target (user or actor) by identifier
 *
 * @description Searches for a user first, then falls back to actor lookup.
 * This is useful for API routes that need to handle both users and actors.
 *
 * @param {string} identifier - The user ID, privyId, username, or actor ID
 * @returns {Promise<TargetLookupResult>} Result containing user, actor, and resolved targetId
 *
 * @example
 * ```typescript
 * const { user, actor, targetId, isActor } = await findTargetByIdentifier('elon-usk');
 * if (!targetId) {
 *   throw new NotFoundError('User', undefined, { identifier });
 * }
 * ```
 */
export async function findTargetByIdentifier(
  identifier: string,
): Promise<TargetLookupResult> {
  // Try to find as user first
  const user = await findUserByIdentifier(identifier);

  if (user) {
    return {
      user,
      actor: null,
      targetId: user.id,
      isActor: false,
    };
  }

  // Check if it's an actor (NPC) - now also searches by username
  const actor = StaticDataRegistry.getActor(identifier);

  if (actor) {
    return {
      user: null,
      actor,
      targetId: actor.id,
      isActor: true,
    };
  }

  // Neither found
  return {
    user: null,
    actor: null,
    targetId: null,
    isActor: false,
  };
}

/**
 * Require target (user or actor) by identifier (throws if not found)
 *
 * @description Searches for a user or actor and throws NotFoundError if neither is found.
 *
 * @param {string} identifier - The user ID, privyId, username, or actor ID
 * @returns {Promise<TargetLookupResult>} Result containing user, actor, and resolved targetId
 * @throws {NotFoundError} If neither user nor actor is found
 *
 * @example
 * ```typescript
 * const { user, actor, targetId, isActor } = await requireTargetByIdentifier('elon-usk');
 * // targetId is guaranteed to be non-null here
 * ```
 */
export async function requireTargetByIdentifier(
  identifier: string,
): Promise<TargetLookupResult & { targetId: string }> {
  const result = await findTargetByIdentifier(identifier);

  if (!result.targetId) {
    throw new NotFoundError("User", undefined, { identifier });
  }

  return result as TargetLookupResult & { targetId: string };
}
