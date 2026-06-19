/**
 * Daily Login Rewards API
 *
 * GET  - Returns current streak info
 * POST - Claims daily reward (idempotent)
 */

import {
  authenticateWithDbUser,
  checkProgress,
  DailyLoginService,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import { toISOOrNull } from "@feed/shared";

import type { NextRequest } from "next/server";

export const GET = withErrorHandling(async (request: NextRequest) => {
  const { dbUserId } = await authenticateWithDbUser(request);
  const info = await DailyLoginService.getStreakInfo(dbUserId);
  return successResponse({
    ...info,
    lastClaim: toISOOrNull(info.lastClaim),
  });
});

export const POST = withErrorHandling(async (request: NextRequest) => {
  const { dbUserId } = await authenticateWithDbUser(request);
  const result = await DailyLoginService.claimDailyReward(dbUserId);
  void checkProgress(dbUserId, { type: "daily_login", streak: result.streak });
  return successResponse(result);
});
