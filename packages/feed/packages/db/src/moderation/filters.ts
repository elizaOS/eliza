/**
 * Moderation Filters
 *
 * Helper functions for filtering content based on user blocks and mutes.
 * Used to exclude blocked or muted users from feeds and search results.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { userBlocks, userMutes } from "../schema";

/**
 * Get list of user IDs that the current user has blocked.
 *
 * @param userId - Current user's ID
 * @returns Array of blocked user IDs
 */
export async function getBlockedUserIds(userId: string): Promise<string[]> {
  const blocks = await db
    .select({ blockedId: userBlocks.blockedId })
    .from(userBlocks)
    .where(eq(userBlocks.blockerId, userId));

  return blocks.map((b) => b.blockedId);
}

/**
 * Get list of user IDs that have blocked the current user.
 *
 * @param userId - Current user's ID
 * @returns Array of user IDs who have blocked the current user
 */
export async function getBlockedByUserIds(userId: string): Promise<string[]> {
  const blocks = await db
    .select({ blockerId: userBlocks.blockerId })
    .from(userBlocks)
    .where(eq(userBlocks.blockedId, userId));

  return blocks.map((b) => b.blockerId);
}

/**
 * Get list of user IDs that the current user has muted.
 *
 * @param userId - Current user's ID
 * @returns Array of muted user IDs
 */
export async function getMutedUserIds(userId: string): Promise<string[]> {
  const mutes = await db
    .select({ mutedId: userMutes.mutedId })
    .from(userMutes)
    .where(eq(userMutes.muterId, userId));

  return mutes.map((m) => m.mutedId);
}

/**
 * Get all user IDs that should be filtered from the current user's feed.
 * Includes users blocked by the current user and users who have blocked the current user.
 *
 * @param userId - Current user's ID
 * @returns Array of user IDs to filter from feeds
 */
export async function getFilteredUserIds(userId: string): Promise<string[]> {
  const [blockedByMe, blockedMe] = await Promise.all([
    getBlockedUserIds(userId),
    getBlockedByUserIds(userId),
  ]);

  return [...new Set([...blockedByMe, ...blockedMe])];
}

/**
 * Check if one user has blocked another user.
 *
 * @param blockerId - ID of the user who may have blocked
 * @param blockedId - ID of the user who may be blocked
 * @returns True if blockerId has blocked blockedId
 */
export async function hasBlocked(
  blockerId: string,
  blockedId: string,
): Promise<boolean> {
  const block = await db
    .select({ blockerId: userBlocks.blockerId })
    .from(userBlocks)
    .where(
      and(
        eq(userBlocks.blockerId, blockerId),
        eq(userBlocks.blockedId, blockedId),
      ),
    )
    .limit(1);

  return block.length > 0;
}

/**
 * Check if one user has muted another user.
 *
 * @param muterId - ID of the user who may have muted
 * @param mutedId - ID of the user who may be muted
 * @returns True if muterId has muted mutedId
 */
export async function hasMuted(
  muterId: string,
  mutedId: string,
): Promise<boolean> {
  const mute = await db
    .select({ muterId: userMutes.muterId })
    .from(userMutes)
    .where(and(eq(userMutes.muterId, muterId), eq(userMutes.mutedId, mutedId)))
    .limit(1);

  return mute.length > 0;
}

/**
 * Filter an array of posts to exclude those from blocked or muted users.
 *
 * @param posts - Array of posts to filter
 * @param blockedUserIds - Array of blocked user IDs
 * @param mutedUserIds - Array of muted user IDs (default: empty array)
 * @returns Filtered array of posts
 */
export function filterPostsByModeration<T extends { authorId?: string }>(
  posts: T[],
  blockedUserIds: string[],
  mutedUserIds: string[] = [],
): T[] {
  const excludedIds = new Set([...blockedUserIds, ...mutedUserIds]);

  return posts.filter((post) => {
    if (!post.authorId) return true;
    return !excludedIds.has(post.authorId);
  });
}

/**
 * Build a where clause object to exclude blocked users from queries.
 *
 * @param blockedUserIds - Array of blocked user IDs
 * @returns Where clause object with authorId notIn condition, or empty object if no blocked users
 */
export function buildBlockedUsersWhereClause(blockedUserIds: string[]) {
  if (blockedUserIds.length === 0) {
    return {};
  }

  return {
    authorId: {
      notIn: blockedUserIds,
    },
  };
}
