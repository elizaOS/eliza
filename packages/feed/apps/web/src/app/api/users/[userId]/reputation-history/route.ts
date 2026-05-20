/**
 * User Reputation History API
 *
 * @route GET /api/users/[userId]/reputation-history - Get user's reputation history
 * @access Authenticated
 *
 * @description
 * Returns the authenticated user's non-spendable reputation/progression
 * ledger. Trading balance funding is exposed separately via
 * `/api/users/trading-balance/funding`.
 */

import {
  AuthorizationError,
  authenticate,
  ReputationService,
  requireUserByIdentifier,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import { toISO, UserIdParamSchema } from "@feed/shared";
import type { NextRequest } from "next/server";

export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> },
  ) => {
    const authUser = await authenticate(request);
    const { userId } = UserIdParamSchema.parse(await context.params);

    if (!authUser.dbUserId) {
      throw new AuthorizationError(
        "User profile not found. Please complete onboarding first.",
        "reputation-history",
        "read",
      );
    }

    const targetUser = await requireUserByIdentifier(userId, { id: true });
    const canonicalUserId = targetUser.id;

    if (authUser.dbUserId !== canonicalUserId) {
      throw new AuthorizationError(
        "You can only view your own reputation history",
        "reputation-history",
        "read",
      );
    }

    const transactions =
      await ReputationService.getReputationHistory(canonicalUserId);

    return successResponse({
      transactions: transactions.map((transaction) => ({
        ...transaction,
        createdAt: toISO(transaction.createdAt),
      })),
    });
  },
);
