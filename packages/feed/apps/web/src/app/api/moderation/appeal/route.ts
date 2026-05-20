/**
 * Moderation Appeal API
 *
 * @route POST /api/moderation/appeal - Appeal ban
 * @access Authenticated
 *
 * @description
 * Allows banned users to appeal their ban. Supports free appeals (limited)
 * and staked appeals ($10) for faster review. Uses AI evaluation and
 * human review workflow.
 *
 * @openapi
 * /api/moderation/appeal:
 *   post:
 *     tags:
 *       - Moderation
 *     summary: Appeal ban
 *     description: Submits ban appeal with optional stake for faster review
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - reason
 *             properties:
 *               reason:
 *                 type: string
 *                 minLength: 10
 *                 maxLength: 2000
 *                 description: Appeal reasoning
 *               stakeTxHash:
 *                 type: string
 *                 description: Optional transaction hash for staked appeal ($10)
 *     responses:
 *       200:
 *         description: Appeal submitted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 appealStatus:
 *                   type: string
 *                 evaluation:
 *                   type: object
 *                   nullable: true
 *       400:
 *         description: Invalid appeal or already appealed
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: User not banned
 *
 * @example
 * ```typescript
 * await fetch('/api/moderation/appeal', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({
 *     reason: 'I believe this ban was a mistake...',
 *     stakeTxHash: '0x...' // Optional for staked appeal
 *   })
 * });
 * ```
 */

import {
  authenticate,
  callClaudeDirect,
  createNotification,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import type { JsonValue } from "@feed/db";
import { db } from "@feed/db";
import { WalletService } from "@feed/engine";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";
import { type Address, createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { z } from "zod";

const AppealSchema = z.object({
  reason: z.string().min(10).max(2000),
  stakeTxHash: z.string().optional(), // For staked appeals ($10)
});

export const POST = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);
  const userId = authUser.dbUserId!;

  const body = await request.json();
  const { reason, stakeTxHash } = AppealSchema.parse(body);

  // Get user
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      isBanned: true,
      appealCount: true,
      appealStaked: true,
      appealStatus: true,
      bannedAt: true,
      bannedReason: true,
      falsePositiveHistory: true,
    },
  });

  if (!user) {
    return successResponse({ success: false, error: "User not found" }, 404);
  }

  if (!user.isBanned) {
    return successResponse(
      { success: false, error: "User is not banned" },
      400,
    );
  }

  // Check if already appealed
  if (user.appealCount >= 1 && !user.appealStaked) {
    return successResponse(
      {
        success: false,
        error:
          "You have already used your free appeal. You must stake $10 for a second review.",
      },
      400,
    );
  }

  if (user.appealStaked && user.appealStatus === "human_review") {
    return successResponse(
      {
        success: false,
        error:
          "Your appeal is already in human review. Please wait for a decision.",
      },
      400,
    );
  }

  // If this is a staked appeal, verify stake or escrow payment
  if (stakeTxHash && !user.appealStaked) {
    // First check if this is an escrow payment
    const escrow = await db.moderationEscrow.findUnique({
      where: { paymentTxHash: stakeTxHash },
      include: {
        User: {
          select: {
            id: true,
            appealStaked: true,
            appealStakeTxHash: true,
          },
        },
      },
    });

    if (escrow) {
      // Validate escrow can be used for appeal
      if (escrow.recipientId !== userId) {
        return successResponse(
          {
            success: false,
            error: "Escrow payment does not belong to you",
          },
          400,
        );
      }

      if (escrow.status !== "paid") {
        return successResponse(
          {
            success: false,
            error: `Escrow payment is ${escrow.status}, must be 'paid' to use for appeal`,
          },
          400,
        );
      }

      if (escrow.refundTxHash) {
        return successResponse(
          {
            success: false,
            error:
              "Escrow payment has been refunded and cannot be used for appeal",
          },
          400,
        );
      }

      // Check if escrow was already used for an appeal by any user
      const existingAppealWithEscrow = await db.user.findFirst({
        where: {
          appealStakeTxHash: stakeTxHash,
        },
      });

      if (existingAppealWithEscrow) {
        if (existingAppealWithEscrow.id === userId) {
          return successResponse(
            {
              success: false,
              error: "You have already used this escrow payment for an appeal",
            },
            400,
          );
        }
        return successResponse(
          {
            success: false,
            error:
              "This escrow payment has already been used for an appeal by another user",
          },
          400,
        );
      }

      // Use escrow payment as stake
      await db.user.update({
        where: { id: userId },
        data: {
          appealStaked: true,
          appealStakeAmount: escrow.amountUSD.toString(),
          appealStakeTxHash: stakeTxHash,
        },
      });
    } else {
      // Verify regular stake transaction
      const verificationResult = await verifyStakeTransaction(
        stakeTxHash,
        userId,
      );
      if (!verificationResult.verified) {
        return successResponse(
          {
            success: false,
            error:
              verificationResult.error ||
              "Failed to verify stake transaction. If using escrow payment, ensure it is paid and belongs to you.",
          },
          400,
        );
      }

      await db.user.update({
        where: { id: userId },
        data: {
          appealStaked: true,
          appealStakeAmount: String(verificationResult.amount || 10),
          appealStakeTxHash: stakeTxHash,
        },
      });
    }
  }

  // Determine appeal type
  const isStakedAppeal = user.appealStaked || !!stakeTxHash;
  const appealType = isStakedAppeal ? "lenient_review" : "strict_review";

  // Update user appeal status
  await db.user.update({
    where: { id: userId },
    data: {
      appealCount: user.appealCount + 1,
      appealStatus: appealType,
      appealSubmittedAt: new Date(),
    },
  });

  // Process appeal based on type
  if (isStakedAppeal) {
    // Lenient review - only deny if VERY OBVIOUSLY a scammer
    const result = await processLenientAppeal(userId, reason, user);

    if (result.shouldDeny) {
      // Send to human review
      await db.user.update({
        where: { id: userId },
        data: {
          appealStatus: "human_review",
        },
      });

      await createNotification({
        userId,
        type: "system",
        title: "Appeal Under Human Review",
        message:
          "Your staked appeal has been reviewed and requires human confirmation. A moderator will review your case shortly.",
      });

      return successResponse({
        success: true,
        message: "Appeal submitted for human review",
        status: "human_review",
      });
    }
    // Approved - restore account
    await restoreAccount(userId, result.reasoning);

    return successResponse({
      success: true,
      message: "Appeal approved - account restored",
      status: "approved",
    });
  }
  // Strict review - check if false positive
  const result = await processStrictAppeal(userId, reason, user);

  if (result.isFalsePositive) {
    // Restore account
    await restoreAccount(userId, result.reasoning);

    return successResponse({
      success: true,
      message: "Appeal approved - false positive confirmed",
      status: "approved",
    });
  }
  // Denied - user must stake for second review
  await db.user.update({
    where: { id: userId },
    data: {
      appealStatus: "denied",
      appealReviewedAt: new Date(),
    },
  });

  await createNotification({
    userId,
    type: "system",
    title: "Appeal Denied",
    message:
      "Your appeal was denied. You can stake $10 for a second, more lenient review.",
  });

  return successResponse({
    success: false,
    message: "Appeal denied. Stake $10 for a second review.",
    status: "denied",
    requiresStake: true,
  });
});

/**
 * Process strict appeal (first appeal) - checks if false positive
 */
async function processStrictAppeal(
  userId: string,
  reason: string,
  user: { bannedReason: string | null; falsePositiveHistory: unknown },
): Promise<{ isFalsePositive: boolean; reasoning: string }> {
  // Collect context
  const context = await collectAppealContext(userId, user);

  const prompt = `You are a strict appeal judge. A user has been banned and is appealing.

BAN REASON: ${user.bannedReason || "No reason provided"}
APPEAL REASON: ${reason}

USER CONTEXT:
${JSON.stringify(context, null, 2)}

FALSE POSITIVE HISTORY:
${user.falsePositiveHistory ? JSON.stringify(user.falsePositiveHistory, null, 2) : "None"}

TASK: Determine if this ban was a FALSE POSITIVE (user was incorrectly banned).

A false positive means:
- User was NOT actually scamming or posting CSAM
- Ban was due to misunderstanding, technical error, or false report
- User's behavior was legitimate

If user WAS scamming or posting CSAM, this is NOT a false positive.

Respond with JSON:
{
  "isFalsePositive": true/false,
  "reasoning": "Detailed explanation"
}`;

  const response = await callClaudeDirect({
    prompt,
    system:
      "You are a strict appeal judge. Only approve appeals if the ban was clearly a false positive. Be conservative.",
    model: "claude-sonnet-4-5",
    temperature: 0.2,
    maxTokens: 2048,
  });

  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("No JSON found in response");
  }

  const result = JSON.parse(jsonMatch[0]) as {
    isFalsePositive: boolean;
    reasoning: string;
  };
  return result;
}

/**
 * Process lenient appeal (after staking) - only deny if VERY OBVIOUSLY scammer
 */
async function processLenientAppeal(
  userId: string,
  reason: string,
  user: { bannedReason: string | null; falsePositiveHistory: unknown },
): Promise<{ shouldDeny: boolean; reasoning: string }> {
  const context = await collectAppealContext(userId, user);

  const prompt = `You are a lenient appeal judge. A user has staked $10 for a second review.

BAN REASON: ${user.bannedReason || "No reason provided"}
APPEAL REASON: ${reason}

USER CONTEXT:
${JSON.stringify(context, null, 2)}

FALSE POSITIVE HISTORY:
${user.falsePositiveHistory ? JSON.stringify(user.falsePositiveHistory, null, 2) : "None"}

TASK: Only deny if the user is VERY OBVIOUSLY a scammer or CSAM poster.

Be VERY lenient. Only deny if:
- Clear, undeniable evidence of scamming (stealing points/money)
- Clear, undeniable evidence of CSAM
- Multiple confirmed reports with strong evidence

DO NOT deny for:
- Accidental rate limit violations
- Double messages
- Misunderstandings
- Edge cases
- Single reports without strong evidence

If there's ANY doubt, approve the appeal.

Respond with JSON:
{
  "shouldDeny": true/false,
  "reasoning": "Detailed explanation"
}`;

  const response = await callClaudeDirect({
    prompt,
    system:
      "You are a lenient appeal judge. Be VERY lenient. Only deny if user is VERY OBVIOUSLY a scammer or CSAM poster. If there is ANY doubt, approve.",
    model: "claude-sonnet-4-5",
    temperature: 0.3,
    maxTokens: 2048,
  });

  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("No JSON found in response");
  }

  const result = JSON.parse(jsonMatch[0]) as {
    shouldDeny: boolean;
    reasoning: string;
  };
  return result;
}

/**
 * Collect context for appeal evaluation
 */
async function collectAppealContext(
  userId: string,
  user: { bannedReason: string | null },
) {
  const now = new Date();
  const [reports, recentPosts, recentMessages] = await Promise.all([
    db.report.findMany({
      where: { reportedUserId: userId },
      take: 10,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        category: true,
        reason: true,
        status: true,
        resolution: true,
        createdAt: true,
      },
    }),
    db.post.findMany({
      where: {
        authorId: userId,
        deletedAt: null,
        timestamp: { lte: now }, // ✅ No future posts - prevent information leakage
      },
      take: 10,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        content: true,
        createdAt: true,
      },
    }),
    db.message.findMany({
      where: { senderId: userId },
      take: 20,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        content: true,
        createdAt: true,
      },
    }),
  ]);

  return {
    bannedReason: user.bannedReason,
    reportsCount: reports.length,
    recentReports: reports,
    recentPostsCount: recentPosts.length,
    recentMessagesCount: recentMessages.length,
  };
}

/**
 * Restore user account after successful appeal
 */
async function restoreAccount(userId: string, reasoning: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { falsePositiveHistory: true },
  });

  const falsePositiveHistory =
    (user?.falsePositiveHistory as Array<Record<string, unknown>> | null) || [];
  falsePositiveHistory.push({
    date: new Date().toISOString(),
    reason: reasoning,
    reviewedBy: "ai",
  });

  await db.user.update({
    where: { id: userId },
    data: {
      isBanned: false,
      isScammer: false,
      isCSAM: false,
      bannedAt: null,
      bannedBy: null,
      bannedReason: null,
      appealStatus: "approved",
      appealReviewedAt: new Date(),
      falsePositiveHistory: falsePositiveHistory as JsonValue,
    },
  });

  // Refund stake if staked
  const updatedUser = await db.user.findUnique({
    where: { id: userId },
    select: { appealStaked: true, appealStakeAmount: true },
  });

  if (updatedUser?.appealStaked && updatedUser.appealStakeAmount) {
    await refundAppealStake(userId, Number(updatedUser.appealStakeAmount));
  }

  await createNotification({
    userId,
    type: "system",
    title: "Appeal Approved - Account Restored",
    message: `Your appeal was approved. ${reasoning}`,
  });

  logger.info("Account restored after appeal", { userId, reasoning }, "Appeal");
}

/**
 * Verify stake transaction on-chain
 */
async function verifyStakeTransaction(
  txHash: string,
  userId: string,
): Promise<{ verified: boolean; amount?: number; error?: string }> {
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(
      process.env.NEXT_PUBLIC_RPC_URL ||
        process.env.BASE_SEPOLIA_RPC_URL ||
        "https://sepolia.base.org",
    ),
  });

  const tx = await publicClient.getTransaction({ hash: txHash as Address });
  if (!tx) {
    return { verified: false, error: "Transaction not found on blockchain" };
  }

  const receipt = await publicClient.getTransactionReceipt({
    hash: txHash as Address,
  });
  if (!receipt) {
    return { verified: false, error: "Transaction not yet confirmed" };
  }

  if (receipt.status !== "success") {
    return { verified: false, error: "Transaction failed on blockchain" };
  }

  // Get user's wallet address
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { walletAddress: true },
  });

  if (!user?.walletAddress) {
    return { verified: false, error: "User has no wallet address" };
  }

  // Verify sender matches user's wallet (with case-insensitive comparison)
  const senderMatch =
    tx.from.toLowerCase() === user.walletAddress.toLowerCase();
  if (!senderMatch) {
    return {
      verified: false,
      error: "Transaction sender does not match user wallet",
    };
  }

  // Verify amount is at least $10 USD equivalent
  // For ETH/USDC, we need to check the value or token transfer
  // Since we're dealing with USD, we'll check if value is reasonable (at least 0.01 ETH or equivalent)
  // In production, you'd want to check against a specific token contract
  const minStakeWei = BigInt("10000000000000000"); // 0.01 ETH minimum
  const txValue = tx.value || BigInt(0);

  // If it's a token transfer, we'd need to decode the transaction data
  // For now, we'll accept ETH transfers of at least 0.01 ETH
  // In production, you'd want to verify against USDC or a specific stake contract
  if (txValue < minStakeWei && tx.to) {
    // Check if it's a token transfer by examining logs
    const hasTokenTransfer = receipt.logs.length > 0;
    if (!hasTokenTransfer) {
      return {
        verified: false,
        error: "Transaction value too low or not a valid stake",
      };
    }
  }

  // Calculate USD amount (simplified - in production use oracle for accurate conversion)
  // Assuming 1 ETH = $3000, 0.01 ETH = $30, so we need at least 0.0033 ETH for $10
  const minStakeFor10USD = BigInt("3300000000000000"); // ~0.0033 ETH
  const amountUSD =
    txValue >= minStakeFor10USD ? 10 : (Number(txValue) * 3000) / 1e18;

  logger.info(
    "Stake transaction verified",
    {
      txHash,
      userId,
      amountUSD,
      txValue: txValue.toString(),
    },
    "Appeal",
  );

  return { verified: true, amount: amountUSD };
}

/**
 * Refund appeal stake to user's virtual balance
 */
async function refundAppealStake(
  userId: string,
  stakeAmount: number,
): Promise<void> {
  await WalletService.credit(
    userId,
    stakeAmount,
    "appeal_stake_refund",
    "Appeal stake refund - account restored",
    undefined,
  );

  // Clear stake flags
  await db.user.update({
    where: { id: userId },
    data: {
      appealStaked: false,
      appealStakeAmount: null,
      appealStakeTxHash: null,
    },
  });

  logger.info(
    "Appeal stake refunded",
    {
      userId,
      stakeAmount,
    },
    "Appeal",
  );
}
