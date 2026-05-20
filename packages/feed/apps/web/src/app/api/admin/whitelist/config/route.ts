/**
 * Admin Whitelist Config API
 *
 * @route GET /api/admin/whitelist/config - Get current whitelist configuration
 * @route PUT /api/admin/whitelist/config - Update whitelist configuration
 * @access Admin
 */

import { requireAdmin, successResponse, withErrorHandling } from '@feed/api';
import {
  getWhitelistConfig,
  updateWhitelistConfig,
} from '@feed/api/services/whitelist-service';
import { type NextRequest, NextResponse } from 'next/server';

export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  const config = await getWhitelistConfig();

  return successResponse({
    config: config
      ? {
          ...config,
          leaderboardRankThreshold: config.leaderboardRankThreshold ?? 100,
        }
      : {
          leaderboardRankThreshold: 100,
          leaderboardCategory: 'all',
          updatedAt: null,
          updatedBy: null,
        },
  });
});

export const PUT = withErrorHandling(async (request: NextRequest) => {
  const admin = await requireAdmin(request);

  const body = await request.json();
  const { leaderboardRankThreshold, leaderboardCategory } = body as {
    leaderboardRankThreshold: number | null;
    leaderboardCategory?: string;
  };

  if (
    typeof leaderboardRankThreshold !== 'number' ||
    leaderboardRankThreshold < 1 ||
    !Number.isInteger(leaderboardRankThreshold)
  ) {
    return NextResponse.json(
      {
        error: 'leaderboardRankThreshold must be a positive integer',
      },
      { status: 400 }
    );
  }

  const VALID_CATEGORIES = ['all', 'trading', 'social', 'reputation'] as const;
  if (
    leaderboardCategory !== undefined &&
    !VALID_CATEGORIES.includes(
      leaderboardCategory as (typeof VALID_CATEGORIES)[number]
    )
  ) {
    return NextResponse.json(
      {
        error: `leaderboardCategory must be one of: ${VALID_CATEGORIES.join(', ')}`,
      },
      { status: 400 }
    );
  }

  await updateWhitelistConfig({
    leaderboardRankThreshold,
    leaderboardCategory,
    updatedBy: admin.dbUserId ?? undefined,
  });

  const config = await getWhitelistConfig();

  return successResponse({ success: true, config });
});
