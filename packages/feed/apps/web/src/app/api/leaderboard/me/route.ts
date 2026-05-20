import {
  authenticate,
  type LeaderboardPosition,
  ReputationService,
  successResponse,
  TradingLeaderboardService,
  withErrorHandling,
} from "@feed/api";
import type { LeaderboardMetric, LeaderboardScope } from "@feed/shared";
import type { NextRequest } from "next/server";
import { sanitizeForJson } from "@/lib/json/sanitize";
import { parseLeaderboardQuery } from "../query";

/**
 * Authenticated leaderboard position endpoint.
 *
 * Mirrors `/api/leaderboard` query axes:
 * - `metric=reputation|trading`
 * - `type=wallet|team`
 *
 * Defaults remain `metric=reputation` and `type=wallet`.
 */
type LeaderboardService = {
  getUserPosition: (
    userId: string,
    leaderboardType: LeaderboardScope,
    pageSize?: number,
  ) => Promise<LeaderboardPosition | null>;
};

const LEADERBOARD_SERVICES: Record<LeaderboardMetric, LeaderboardService> = {
  reputation: ReputationService,
  trading: TradingLeaderboardService,
};

export const GET = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);
  const { searchParams } = new URL(request.url);
  const { pageSize, metric, type } = parseLeaderboardQuery(searchParams);
  const leaderboardMetric = metric ?? "reputation";
  const leaderboardType = type ?? "wallet";
  const leaderboardService = LEADERBOARD_SERVICES[leaderboardMetric];

  const currentUser = await leaderboardService.getUserPosition(
    authUser.userId,
    leaderboardType,
    pageSize,
  );

  return successResponse(
    sanitizeForJson({
      success: true,
      leaderboardType,
      leaderboardMetric,
      currentUser,
    }),
  );
});
