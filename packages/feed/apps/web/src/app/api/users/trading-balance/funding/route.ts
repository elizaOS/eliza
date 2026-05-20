/**
 * Trading Balance Funding API
 *
 * @route POST /api/users/trading-balance/funding - Credit trading balance
 * @route GET /api/users/trading-balance/funding - Get funding history
 * @access POST: Admin, GET: Authenticated user
 *
 * @description
 * Handles explicit funding operations for the spendable trading balance.
 * This endpoint is intentionally separate from reputation points.
 */

import {
  authenticate,
  BusinessLogicError,
  requireAdmin,
  requireUserByIdentifier,
  successResponse,
  TradingBalanceFundingService,
  withErrorHandling,
} from "@feed/api";
import {
  FundTradingBalanceSchema,
  logger,
  toISO,
  UserIdParamSchema,
} from "@feed/shared";
import type { NextRequest } from "next/server";

export const POST = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  const body = await request.json();
  const { userId, amount, reason, description } =
    FundTradingBalanceSchema.parse(body);

  const user = await requireUserByIdentifier(userId);
  const result = await TradingBalanceFundingService.creditAdminFunding(
    user.id,
    amount,
    reason,
    description,
  );

  if (!result.success) {
    throw new BusinessLogicError(
      result.error ?? "Failed to fund trading balance",
      "TRADING_BALANCE_FUNDING_FAILED",
    );
  }

  logger.info(
    "Trading balance funded via admin route",
    { userId: user.id, amount, reason, transactionId: result.transactionId },
    "POST /api/users/trading-balance/funding",
  );

  return successResponse({
    message: `Successfully funded ${amount} balance units`,
    balanceDelta: result.balanceDelta,
    newBalance: result.newBalance,
    transaction: {
      id: result.transactionId,
      amount: String(result.balanceDelta),
      reason: description || reason,
    },
    user: {
      id: user.id,
      virtualBalance: String(result.newBalance),
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

  const { userId } = UserIdParamSchema.parse({ userId: userIdParam });
  const targetUser = await requireUserByIdentifier(userId);
  const canonicalUserId = targetUser.id;

  if (authUser.dbUserId !== canonicalUserId) {
    throw new BusinessLogicError(
      "You can only view your own trading balance funding history",
      "UNAUTHORIZED_ACCESS",
    );
  }

  const transactions =
    await TradingBalanceFundingService.getFundingHistory(canonicalUserId);

  logger.info(
    "Trading balance funding history fetched",
    { userId: canonicalUserId, transactionCount: transactions.length },
    "GET /api/users/trading-balance/funding",
  );

  return successResponse({
    transactions: transactions.map((transaction) => ({
      id: transaction.id,
      type: transaction.type,
      amount: transaction.amount.toString(),
      description: transaction.description,
      createdAt: toISO(transaction.createdAt),
      balanceBefore: transaction.balanceBefore.toString(),
      balanceAfter: transaction.balanceAfter.toString(),
      relatedId: transaction.relatedId,
    })),
  });
});
