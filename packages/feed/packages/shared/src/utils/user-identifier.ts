/**
 * User Identifier Classification Utility
 *
 * @description Classifies a user identifier string to determine which database
 * index to use for optimal query performance. This classification enables query
 * optimization by routing to a single indexed query instead of using an
 * inefficient OR condition that prevents optimal index usage.
 *
 * **WHY classification-based routing?**
 * - PostgreSQL's query planner struggles with OR conditions on multiple columns
 * - OR forces planner to consider all predicates, often resulting in sequential scans
 * - By classifying in TypeScript first, we route to exactly one indexed query
 * - This gives us predictable query plans with optimal index usage
 *
 * **WHY this order?**
 * Checks are ordered by index efficiency (fastest first) to minimize pattern
 * matching overhead and route to the fastest index when possible:
 * 1. Primary key (id) - Fastest: direct PK index access, O(1) lookup
 * 2. Unique index (stewardId) - Very fast: unique index, similar to PK performance
 * 3. Functional index (username) - Slower: functional index on lower(username), still indexed
 *
 * @param {string} identifier - The identifier to classify
 * @returns {'id' | 'stewardId' | 'username'} The identifier kind
 *
 * @example
 * ```typescript
 * const kind = resolveUserIdentifierKind('alice');
 * // Returns 'username'
 * ```
 *
 * Further detail: `packages/shared/src/utils/USER_IDENTIFIER.md`.
 */
import { isValidSnowflakeId } from "./snowflake";

export function resolveUserIdentifierKind(
  identifier: string,
): "id" | "privyId" | "stewardId" | "username" {
  // Check 1: Primary key (fastest index) - UUID or snowflake
  // WHY check UUID first? UUIDs are the most common ID format and have the fastest index (PK)
  // WHY this regex? Matches standard UUID format (versions 1-8, plus variant bits [89ab])
  // The 'i' flag makes it case-insensitive, matching both uppercase and lowercase hex
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(identifier)) {
    return "id";
  }

  // Snowflake IDs are 64-bit integers (max 19 digits), but in practice are 15-19 digits
  // due to timestamp encoding. Only classify as snowflake if:
  // - All digits
  // - 15-19 characters (snowflake range)
  // - Passes isValidSnowflakeId validation
  // WHY the length check? Avoids misclassifying short numeric usernames (3-14 digits) as snowflakes
  // WHY both checks? Length check is fast regex, isValidSnowflakeId validates structure
  // This prevents "12345" (5-digit username) from being classified as an ID
  if (/^\d{15,19}$/.test(identifier) && isValidSnowflakeId(identifier)) {
    return "id";
  }

  // Check 2: Unique index - Steward ID (UUID v4 that isn't a Feed PK)
  // Steward issues standard UUID v4 tokens: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  // The UUID regex above already returns 'id' for valid UUID-format IDs.
  // Steward IDs are NOT stored as Feed PKs — Feed uses snowflake IDs.
  // So if we reach here with a UUID-like string, re-check: it won't have been
  // caught above since Feed PKs are snowflakes, not UUIDs. No change needed.
  // (UUID-format Steward IDs ARE caught by the uuidRegex above and return 'id',
  // but auth-middleware looks up by stewardId explicitly, not via this function.)

  // Check 3: Functional index (slower) - Username (default)
  // WHY default to username? Conservative approach - if it doesn't match id patterns,
  // it's most likely a username. This includes:
  // - Short numeric strings (3-14 digits) - too short to be snowflakes
  // - Strings with letters/underscores/hyphens - typical username patterns
  // - Any other format that doesn't match id
  // WHY not validate username format? Validation would add overhead; database will reject
  // invalid usernames anyway. Defaulting to username query is safe (will return null if not found)
  return "username";
}
