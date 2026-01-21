/**
 * User Data Export API
 *
 * @route GET /api/users/export-data - Export user data
 * @access Authenticated
 *
 * @description
 * Exports all user data in JSON format for GDPR compliance (right to data portability).
 * Includes user profile, posts, comments, reactions, positions, transactions, referrals,
 * notifications, and all associated data.
 *
 * @openapi
 * /api/users/export-data:
 *   get:
 *     tags:
 *       - Users
 *     summary: Export user data
 *     description: Exports all user data for GDPR compliance (right to data portability)
 *     security:
 *       - PrivyAuth: []
 *     responses:
 *       200:
 *         description: User data exported successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *                 posts:
 *                   type: array
 *                 comments:
 *                   type: array
 *                 reactions:
 *                   type: array
 *                 positions:
 *                   type: array
 *                 transactions:
 *                   type: array
 *                 referrals:
 *                   type: array
 *                 notifications:
 *                   type: array
 *                 exportedAt:
 *                   type: string
 *                   format: date-time
 *       401:
 *         description: Unauthorized
 *
 * @example
 * ```typescript
 * const data = await fetch('/api/users/export-data', {
 *   headers: { 'Authorization': `Bearer ${token}` }
 * }).then(r => r.json());
 * ```
 *
 * @see GDPR Article 20 - Right to data portability
 */

import {
  authenticate,
  successResponse,
  withErrorHandling,
} from "@polyagent/api";
import {
  agentPerformanceMetrics,
  balanceTransactions,
  comments,
  db,
  desc,
  eq,
  feedbacks,
  follows,
  notifications,
  or,
  pointsTransactions,
  positions,
  posts,
  reactions,
  referrals,
  tradingFees,
  users,
} from "@polyagent/db";
import { logger } from "@polyagent/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const GET = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);
  const userId = authUser.dbUserId ?? authUser.userId;

  logger.info(
    "User requested data export",
    { userId },
    "GET /api/users/export-data",
  );

  // Fetch all user data from database
  const [
    [user],
    userComments,
    userReactions,
    userPosts,
    userPositions,
    userFollows,
    userFollowers,
    userBalanceTransactions,
    userPointsTransactions,
    userReferrals,
    userNotifications,
    userFeedback,
    [performanceMetrics],
    userTradingFees,
    referralFeesEarned,
  ] = await Promise.all([
    db
      .select({
        id: users.id,
        privyId: users.privyId,
        walletAddress: users.walletAddress,
        username: users.username,
        displayName: users.displayName,
        bio: users.bio,
        profileImageUrl: users.profileImageUrl,
        coverImageUrl: users.coverImageUrl,
        email: users.email,
        virtualBalance: users.virtualBalance,
        totalDeposited: users.totalDeposited,
        totalWithdrawn: users.totalWithdrawn,
        lifetimePnL: users.lifetimePnL,
        onChainRegistered: users.onChainRegistered,
        nftTokenId: users.nftTokenId,
        registrationTxHash: users.registrationTxHash,
        registrationBlockNumber: users.registrationBlockNumber,
        registrationTimestamp: users.registrationTimestamp,
        reputationPoints: users.reputationPoints,
        invitePoints: users.invitePoints,
        earnedPoints: users.earnedPoints,
        bonusPoints: users.bonusPoints,
        profileComplete: users.profileComplete,
        hasFarcaster: users.hasFarcaster,
        hasTwitter: users.hasTwitter,
        farcasterUsername: users.farcasterUsername,
        farcasterFid: users.farcasterFid,
        twitterUsername: users.twitterUsername,
        twitterId: users.twitterId,
        referralCode: users.referralCode,
        referredBy: users.referredBy,
        referralCount: users.referralCount,
        waitlistPosition: users.waitlistPosition,
        waitlistJoinedAt: users.waitlistJoinedAt,
        isWaitlistActive: users.isWaitlistActive,
        waitlistGraduatedAt: users.waitlistGraduatedAt,
        tosAccepted: users.tosAccepted,
        tosAcceptedAt: users.tosAcceptedAt,
        tosAcceptedVersion: users.tosAcceptedVersion,
        privacyPolicyAccepted: users.privacyPolicyAccepted,
        privacyPolicyAcceptedAt: users.privacyPolicyAcceptedAt,
        privacyPolicyAcceptedVersion: users.privacyPolicyAcceptedVersion,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
    db
      .select({
        id: comments.id,
        content: comments.content,
        postId: comments.postId,
        parentCommentId: comments.parentCommentId,
        createdAt: comments.createdAt,
        updatedAt: comments.updatedAt,
      })
      .from(comments)
      .where(eq(comments.authorId, userId)),
    db
      .select({
        id: reactions.id,
        postId: reactions.postId,
        commentId: reactions.commentId,
        type: reactions.type,
        createdAt: reactions.createdAt,
      })
      .from(reactions)
      .where(eq(reactions.userId, userId)),
    db
      .select({
        id: posts.id,
        type: posts.type,
        content: posts.content,
        fullContent: posts.fullContent,
        articleTitle: posts.articleTitle,
        timestamp: posts.timestamp,
        createdAt: posts.createdAt,
        deletedAt: posts.deletedAt, // Include deleted status for GDPR export
      })
      .from(posts)
      .where(eq(posts.authorId, userId)),
    db
      .select({
        id: positions.id,
        marketId: positions.marketId,
        side: positions.side,
        shares: positions.shares,
        avgPrice: positions.avgPrice,
        createdAt: positions.createdAt,
        updatedAt: positions.updatedAt,
      })
      .from(positions)
      .where(eq(positions.userId, userId)),
    db
      .select({
        id: follows.id,
        followingId: follows.followingId,
        createdAt: follows.createdAt,
      })
      .from(follows)
      .where(eq(follows.followerId, userId)),
    db
      .select({
        id: follows.id,
        followerId: follows.followerId,
        createdAt: follows.createdAt,
      })
      .from(follows)
      .where(eq(follows.followingId, userId)),
    db
      .select({
        id: balanceTransactions.id,
        type: balanceTransactions.type,
        amount: balanceTransactions.amount,
        balanceBefore: balanceTransactions.balanceBefore,
        balanceAfter: balanceTransactions.balanceAfter,
        relatedId: balanceTransactions.relatedId,
        description: balanceTransactions.description,
        createdAt: balanceTransactions.createdAt,
      })
      .from(balanceTransactions)
      .where(eq(balanceTransactions.userId, userId))
      .orderBy(desc(balanceTransactions.createdAt)),
    db
      .select({
        id: pointsTransactions.id,
        amount: pointsTransactions.amount,
        pointsBefore: pointsTransactions.pointsBefore,
        pointsAfter: pointsTransactions.pointsAfter,
        reason: pointsTransactions.reason,
        metadata: pointsTransactions.metadata,
        createdAt: pointsTransactions.createdAt,
      })
      .from(pointsTransactions)
      .where(eq(pointsTransactions.userId, userId))
      .orderBy(desc(pointsTransactions.createdAt)),
    db
      .select({
        id: referrals.id,
        referralCode: referrals.referralCode,
        referredUserId: referrals.referredUserId,
        status: referrals.status,
        createdAt: referrals.createdAt,
        completedAt: referrals.completedAt,
      })
      .from(referrals)
      .where(eq(referrals.referrerId, userId)),
    db
      .select({
        id: notifications.id,
        type: notifications.type,
        actorId: notifications.actorId,
        postId: notifications.postId,
        commentId: notifications.commentId,
        title: notifications.title,
        message: notifications.message,
        read: notifications.read,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt))
      .limit(100), // Limit to recent notifications
    db
      .select({
        id: feedbacks.id,
        fromUserId: feedbacks.fromUserId,
        toUserId: feedbacks.toUserId,
        score: feedbacks.score,
        rating: feedbacks.rating,
        comment: feedbacks.comment,
        category: feedbacks.category,
        interactionType: feedbacks.interactionType,
        createdAt: feedbacks.createdAt,
      })
      .from(feedbacks)
      .where(
        or(eq(feedbacks.fromUserId, userId), eq(feedbacks.toUserId, userId)),
      ),
    db
      .select({
        id: agentPerformanceMetrics.id,
        gamesPlayed: agentPerformanceMetrics.gamesPlayed,
        gamesWon: agentPerformanceMetrics.gamesWon,
        averageGameScore: agentPerformanceMetrics.averageGameScore,
        normalizedPnL: agentPerformanceMetrics.normalizedPnL,
        totalTrades: agentPerformanceMetrics.totalTrades,
        profitableTrades: agentPerformanceMetrics.profitableTrades,
        winRate: agentPerformanceMetrics.winRate,
        averageROI: agentPerformanceMetrics.averageROI,
        reputationScore: agentPerformanceMetrics.reputationScore,
        trustLevel: agentPerformanceMetrics.trustLevel,
        totalFeedbackCount: agentPerformanceMetrics.totalFeedbackCount,
        averageFeedbackScore: agentPerformanceMetrics.averageFeedbackScore,
        createdAt: agentPerformanceMetrics.createdAt,
        updatedAt: agentPerformanceMetrics.updatedAt,
      })
      .from(agentPerformanceMetrics)
      .where(eq(agentPerformanceMetrics.userId, userId))
      .limit(1),
    db
      .select({
        id: tradingFees.id,
        tradeType: tradingFees.tradeType,
        tradeId: tradingFees.tradeId,
        marketId: tradingFees.marketId,
        feeAmount: tradingFees.feeAmount,
        platformFee: tradingFees.platformFee,
        referrerFee: tradingFees.referrerFee,
        createdAt: tradingFees.createdAt,
      })
      .from(tradingFees)
      .where(eq(tradingFees.userId, userId))
      .orderBy(desc(tradingFees.createdAt))
      .limit(100),
    db
      .select({
        id: tradingFees.id,
        userId: tradingFees.userId,
        tradeType: tradingFees.tradeType,
        referrerFee: tradingFees.referrerFee,
        createdAt: tradingFees.createdAt,
      })
      .from(tradingFees)
      .where(eq(tradingFees.referrerId, userId))
      .orderBy(desc(tradingFees.createdAt))
      .limit(100),
  ]);

  if (!user) {
    return successResponse({ error: "User not found" }, 404);
  }

  // Compile all data into a comprehensive export
  const exportData = {
    export_info: {
      exported_at: new Date().toISOString(),
      user_id: userId,
      format_version: "1.0",
    },
    personal_information: {
      ...user,
      // Important notice about blockchain data
      blockchain_notice:
        "On-chain data (wallet address, NFT token ID, registration transaction) is recorded on public blockchain and cannot be deleted.",
    },
    content: {
      posts: userPosts,
      comments: userComments,
      reactions: userReactions,
    },
    trading: {
      positions: userPositions,
      balance_transactions: userBalanceTransactions,
    },
    social: {
      following: userFollows,
      followers: userFollowers,
      referrals: userReferrals,
    },
    points_and_reputation: {
      points_transactions: userPointsTransactions,
      performance_metrics: performanceMetrics || null,
      feedback_given_and_received: userFeedback,
    },
    financial: {
      trading_fees_paid: userTradingFees,
      referral_fees_earned: referralFeesEarned,
    },
    notifications: userNotifications,
    legal_consent: {
      terms_of_service: {
        accepted: user.tosAccepted,
        accepted_at: user.tosAcceptedAt,
        version: user.tosAcceptedVersion,
      },
      privacy_policy: {
        accepted: user.privacyPolicyAccepted,
        accepted_at: user.privacyPolicyAcceptedAt,
        version: user.privacyPolicyAcceptedVersion,
      },
    },
  };

  // Return as JSON download
  return new NextResponse(JSON.stringify(exportData, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="polyagent-data-export-${userId}-${Date.now()}.json"`,
    },
  });
});
