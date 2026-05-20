import { broadcastToChannel, createNotification } from '@babylon/api';
import {
  and,
  db,
  eq,
  gt,
  isNotNull,
  type JsonValue,
  markets,
  positions,
  users,
} from '@babylon/db';
import { logger, type MarketResolvedNotificationData } from '@babylon/shared';

interface ResolvedOutcomeRow {
  holderId: string;
  ownerUserId: string;
  marketId: string;
  marketName: string;
  points: number;
  agentName: string | null;
}

export interface GroupedResolvedOutcome {
  holderId: string;
  ownerUserId: string;
  marketId: string;
  marketName: string;
  points: number;
  outcome: 'win' | 'loss';
  agentName?: string;
  deepLink: string;
  dedupeKey: string;
}

function formatPoints(points: number): string {
  return Math.abs(points).toLocaleString('en-US', {
    maximumFractionDigits: 2,
  });
}

export function groupResolvedMarketOutcomes(
  rows: ResolvedOutcomeRow[]
): GroupedResolvedOutcome[] {
  // outcome is intentionally omitted during accumulation — points change as
  // rows are merged, so outcome is derived once at the end from final points.
  const grouped = new Map<string, Omit<GroupedResolvedOutcome, 'outcome'>>();

  for (const row of rows) {
    const key = `${row.ownerUserId}:${row.holderId}:${row.marketId}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.points = Number((existing.points + row.points).toFixed(2));
      continue;
    }

    grouped.set(key, {
      holderId: row.holderId,
      ownerUserId: row.ownerUserId,
      marketId: row.marketId,
      marketName: row.marketName,
      points: Number(row.points.toFixed(2)),
      agentName: row.agentName ?? undefined,
      deepLink: `/markets/predictions/${row.marketId}`,
      dedupeKey: `market_resolved:${row.marketId}:${row.holderId}`,
    });
  }

  return Array.from(grouped.values()).map((entry) => ({
    ...entry,
    outcome: entry.points >= 0 ? 'win' : 'loss',
  }));
}

function buildMessage(entry: GroupedResolvedOutcome): string {
  const points = formatPoints(entry.points);
  if (entry.agentName) {
    return entry.outcome === 'win'
      ? `${entry.agentName} won ${points} points on ${entry.marketName}.`
      : `${entry.agentName} lost ${points} points on ${entry.marketName}.`;
  }

  return entry.outcome === 'win'
    ? `${entry.marketName} resolved for a ${points}-point win.`
    : `${entry.marketName} resolved for a ${points}-point loss.`;
}

export async function notifyResolvedMarketOwners(
  marketId: string
): Promise<number> {
  const rows = await db
    .select({
      holderId: positions.userId,
      managedBy: users.managedBy,
      isAgent: users.isAgent,
      agentName: users.displayName,
      marketId: positions.marketId,
      marketName: markets.question,
      pnl: positions.pnl,
    })
    .from(positions)
    .innerJoin(markets, eq(markets.id, positions.marketId))
    .leftJoin(users, eq(users.id, positions.userId))
    .where(
      and(
        eq(positions.marketId, marketId),
        eq(positions.status, 'resolved'),
        isNotNull(positions.outcome),
        isNotNull(positions.pnl),
        isNotNull(positions.resolvedAt),
        gt(positions.shares, '0')
      )
    );

  const groupedOutcomes = groupResolvedMarketOutcomes(
    rows.map((row) => ({
      holderId: row.holderId,
      ownerUserId: row.isAgent && row.managedBy ? row.managedBy : row.holderId,
      marketId: row.marketId,
      marketName: row.marketName,
      points: Number(row.pnl),
      agentName: row.isAgent ? row.agentName : null,
    }))
  );

  let createdCount = 0;

  for (const entry of groupedOutcomes) {
    const data: MarketResolvedNotificationData = {
      marketId: entry.marketId,
      marketName: entry.marketName,
      outcome: entry.outcome,
      points: entry.points,
      ...(entry.agentName ? { agentName: entry.agentName } : {}),
      deepLink: entry.deepLink,
    };

    const result = await createNotification({
      userId: entry.ownerUserId,
      type: 'market_resolved',
      title: 'Market resolved',
      message: buildMessage(entry),
      data,
      dedupeKey: entry.dedupeKey,
      sendEmail: false,
    });

    if (!result.created) {
      continue;
    }

    createdCount += 1;

    try {
      await broadcastToChannel(`notifications:${entry.ownerUserId}`, {
        type: 'market_resolved',
        ...data,
      } as Record<string, JsonValue>);
    } catch (error) {
      logger.error(
        'Realtime market resolution notification failed (non-fatal)',
        {
          marketId: entry.marketId,
          ownerUserId: entry.ownerUserId,
          error: error instanceof Error ? error.message : String(error),
        },
        'MarketResolutionNotifications'
      );
    }
  }

  return createdCount;
}
