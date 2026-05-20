/**
 * Legacy User Points History API
 *
 * @route GET /api/users/[userId]/points-history - Legacy reputation history
 * @access Authenticated
 *
 * @description
 * Deprecated compatibility route that now returns only the reputation ledger.
 * Trading balance funding has moved to `/api/users/trading-balance/funding`,
 * and the canonical reputation route is
 * `/api/users/[userId]/reputation-history`.
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
        "points-history",
        "read",
      );
    }

    const targetUser = await requireUserByIdentifier(userId, { id: true });
    const canonicalUserId = targetUser.id;

    if (authUser.dbUserId !== canonicalUserId) {
      throw new AuthorizationError(
        "You can only view your own points history",
        "points-history",
        "read",
      );
    }

    const transactions =
      await ReputationService.getReputationHistory(canonicalUserId);

    return successResponse(
      {
        transactions: transactions.map((transaction) => ({
          id: transaction.id,
          userId: transaction.userId,
          amount: transaction.reputationDelta,
          pointsBefore: transaction.reputationBefore,
          pointsAfter: transaction.reputationAfter,
          reason: transaction.reason,
          metadata: transaction.metadata,
          createdAt: toISO(transaction.createdAt),
        })),
      },
      200,
      {
        "x-feed-deprecated": "true",
        link: '</api/users/[userId]/reputation-history>; rel="successor-version"',
      },
    );
  },
);
