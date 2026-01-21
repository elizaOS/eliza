/**
 * Points Award API
 *
 * @route POST /api/users/points/award - Award points to user
 * @access Internal/System
 *
 * @description
 * Awards points to users for achievements and milestones. Creates balance
 * transaction records for transparency. Used internally by points service.
 *
 * @openapi
 * /api/users/points/award:
 *   post:
 *     tags:
 *       - Users
 *     summary: Award points to user
 *     description: Awards points to a user and creates transaction record (internal use)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *               - points
 *               - reason
 *             properties:
 *               userId:
 *                 type: string
 *               points:
 *                 type: number
 *               reason:
 *                 type: string
 *                 enum: [profile_completion, farcaster_link, twitter_link, wallet_connect, referral_bonus, report_reward, moderation_reward]
 *               description:
 *                 type: string
 *                 description: Custom description for transaction
 *     responses:
 *       200:
 *         description: Points awarded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 transaction:
 *                   type: object
 *                 newBalance:
 *                   type: number
 *       400:
 *         description: Invalid input or user not found
 *
 * @example
 * ```typescript
 * await fetch('/api/users/points/award', {
 *   method: 'POST',
 *   body: JSON.stringify({
 *     userId: 'user-id',
 *     points: 100,
 *     reason: 'profile_completion'
 *   })
 * });
 * ```
 *
 * @see {@link /lib/services/points-service} Points service
 */

import {
  authenticate,
  BusinessLogicError,
  requireAdmin,
  requireUserByIdentifier,
  successResponse,
  withErrorHandling,
} from "@polyagent/api";
import {
  balanceTransactions,
  Decimal,
  db,
  desc,
  eq,
  sql,
  users,
} from "@polyagent/db";
import {
  AwardPointsSchema,
  generateSnowflakeId,
  logger,
  UserIdParamSchema,
} from "@polyagent/shared";
import type { NextRequest } from "next/server";

export const POST = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  // Parse and validate request body
  const body = await request.json();
  const {
    userId,
    points: amount,
    reason,
    description,
  } = AwardPointsSchema.parse(body);

  // Verify user exists and get current balance
  const user = await requireUserByIdentifier(userId);

  // Calculate balance changes
  const balanceBefore = new Decimal(user.virtualBalance?.toString() || "0");
  const amountDecimal = new Decimal(amount);
  const balanceAfter = Decimal.add(balanceBefore, amountDecimal);

  // Award points by creating a deposit transaction
  const transactionId = await generateSnowflakeId();
  const [transaction] = await db
    .insert(balanceTransactions)
    .values({
      id: transactionId,
      userId: user.id,
      type: "deposit",
      amount: amountDecimal.toString(),
      balanceBefore: balanceBefore.toString(),
      balanceAfter: balanceAfter.toString(),
      description: description || reason, // Use custom description if provided, otherwise use reason enum
    })
    .returning();

  // Update user's virtual balance
  const [updatedUser] = await db
    .update(users)
    .set({
      virtualBalance: sql`${users.virtualBalance} + ${amount}`,
      totalDeposited: sql`${users.totalDeposited} + ${amount}`,
    })
    .where(eq(users.id, user.id))
    .returning({
      id: users.id,
      virtualBalance: users.virtualBalance,
      totalDeposited: users.totalDeposited,
    });

  logger.info(
    `Successfully awarded ${amount} points`,
    { userId: user.id, amount, reason },
    "POST /api/users/points/award",
  );

  if (!transaction) {
    throw new BusinessLogicError(
      "Failed to create transaction",
      "TRANSACTION_FAILED",
    );
  }
  if (!updatedUser) {
    throw new BusinessLogicError("Failed to update user", "UPDATE_FAILED");
  }

  return successResponse({
    message: `Successfully awarded ${amount} points`,
    transaction: {
      id: transaction.id,
      amount: transaction.amount?.toString() || "0",
      reason: transaction.description,
      timestamp: transaction.createdAt,
      balanceBefore: transaction.balanceBefore?.toString() || "0",
      balanceAfter: transaction.balanceAfter?.toString() || "0",
    },
    user: {
      id: updatedUser.id,
      virtualBalance: updatedUser.virtualBalance?.toString() || "0",
      totalDeposited: updatedUser.totalDeposited?.toString() || "0",
    },
  });
});

export const GET = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);

  const { searchParams } = new URL(request.url);
  const userIdParam = searchParams.get("userId");

  if (!userIdParam) {
    throw new BusinessLogicError("User ID is required", "USER_ID_REQUIRED");
  }

  // Validate userId format
  const { userId } = UserIdParamSchema.parse({ userId: userIdParam });
  const targetUser = await requireUserByIdentifier(userId);
  const canonicalUserId = targetUser.id;

  if (authUser.userId !== canonicalUserId) {
    throw new BusinessLogicError(
      "You can only view your own points history",
      "UNAUTHORIZED_ACCESS",
    );
  }

  // Fetch deposit transactions (points awards)
  const transactions = await db
    .select({
      id: balanceTransactions.id,
      amount: balanceTransactions.amount,
      description: balanceTransactions.description,
      createdAt: balanceTransactions.createdAt,
      balanceBefore: balanceTransactions.balanceBefore,
      balanceAfter: balanceTransactions.balanceAfter,
    })
    .from(balanceTransactions)
    .where(eq(balanceTransactions.userId, canonicalUserId))
    .orderBy(desc(balanceTransactions.createdAt));

  logger.info(
    "Points award history fetched",
    { userId: canonicalUserId, transactionCount: transactions.length },
    "GET /api/users/points/award",
  );

  return successResponse({
    transactions: transactions.map((tx) => ({
      id: tx.id,
      amount: tx.amount.toString(),
      reason: tx.description,
      timestamp: tx.createdAt,
      balanceBefore: tx.balanceBefore.toString(),
      balanceAfter: tx.balanceAfter.toString(),
    })),
  });
});
