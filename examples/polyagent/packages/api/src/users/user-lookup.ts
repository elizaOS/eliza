/**
 * User Lookup Utilities
 *
 * @description Utilities for finding users by various identifiers (ID, privyId, username).
 */

import { db, eq, or, users } from "@babylon/db";
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { SelectedFields } from "drizzle-orm/pg-core";
import { NotFoundError } from "../errors";

type User = InferSelectModel<typeof users>;

/**
 * Find user by identifier (ID, privyId, or username)
 *
 * @description Searches for a user by their ID, privyId, or username.
 * Returns null if no user is found. Username matching is case-insensitive.
 *
 * @param {string} identifier - The user ID, privyId, or username
 * @param {Record<string, boolean>} [_select] - Optional select fields (for compatibility, currently ignored)
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
  _select?: Record<string, boolean>,
): Promise<User | null> {
  // Try to find by ID, privyId, or username (case-insensitive for username)
  const [user] = await db
    .select()
    .from(users)
    .where(
      or(
        eq(users.id, identifier),
        eq(users.privyId, identifier),
        sql`lower(${users.username}) = lower(${identifier})`,
      ),
    )
    .limit(1);

  return user ?? null;
}

/**
 * Find user by identifier with custom select fields
 *
 * @description Searches for a user with a custom selection of fields.
 * Username matching is case-insensitive.
 *
 * @param {string} identifier - The user ID, privyId, or username
 * @param {T} select - Fields to select
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
  // Drizzle's select() accepts SelectedFields which is compatible with our select object
  const [user] = await db
    .select(select as SelectedFields)
    .from(users)
    .where(
      or(
        eq(users.id, identifier),
        eq(users.privyId, identifier),
        sql`lower(${users.username}) = lower(${identifier})`,
      ),
    )
    .limit(1);

  if (!user) return null;
  return user as T;
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
  /** The resolved target (user.id) */
  target: string | null;
}

/**
 * Find target (user) by identifier
 *
 * @description Searches for a user by identifier.
 *
 * @param {string} identifier - The user ID, privyId, or username
 * @returns {Promise<TargetLookupResult>} Result containing user and resolved target
 *
 * @example
 * ```typescript
 * const { user, target } = await findTargetByIdentifier('alice');
 * if (!target) {
 *   throw new NotFoundError('User', undefined, { identifier });
 * }
 * ```
 */
export async function findTargetByIdentifier(
  identifier: string,
): Promise<TargetLookupResult> {
  const user = await findUserByIdentifier(identifier);

  if (user) {
    return {
      user,
      target: user.id,
    };
  }

  return {
    user: null,
    target: null,
  };
}

/**
 * Require target (user) by identifier (throws if not found)
 *
 * @description Searches for a user and throws NotFoundError if not found.
 *
 * @param {string} identifier - The user ID, privyId, or username
 * @returns {Promise<TargetLookupResult>} Result containing user and resolved target
 * @throws {NotFoundError} If user is not found
 *
 * @example
 * ```typescript
 * const { user, target } = await requireTargetByIdentifier('alice');
 * // target is guaranteed to be non-null here
 * ```
 */
export async function requireTargetByIdentifier(
  identifier: string,
): Promise<TargetLookupResult & { target: string }> {
  const result = await findTargetByIdentifier(identifier);

  if (!result.target) {
    throw new NotFoundError("User", undefined, { identifier });
  }

  return result as TargetLookupResult & { target: string };
}
