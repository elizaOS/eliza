import {
  checkRateLimitAsync,
  findUserByIdentifier,
  getClientIp,
  RATE_LIMIT_CONFIGS,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { and, db, eq, users } from '@feed/db';
import { logger, UserIdParamSchema } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  getPnlHistoryCutoff,
  loadScopedPnlHistoryPoints,
  type PnlHistoryRange,
  type PnlHistoryScope,
} from '@/lib/wallet/pnlHistory';

function parseRange(value: string | null): PnlHistoryRange {
  switch (value) {
    case '1H':
    case '4H':
    case '1D':
    case '1W':
    case 'ALL':
      return value;
    default:
      return '1D';
  }
}

function parseScope(value: string | null): PnlHistoryScope {
  switch (value) {
    case 'owner':
    case 'agent':
      return value;
    default:
      return 'team';
  }
}

async function resolveScopeUserIds(params: {
  entityId: string | null;
  ownerUserId: string;
  scope: PnlHistoryScope;
}): Promise<string[]> {
  const { entityId, ownerUserId, scope } = params;

  if (scope === 'owner') {
    return [ownerUserId];
  }

  const agentRows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.managedBy, ownerUserId), eq(users.isAgent, true)));

  if (scope === 'team') {
    return [ownerUserId, ...agentRows.map((row) => row.id)];
  }

  if (!entityId) {
    return [];
  }

  // Return an empty series for unknown/unowned agents to avoid exposing
  // ownership information through this public endpoint.
  return agentRows.some((row) => row.id === entityId) ? [entityId] : [];
}

export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> }
  ) => {
    const clientIp = getClientIp(request.headers);
    const rateLimitConfig = clientIp
      ? RATE_LIMIT_CONFIGS.PUBLIC_BALANCE_FETCH
      : RATE_LIMIT_CONFIGS.PUBLIC_BALANCE_FETCH_ANONYMOUS;

    const rateLimitKey = clientIp ? `ip:${clientIp}` : 'ip:anonymous';
    const rateLimit = await checkRateLimitAsync(rateLimitKey, rateLimitConfig);

    if (!rateLimit.allowed) {
      const retryAfterSeconds = rateLimit.retryAfter || 60;
      return NextResponse.json(
        { error: 'Too many requests', retryAfter: retryAfterSeconds },
        { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } }
      );
    }

    const { userId } = UserIdParamSchema.parse(await context.params);
    const { searchParams } = new URL(request.url);
    const range = parseRange(searchParams.get('range'));
    const scope = parseScope(searchParams.get('scope'));
    const entityId = searchParams.get('entityId');

    const dbUser = await findUserByIdentifier(userId, { id: true });
    if (!dbUser) {
      return successResponse({ points: [] });
    }

    const scopeUserIds = await resolveScopeUserIds({
      entityId,
      ownerUserId: dbUser.id,
      scope,
    });

    if (scopeUserIds.length === 0) {
      return successResponse({ points: [] });
    }

    const now = new Date();
    const points = await loadScopedPnlHistoryPoints({
      cutoff: getPnlHistoryCutoff(range, now),
      now,
      scopeUserIds,
    });

    logger.info(
      'Wallet current P&L history fetched',
      {
        userId: dbUser.id,
        range,
        scope,
        entityId,
        pointCount: points.length,
      },
      'GET /api/users/[userId]/pnl-history'
    );

    return successResponse({
      metric: 'currentPnL',
      points,
      scope,
    });
  }
);
