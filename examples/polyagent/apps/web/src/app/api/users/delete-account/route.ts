/**
 * User Account Deletion API
 *
 * @route POST /api/users/delete-account - Delete user account
 * @access Authenticated
 *
 * @description
 * Permanently deletes user account and associated data (GDPR right to erasure).
 * Performs cascading deletion of user data while preserving anonymized data for
 * analytics. Includes blockchain data notice for on-chain registered users.
 *
 * @openapi
 * /api/users/delete-account:
 *   post:
 *     tags:
 *       - Users
 *     summary: Delete user account
 *     description: Permanently deletes user account and data (GDPR compliance)
 *     security:
 *       - PrivyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - confirmation
 *             properties:
 *               confirmation:
 *                 type: string
 *                 enum: [DELETE MY ACCOUNT]
 *                 description: Confirmation text required for deletion
 *               reason:
 *                 type: string
 *                 description: Optional reason for deletion
 *     responses:
 *       200:
 *         description: Account deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 deleted_data:
 *                   type: object
 *                 blockchain_notice:
 *                   type: object
 *                   nullable: true
 *                 important_notes:
 *                   type: array
 *                   items:
 *                     type: string
 *       400:
 *         description: Invalid confirmation text
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: User not found
 *
 * @example
 * ```typescript
 * await fetch('/api/users/delete-account', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({
 *     confirmation: 'DELETE MY ACCOUNT',
 *     reason: 'Privacy concerns'
 *   })
 * });
 * ```
 *
 * @see GDPR Article 17 - Right to erasure
 */

import { authenticate, successResponse, withErrorHandling } from "@babylon/api";
import {
  db,
  eq,
  feedbacks,
  followStatuses,
  groupInvites,
  groupMembers,
  or,
  referrals,
  shareActions,
  tradingFees,
  userActorFollows,
  userInteractions,
  users,
  withTransaction,
} from "@babylon/db";
import { logger } from "@babylon/shared";
import type { NextRequest } from "next/server";
import { z } from "zod";

const DeleteAccountSchema = z.object({
  confirmation: z.literal("DELETE MY ACCOUNT"),
  reason: z.string().optional(),
});

export const POST = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);
  const userId = authUser.dbUserId ?? authUser.userId;

  const body = await request.json();
  const { reason } = DeleteAccountSchema.parse(body);

  logger.info(
    "User requested account deletion",
    { userId, reason: reason || "No reason provided" },
    "POST /api/users/delete-account",
  );

  // Verify user exists
  const [user] = await db
    .select({
      id: users.id,
      username: users.username,
      walletAddress: users.walletAddress,
      onChainRegistered: users.onChainRegistered,
      nftTokenId: users.nftTokenId,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    return successResponse({ error: "User not found" }, 404);
  }

  // Important notice about blockchain data
  const blockchainNotice = user.onChainRegistered
    ? {
        blockchain_data_notice:
          "Your on-chain data (wallet address, NFT token ID, transaction history) is permanently recorded on the blockchain and cannot be deleted. It will remain publicly visible.",
        wallet_address: user.walletAddress,
        nft_token_id: user.nftTokenId,
      }
    : null;

  // Perform cascading deletion in a transaction
  // Note: Many relationships have onDelete: Cascade in schema, cascades handle them
  await withTransaction(async (tx) => {
    // Delete related data that doesn't cascade automatically or needs special handling

    // Delete referral relationships - set referredUserId to null
    await tx
      .update(referrals)
      .set({ referredUserId: null })
      .where(eq(referrals.referredUserId, userId));

    // Delete trading fees where user was referrer (set to null)
    await tx
      .update(tradingFees)
      .set({ referrerId: null })
      .where(eq(tradingFees.referrerId, userId));

    // Anonymize feedback (preserve for AI training but disconnect from user)
    await tx
      .update(feedbacks)
      .set({ fromUserId: null })
      .where(eq(feedbacks.fromUserId, userId));

    await tx
      .update(feedbacks)
      .set({ toUserId: null })
      .where(eq(feedbacks.toUserId, userId));

    // Delete user actor follows
    await tx
      .delete(userActorFollows)
      .where(eq(userActorFollows.userId, userId));

    // Delete user interactions
    await tx
      .delete(userInteractions)
      .where(eq(userInteractions.userId, userId));

    // Delete group memberships
    await tx.delete(groupMembers).where(eq(groupMembers.userId, userId));

    // Delete group invites (both received and sent)
    await tx
      .delete(groupInvites)
      .where(
        or(
          eq(groupInvites.invitedUserId, userId),
          eq(groupInvites.invitedBy, userId),
        ),
      );

    // Delete follow status
    await tx.delete(followStatuses).where(eq(followStatuses.userId, userId));

    // Delete share actions
    await tx.delete(shareActions).where(eq(shareActions.userId, userId));

    // Finally, delete the user (this will cascade to most other tables)
    await tx.delete(users).where(eq(users.id, userId));

    logger.info(
      "User account deleted successfully",
      { userId, username: user.username },
      "POST /api/users/delete-account",
    );
  });

  return successResponse({
    success: true,
    message: "Your account has been permanently deleted.",
    deleted_data: {
      user_id: userId,
      username: user.username,
      deletion_time: new Date().toISOString(),
    },
    ...(blockchainNotice ? { blockchain_notice: blockchainNotice } : {}),
    important_notes: [
      "Your account and personal data have been deleted from our servers.",
      "Some anonymized data may be retained for analytics and AI training.",
      "Blockchain data (if any) remains permanently on the blockchain and cannot be deleted.",
      "If you registered via email, you may need to contact our authentication provider (Privy) to delete your auth account separately.",
    ],
  });
});
