import 'server-only';

import {
  and,
  asc,
  db,
  eq,
  gte,
  inArray,
  isNull,
  markets,
  or,
  perpPositions,
  positions,
  userPnLSnapshots,
  users,
} from '@babylon/db';
import { FEE_CONFIG } from '@babylon/engine/config/fees';
import { toNumber } from '@babylon/engine/portfolio-valuation';
import { sql } from 'drizzle-orm';
import type {
  PnlHistoryPoint,
  PnlHistoryRange,
  UserPnlMetrics,
} from './pnl-history-types';
import { calculatePredictionPositionSnapshot } from './predictionPositionSnapshot';

export type {
  PnlHistoryPoint,
  PnlHistoryRange,
  PnlHistoryScope,
  UserPnlMetrics,
} from './pnl-history-types';

interface SnapshotMetricRow {
  currentPnL: number;
  snapshotAt: Date | string;
  userId: string;
}

interface PnlMetricUserRow {
  id: string;
  lifetimePnL: unknown;
  privyId: string | null;
}

const TIMEFRAME_DURATIONS: Record<Exclude<PnlHistoryRange, 'ALL'>, number> = {
  '1H': 60 * 60 * 1000,
  '4H': 4 * 60 * 60 * 1000,
  '1D': 24 * 60 * 60 * 1000,
  '1W': 7 * 24 * 60 * 60 * 1000,
};

const PNL_SNAPSHOT_INSERT_BATCH_SIZE = 250;
const PNL_METRIC_QUERY_BATCH_SIZE = 500;

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
}

/**
 * Resolve the lower time boundary for a requested history range.
 */
export function getPnlHistoryCutoff(
  range: PnlHistoryRange,
  now = new Date()
): Date | undefined {
  const durationMs =
    TIMEFRAME_DURATIONS[range as Exclude<PnlHistoryRange, 'ALL'>];
  return durationMs ? new Date(now.getTime() - durationMs) : undefined;
}

/**
 * Normalize a timestamp to the top of its UTC hour.
 */
export function getHourBoundary(date = new Date()): Date {
  const boundary = new Date(date);
  boundary.setUTCMinutes(0, 0, 0);
  return boundary;
}

/**
 * Build the canonical-to-alias identity map used for legacy owner rows where
 * open positions may still be stored under `users.privyId`.
 */
export function buildPnlMetricIdentityMap(userRows: PnlMetricUserRow[]): {
  aliasToCanonicalUserId: Map<string, string>;
  positionUserIds: string[];
} {
  const aliasToCanonicalUserId = new Map<string, string>();
  const positionUserIds: string[] = [];

  for (const row of userRows) {
    aliasToCanonicalUserId.set(row.id, row.id);
    positionUserIds.push(row.id);

    if (row.privyId && row.privyId !== row.id) {
      aliasToCanonicalUserId.set(row.privyId, row.id);
      positionUserIds.push(row.privyId);
    }
  }

  return {
    aliasToCanonicalUserId,
    positionUserIds: Array.from(new Set(positionUserIds)),
  };
}

/**
 * Aggregate raw per-user snapshot rows into a single scoped chart series and
 * append an optional live point for the current in-memory value.
 */
export function buildScopedPnlHistoryPoints(params: {
  liveMetricsByUserId?: ReadonlyMap<string, UserPnlMetrics>;
  maxPoints?: number;
  now?: Date;
  scopeUserIds: string[];
  snapshots: SnapshotMetricRow[];
}): PnlHistoryPoint[] {
  const {
    liveMetricsByUserId,
    maxPoints = 100,
    now = new Date(),
    scopeUserIds,
    snapshots,
  } = params;

  if (scopeUserIds.length === 0) {
    return [];
  }

  const scopeIdSet = new Set(scopeUserIds);
  const byTimestamp = new Map<string, { time: number; value: number }>();

  for (const snapshot of snapshots) {
    if (!scopeIdSet.has(snapshot.userId)) continue;

    const time =
      typeof snapshot.snapshotAt === 'string'
        ? Date.parse(snapshot.snapshotAt)
        : Number(snapshot.snapshotAt.valueOf());
    if (!Number.isFinite(time)) continue;
    const key = String(time);
    const existing = byTimestamp.get(key);
    byTimestamp.set(key, {
      time,
      value: (existing?.value ?? 0) + snapshot.currentPnL,
    });
  }

  const points = Array.from(byTimestamp.values())
    .sort((left, right) => left.time - right.time)
    .map(({ time, value }) => ({ time, value }));

  if (liveMetricsByUserId && liveMetricsByUserId.size > 0) {
    const liveValue = scopeUserIds.reduce((sum, userId) => {
      return sum + (liveMetricsByUserId.get(userId)?.currentPnL ?? 0);
    }, 0);

    const liveTime = now.getTime();
    const lastPoint = points.at(-1);

    if (!lastPoint || lastPoint.time < liveTime) {
      points.push({ time: liveTime, value: liveValue });
    }
  }

  if (points.length <= maxPoints) {
    return points;
  }

  const step = points.length / maxPoints;
  const downsampled: PnlHistoryPoint[] = [];

  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.min(Math.floor(i * step), points.length - 1);
    const point = points[idx];
    if (!point) continue;
    downsampled.push(point);
  }

  const lastPoint = points[points.length - 1];
  const lastDownsampled = downsampled[downsampled.length - 1];

  if (lastPoint && lastDownsampled?.time !== lastPoint.time) {
    downsampled.push(lastPoint);
  }

  return downsampled;
}

/**
 * Compute canonical current P&L metrics for the requested users.
 */
export async function loadCurrentUserPnlMetrics(
  targetUserIds?: string[],
  options: {
    onPredictionPricingError?: 'fallback' | 'throw';
  } = {}
): Promise<Map<string, UserPnlMetrics>> {
  const userFilter =
    targetUserIds && targetUserIds.length > 0
      ? and(
          eq(users.isActor, false),
          or(
            inArray(users.id, targetUserIds),
            inArray(users.privyId, targetUserIds)
          )
        )
      : eq(users.isActor, false);

  const userRows = await db
    .select({
      id: users.id,
      lifetimePnL: users.lifetimePnL,
      privyId: users.privyId,
    })
    .from(users)
    .where(userFilter);

  if (userRows.length === 0) {
    return new Map();
  }

  const { aliasToCanonicalUserId, positionUserIds } =
    buildPnlMetricIdentityMap(userRows);
  const metricsByUserId = new Map<string, UserPnlMetrics>();

  for (const row of userRows) {
    const lifetimePnL = toNumber(row.lifetimePnL);
    metricsByUserId.set(row.id, {
      userId: row.id,
      lifetimePnL,
      unrealizedPnL: 0,
      currentPnL: lifetimePnL,
    });
  }

  for (const userIdBatch of chunkArray(
    positionUserIds,
    PNL_METRIC_QUERY_BATCH_SIZE
  )) {
    const perpUnrealizedRows = await db
      .select({
        userId: perpPositions.userId,
        unrealizedPnL: sql<number>`COALESCE(SUM(${perpPositions.unrealizedPnL}), 0)`,
      })
      .from(perpPositions)
      .where(
        and(
          inArray(perpPositions.userId, userIdBatch),
          isNull(perpPositions.closedAt)
        )
      )
      .groupBy(perpPositions.userId);

    for (const row of perpUnrealizedRows) {
      const canonicalUserId = aliasToCanonicalUserId.get(row.userId);
      if (!canonicalUserId) continue;

      const metrics = metricsByUserId.get(canonicalUserId);
      if (!metrics) continue;

      const unrealizedPnL = toNumber(row.unrealizedPnL);
      metrics.unrealizedPnL += unrealizedPnL;
      metrics.currentPnL = metrics.lifetimePnL + metrics.unrealizedPnL;
    }

    const predictionRows = await db
      .select({
        userId: positions.userId,
        shares: positions.shares,
        avgPrice: positions.avgPrice,
        side: positions.side,
        yesShares: markets.yesShares,
        noShares: markets.noShares,
      })
      .from(positions)
      .innerJoin(markets, eq(positions.marketId, markets.id))
      .where(
        and(
          inArray(positions.userId, userIdBatch),
          eq(positions.status, 'active'),
          eq(markets.resolved, false)
        )
      );

    for (const row of predictionRows) {
      const canonicalUserId = aliasToCanonicalUserId.get(row.userId);
      if (!canonicalUserId) continue;

      const metrics = metricsByUserId.get(canonicalUserId);
      if (!metrics) continue;

      const snapshot = calculatePredictionPositionSnapshot({
        shares: toNumber(row.shares),
        avgPrice: toNumber(row.avgPrice),
        sideKey: row.side ? 'yes' : 'no',
        yesShares: toNumber(row.yesShares),
        noShares: toNumber(row.noShares),
        feeRate: FEE_CONFIG.TRADING_FEE_RATE,
        logContext: 'wallet/pnlHistory',
        onSellPreviewError: options.onPredictionPricingError ?? 'fallback',
      });

      metrics.unrealizedPnL += snapshot.unrealizedPnL;
      metrics.currentPnL = metrics.lifetimePnL + metrics.unrealizedPnL;
    }
  }

  return metricsByUserId;
}

/**
 * Load historical scoped P&L points from persisted snapshots and append the
 * latest live scoped value.
 */
export async function loadScopedPnlHistoryPoints(params: {
  cutoff?: Date;
  now?: Date;
  scopeUserIds: string[];
}): Promise<PnlHistoryPoint[]> {
  const { cutoff, now = new Date(), scopeUserIds } = params;

  if (scopeUserIds.length === 0) {
    return [];
  }

  const snapshotRows = await db
    .select({
      userId: userPnLSnapshots.userId,
      snapshotAt: userPnLSnapshots.snapshotAt,
      currentPnL: userPnLSnapshots.currentPnL,
    })
    .from(userPnLSnapshots)
    .where(
      cutoff
        ? and(
            inArray(userPnLSnapshots.userId, scopeUserIds),
            gte(userPnLSnapshots.snapshotAt, cutoff)
          )
        : inArray(userPnLSnapshots.userId, scopeUserIds)
    )
    .orderBy(asc(userPnLSnapshots.snapshotAt));

  const liveMetricsByUserId = await loadCurrentUserPnlMetrics(scopeUserIds, {
    onPredictionPricingError: 'fallback',
  });

  return buildScopedPnlHistoryPoints({
    liveMetricsByUserId,
    now,
    scopeUserIds,
    snapshots: snapshotRows,
  });
}

async function loadSnapshotCandidateUserIds(): Promise<string[]> {
  const [lifetimeRows, perpRows, predictionRows] = await Promise.all([
    db
      .select({ userId: users.id })
      .from(users)
      .where(and(eq(users.isActor, false), sql`${users.lifetimePnL} <> 0`)),
    db
      .selectDistinct({ userId: perpPositions.userId })
      .from(perpPositions)
      .where(isNull(perpPositions.closedAt)),
    db
      .selectDistinct({ userId: positions.userId })
      .from(positions)
      .innerJoin(markets, eq(positions.marketId, markets.id))
      .where(and(eq(positions.status, 'active'), eq(markets.resolved, false))),
  ]);

  return Array.from(
    new Set([
      ...lifetimeRows.map((row) => row.userId),
      ...perpRows.map((row) => row.userId),
      ...predictionRows.map((row) => row.userId),
    ])
  );
}

/**
 * Persist one hourly canonical P&L snapshot row per user with active or
 * historical P&L relevance. Snapshotting every non-actor user does not scale
 * in production and provides no extra chart value for dormant zero-P&L users.
 */
export async function snapshotAllUserPnlMetrics(
  snapshotAt: Date
): Promise<number> {
  const normalizedSnapshotAt = getHourBoundary(snapshotAt);
  const targetUserIds = await loadSnapshotCandidateUserIds();

  if (targetUserIds.length === 0) {
    return 0;
  }

  const metricsByUserId = await loadCurrentUserPnlMetrics(targetUserIds, {
    onPredictionPricingError: 'throw',
  });
  const snapshotRows = Array.from(metricsByUserId.values()).map((metrics) => ({
    id: `${metrics.userId}:${normalizedSnapshotAt.toISOString()}:pnl`,
    userId: metrics.userId,
    snapshotAt: normalizedSnapshotAt,
    lifetimePnL: metrics.lifetimePnL,
    unrealizedPnL: metrics.unrealizedPnL,
    currentPnL: metrics.currentPnL,
  }));

  if (snapshotRows.length === 0) {
    return 0;
  }

  let insertedCount = 0;

  for (
    let i = 0;
    i < snapshotRows.length;
    i += PNL_SNAPSHOT_INSERT_BATCH_SIZE
  ) {
    const batch = snapshotRows.slice(i, i + PNL_SNAPSHOT_INSERT_BATCH_SIZE);
    const inserted = await db
      .insert(userPnLSnapshots)
      .values(batch)
      .onConflictDoNothing({
        target: [userPnLSnapshots.userId, userPnLSnapshots.snapshotAt],
      })
      .returning({ id: userPnLSnapshots.id });

    insertedCount += inserted.length;
  }

  return insertedCount;
}
