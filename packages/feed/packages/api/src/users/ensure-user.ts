/**
 * User Management Utilities
 *
 * @description Utilities for ensuring users exist in the database and managing
 * canonical user IDs. Handles user creation and updates based on authentication
 * information.
 */

import { db, eq, type User, users } from '@babylon/db';
import {
  generateSnowflakeId,
  resolveUserIdentifierKind,
} from '@babylon/shared';
import { sql } from 'drizzle-orm';
import type { AuthenticatedUser } from '../auth-middleware';
import { cachedDb } from '../cache/cached-database-service';
import { findUserByIdentifier } from './user-lookup';

/**
 * Options for ensuring user exists
 *
 * @description Configuration options for user creation/update.
 */
export interface EnsureUserOptions {
  displayName?: string;
  username?: string | null;
  isActor?: boolean;
}

export type CanonicalUser = Pick<
  User,
  | 'id'
  | 'privyId'
  | 'stewardId'
  | 'username'
  | 'displayName'
  | 'walletAddress'
  | 'isActor'
  | 'profileImageUrl'
>;

type MinimalUser = Pick<User, 'id'>;

const canonicalUserSelect = {
  id: users.id,
  privyId: users.privyId,
  stewardId: users.stewardId,
  username: users.username,
  displayName: users.displayName,
  walletAddress: users.walletAddress,
  isActor: users.isActor,
  profileImageUrl: users.profileImageUrl,
};

async function findMinimalUserByIdentifierDirect(
  identifier: string
): Promise<MinimalUser | null> {
  const normalizedIdentifier = identifier.trim();

  if (!normalizedIdentifier) {
    return null;
  }

  const kind = resolveUserIdentifierKind(normalizedIdentifier);
  const condition =
    kind === 'id'
      ? eq(users.id, normalizedIdentifier)
      : kind === 'privyId'
        ? eq(users.privyId, normalizedIdentifier)
        : sql`lower(${users.username}) = lower(${normalizedIdentifier})`;

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(condition)
    .limit(1);

  if (user) {
    return user;
  }

  // Minimal public bootstrap stores the incoming identifier in users.id even
  // when the original lookup was by username, so the conflict-reload path must
  // also retry by primary key for any non-ID identifier kind.
  if (kind !== 'id') {
    const [byId] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, normalizedIdentifier))
      .limit(1);
    return byId ?? null;
  }

  return null;
}

async function findCanonicalUserByAuthIdentifiersDirect(
  privyId: string,
  userId: string
): Promise<CanonicalUser | null> {
  const [byPrivyId] = await db
    .select(canonicalUserSelect)
    .from(users)
    .where(eq(users.privyId, privyId))
    .limit(1);

  if (byPrivyId) {
    return byPrivyId;
  }

  const [byId] = await db
    .select(canonicalUserSelect)
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return byId ?? null;
}

/**
 * Ensure a minimal user row exists for public identifier-based endpoints.
 *
 * Uses insert-or-reload so concurrent first access does not fail with a duplicate
 * key error if another request creates the same user between the initial lookup
 * and insert attempt.
 */
export async function ensureMinimalUserByIdentifier(
  identifier: string
): Promise<MinimalUser> {
  const normalizedIdentifier = identifier.trim();

  const existingUser = await findUserByIdentifier(normalizedIdentifier, {
    id: true,
  });

  if (existingUser) {
    return { id: existingUser.id };
  }

  const [createdUser] = await db
    .insert(users)
    .values({
      id: normalizedIdentifier,
      privyId: normalizedIdentifier,
      isActor: false,
      updatedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: users.id });

  if (createdUser) {
    await cachedDb.invalidateUserIdentifierCaches({
      id: createdUser.id,
      privyId: normalizedIdentifier,
      username: null,
    });

    return createdUser;
  }

  const concurrentUser =
    await findMinimalUserByIdentifierDirect(normalizedIdentifier);

  if (!concurrentUser) {
    throw new Error('Failed to create or find user');
  }

  return concurrentUser;
}

/**
 * Ensure user exists in database for authenticated user
 *
 * @description Creates or updates a user record based on authenticated user
 * information. Uses an insert-or-reload flow so concurrent requests can race
 * safely without surfacing duplicate-key errors. Updates dbUserId on the
 * authenticated user object.
 *
 * @param {AuthenticatedUser} user - Authenticated user information
 * @param {EnsureUserOptions} [options={}] - Options for user creation/update
 * @returns {Promise<{user: CanonicalUser}>} Canonical user object
 *
 * @example
 * ```typescript
 * const { user } = await ensureUserForAuth(authUser, {
 *   username: 'alice',
 *   displayName: 'Alice'
 * });
 * ```
 */
export async function ensureUserForAuth(
  user: AuthenticatedUser,
  options: EnsureUserOptions = {}
): Promise<{ user: CanonicalUser }> {
  const privyId = user.privyId ?? user.userId;
  const canonicalUserId = user.dbUserId ?? user.userId;

  // Check if user exists
  const existing = await db
    .select(canonicalUserSelect)
    .from(users)
    .where(eq(users.privyId, privyId))
    .limit(1);

  if (existing.length > 0 && existing[0]) {
    // User exists - update if needed
    const existingUser = existing[0];
    const updateData: Partial<typeof users.$inferInsert> = {};

    if (
      user.walletAddress &&
      user.walletAddress !== existingUser.walletAddress
    ) {
      updateData.walletAddress = user.walletAddress;
    }
    if (
      options.username !== undefined &&
      options.username !== existingUser.username
    ) {
      updateData.username = options.username;
    }
    if (
      options.isActor !== undefined &&
      options.isActor !== existingUser.isActor
    ) {
      updateData.isActor = options.isActor;
    }
    if (options.displayName !== undefined && !existingUser.displayName) {
      updateData.displayName = options.displayName;
    }

    if (Object.keys(updateData).length > 0) {
      const oldUsername = existingUser.username;
      const oldPrivyId = existingUser.privyId;

      const updated = await db
        .update(users)
        .set(updateData)
        .where(eq(users.id, existingUser.id))
        .returning(canonicalUserSelect);

      const updatedUser = updated[0]!;
      user.dbUserId = updatedUser.id;

      // Refresh identifier caches after any successful user update because lookups
      // now cache the full user row under identifier-based keys.
      const usernameChanged =
        options.username !== undefined && oldUsername !== updatedUser.username;
      const privyIdChanged = oldPrivyId !== updatedUser.privyId;

      await cachedDb.invalidateUserIdentifierCaches(
        {
          id: updatedUser.id,
          privyId: updatedUser.privyId,
          username: updatedUser.username,
        },
        {
          username: usernameChanged ? oldUsername : undefined,
          privyId: privyIdChanged ? oldPrivyId : undefined,
        }
      );

      return { user: updatedUser };
    }

    user.dbUserId = existingUser.id;
    return { user: existingUser };
  }

  // Create new user
  const createData: typeof users.$inferInsert = {
    id: canonicalUserId,
    privyId,
    isActor: options.isActor ?? false,
    updatedAt: new Date(),
  };

  if (user.walletAddress) {
    createData.walletAddress = user.walletAddress;
  }
  if (options.username !== undefined) {
    createData.username = options.username ?? null;
  }
  if (options.displayName !== undefined) {
    createData.displayName = options.displayName;
  }

  const [createdUser] = await db
    .insert(users)
    .values(createData)
    .onConflictDoNothing()
    .returning(canonicalUserSelect);

  if (!createdUser) {
    const concurrentUser = await findCanonicalUserByAuthIdentifiersDirect(
      privyId,
      canonicalUserId
    );

    if (!concurrentUser) {
      throw new Error('Failed to create or find user');
    }

    user.dbUserId = concurrentUser.id;
    return { user: concurrentUser };
  }

  user.dbUserId = createdUser.id;

  // Invalidate identifier caches for the new user (clears negative cache)
  await cachedDb.invalidateUserIdentifierCaches({
    id: createdUser.id,
    privyId: createdUser.privyId,
    username: createdUser.username,
  });

  return { user: createdUser };
}

/**
 * Get canonical user ID
 */
export function getCanonicalUserId(
  user: Pick<AuthenticatedUser, 'userId' | 'dbUserId'>
): string {
  return user.dbUserId ?? user.userId;
}

/**
 * Ensure a Babylon user record exists for a Steward-authenticated user.
 *
 * Called by auth-middleware when a Steward JWT arrives and no existing user
 * is found by stewardId or email. Creates a new minimal Babylon user and
 * links the stewardId.
 *
 * Idempotent: uses onConflictDoUpdate to handle concurrent first-logins.
 */
export async function ensureUserFromSteward(
  stewardUserId: string,
  email?: string
): Promise<{
  id: string;
  stewardId: string | null;
  privyId: string | null;
  email: string | null;
  isAdmin: boolean;
  isAgent: boolean;
}> {
  // Try insert first — generate a new Babylon snowflake ID for this user
  const newId = await generateSnowflakeId();
  const inserted = await db
    .insert(users)
    .values({
      id: newId,
      stewardId: stewardUserId,
      email: email ?? null,
      isActor: false,
      updatedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({
      id: users.id,
      stewardId: users.stewardId,
      privyId: users.privyId,
      email: users.email,
      isAdmin: users.isAdmin,
      isAgent: users.isAgent,
    });

  if (inserted[0]) return inserted[0];

  // Concurrent insert already created this stewardId — read back
  const [existing] = await db
    .select({
      id: users.id,
      stewardId: users.stewardId,
      privyId: users.privyId,
      email: users.email,
      isAdmin: users.isAdmin,
      isAgent: users.isAgent,
    })
    .from(users)
    .where(eq(users.stewardId, stewardUserId))
    .limit(1);

  if (!existing) {
    throw new Error(
      `ensureUserFromSteward: failed to find or create user for stewardId ${stewardUserId}`
    );
  }

  // Update email if we have one now and the existing record doesn't
  if (email && !existing.email) {
    await db.update(users).set({ email }).where(eq(users.id, existing.id));
    existing.email = email;
  }

  return existing;
}
