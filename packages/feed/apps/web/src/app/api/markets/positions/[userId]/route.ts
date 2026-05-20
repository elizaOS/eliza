/**
 * User Positions API
 *
 * @route GET /api/markets/positions/[userId] - Get user positions
 * @access Public (RLS applies)
 */

import { optionalAuth, successResponse, withErrorHandling } from '@feed/api';
import { UserIdParamSchema, UserPositionsQuerySchema } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { getUserPositionsSnapshot } from '@/lib/markets/user-positions';

export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> }
  ) => {
    const { userId } = UserIdParamSchema.parse(await context.params);
    const { searchParams } = new URL(request.url);
    const parsed = UserPositionsQuerySchema.parse({
      userId,
      type: searchParams.get('type') || 'all',
      status: searchParams.get('status') || 'open',
      page: searchParams.get('page') || undefined,
      limit: searchParams.get('limit') || undefined,
    });

    const authUser = await optionalAuth(request).catch(() => null);

    return successResponse(
      await getUserPositionsSnapshot({
        userId,
        type: parsed.type,
        status: parsed.status,
        page: parsed.page,
        limit: parsed.limit,
        viewerUserId: authUser?.userId,
      })
    );
  }
);
