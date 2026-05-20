/**
 * Participation Service
 *
 * @description Tracks off-chain user participation metrics including posts,
 * comments, shares, reactions, and market participation. Calculates total
 * activity scores and tracks last activity timestamps.
 */

import {
  and,
  comments,
  count,
  db,
  desc,
  eq,
  isNull,
  positions,
  posts,
  reactions,
  shares,
} from '@feed/db';

/**
 * Participation statistics for a user
 *
 * @description Contains aggregated participation metrics including counts
 * for various activity types and last activity timestamp.
 */
export interface ParticipationStats {
  postsCreated: number;
  commentsMade: number;
  sharesMade: number;
  reactionsGiven: number;
  marketsParticipated: number;
  totalActivity: number;
  lastActivityAt: Date;
}

/**
 * Participation Service Class
 *
 * @description Static service class for tracking user participation metrics.
 * Provides methods for retrieving participation statistics and calculating
 * activity scores.
 */
export class ParticipationService {
  /**
   * Get participation statistics for a user
   *
   * @description Retrieves comprehensive participation statistics for a user
   * including posts, comments, shares, reactions, and market participation.
   * Calculates total activity score and last activity timestamp.
   *
   * @param {string} userId - User ID to get stats for
   * @returns {Promise<ParticipationStats | null>} Participation stats or null if user not found
   */
  static async getStats(userId: string): Promise<ParticipationStats | null> {
    // Get all counts in parallel
    const [
      postsCountResult,
      commentsCountResult,
      sharesCountResult,
      reactionsCountResult,
      positionsCountResult,
      lastPostResult,
      lastCommentResult,
      lastShareResult,
      lastReactionResult,
      lastPositionResult,
    ] = await Promise.all([
      db
        .select({ count: count() })
        .from(posts)
        .where(eq(posts.authorId, userId)),
      db
        .select({ count: count() })
        .from(comments)
        .where(eq(comments.authorId, userId)),
      db
        .select({ count: count() })
        .from(shares)
        .where(eq(shares.userId, userId)),
      db
        .select({ count: count() })
        .from(reactions)
        .where(eq(reactions.userId, userId)),
      db
        .select({ count: count() })
        .from(positions)
        .where(eq(positions.userId, userId)),
      db
        .select({ createdAt: posts.createdAt })
        .from(posts)
        .where(and(eq(posts.authorId, userId), isNull(posts.deletedAt)))
        .orderBy(desc(posts.createdAt))
        .limit(1),
      db
        .select({ createdAt: comments.createdAt })
        .from(comments)
        .where(eq(comments.authorId, userId))
        .orderBy(desc(comments.createdAt))
        .limit(1),
      db
        .select({ createdAt: shares.createdAt })
        .from(shares)
        .where(eq(shares.userId, userId))
        .orderBy(desc(shares.createdAt))
        .limit(1),
      db
        .select({ createdAt: reactions.createdAt })
        .from(reactions)
        .where(eq(reactions.userId, userId))
        .orderBy(desc(reactions.createdAt))
        .limit(1),
      db
        .select({ createdAt: positions.createdAt })
        .from(positions)
        .where(eq(positions.userId, userId))
        .orderBy(desc(positions.createdAt))
        .limit(1),
    ]);

    const postsCreated = postsCountResult[0]?.count ?? 0;
    const commentsMade = commentsCountResult[0]?.count ?? 0;
    const sharesMade = sharesCountResult[0]?.count ?? 0;
    const reactionsGiven = reactionsCountResult[0]?.count ?? 0;
    const marketsParticipated = positionsCountResult[0]?.count ?? 0;
    const lastPost = lastPostResult[0];
    const lastComment = lastCommentResult[0];
    const lastShare = lastShareResult[0];
    const lastReaction = lastReactionResult[0];
    const lastPosition = lastPositionResult[0];

    // Calculate total activity score
    // Weighted scoring: posts=10, comments=5, shares=3, reactions=1, markets=5
    const totalActivity =
      postsCreated * 10 +
      commentsMade * 5 +
      sharesMade * 3 +
      reactionsGiven * 1 +
      marketsParticipated * 5;

    // Find the most recent activity timestamp
    const activityTimestamps = [
      lastPost?.createdAt,
      lastComment?.createdAt,
      lastShare?.createdAt,
      lastReaction?.createdAt,
      lastPosition?.createdAt,
    ].filter((date): date is Date => date !== null && date !== undefined);

    const lastActivityAt =
      activityTimestamps.length > 0
        ? new Date(Math.max(...activityTimestamps.map((d) => d.getTime())))
        : new Date(); // Default to now if no activity

    return {
      postsCreated,
      commentsMade,
      sharesMade,
      reactionsGiven,
      marketsParticipated,
      totalActivity,
      lastActivityAt,
    };
  }
}
