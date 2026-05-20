/**
 * Server-side portfolio breakdown (wallet + agents + positions) for consistent P/L.
 */

import { isOpenPerpPositionStateValid } from '@feed/core/markets/perps';
import { PredictionPricing } from '@feed/core/markets/prediction';
import {
  balanceTransactions,
  db,
  markets,
  perpPositions,
  positions,
  users,
} from '@feed/db';
import {
  CANONICAL_AGENT_TRANSFER_TRANSACTION_TYPES,
  CANONICAL_PEER_TRANSFER_TRANSACTION_TYPES,
  logger,
  resolveUserIdentifierKind,
} from '@feed/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { FEE_CONFIG } from '../config/fees';
import {
  calculatePerpPositionMarketValue,
  toNumber,
} from '../portfolio-valuation';

export interface PortfolioBreakdownSnapshot {
  wallet: number;
  agents: number;
  positions: number;
  available: number;
  netPeerTransfers: number;
  originalAmount: number;
  totalAssets: number;
  totalPnL: number;
  agentCount: number;
  members: PortfolioBreakdownMember[];
}

export interface PortfolioBreakdownMember {
  id: string;
  name: string;
  wallet: number;
  isAgent: boolean;
}

function clampFeeRate(rate: number): number {
  return rate > 0 && rate < 1 ? rate : 0;
}

function calculatePredictionPositionValue(position: {
  shares: unknown;
  avgPrice: unknown;
  side: boolean | null;
  marketYesShares: unknown;
  marketNoShares: unknown;
}): number {
  const shares = toNumber(position.shares);
  const avgPrice = toNumber(position.avgPrice);

  const yesShares = toNumber(position.marketYesShares);
  const noShares = toNumber(position.marketNoShares);

  const feeRate = clampFeeRate(FEE_CONFIG.TRADING_FEE_RATE);
  const costBasisNet = shares * avgPrice;
  const costBasis = feeRate > 0 ? costBasisNet / (1 - feeRate) : costBasisNet;

  if (shares <= 0 || yesShares <= 0 || noShares <= 0) {
    return costBasis;
  }

  const sideKey = position.side ? 'yes' : 'no';
  const sellPreview = PredictionPricing.calculateSellWithFees(
    yesShares,
    noShares,
    sideKey,
    shares,
    feeRate
  );

  return sellPreview.netProceeds ?? sellPreview.totalCost;
}

/**
 * Canonical portfolio breakdown used across Profile, Dashboard, OG, etc.
 *
 * Total P/L formula:
 *   totalPnL = (agents + positions + wallet) - originalAmount
 * where originalAmount includes net peer transfers.
 *
 * **WHY classification-based routing on the initial user row?**
 * - Previously: `or(eq(users.id, userId), eq(users.privyId, userId))` forced the planner to merge predicates and often blocked a clean single-index plan.
 * - Now: `resolveUserIdentifierKind` from `@feed/shared` picks one branch (PK, unique privyId, or case-insensitive username) so each lookup uses one optimal index.
 * - **WHY `lower(username)` for the username branch?** Matches `idx_users_username_lower` and stays consistent with `findUserByIdentifier` (case-insensitive usernames).
 *
 * Further detail: `packages/engine/src/services/PORTFOLIO_BREAKDOWN_OPTIMIZATION.md`.
 *
 * @param userId - User identifier (UUID, snowflake ID, privyId, or username)
 * @returns Portfolio snapshot or null if user not found
 */
export async function calculatePortfolioBreakdown(
  userId: string
): Promise<PortfolioBreakdownSnapshot | null> {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    return null;
  }

  // User IDs may come in as either the canonical `users.id` or `users.privyId`.
  // To keep portfolio totals stable across migrations, we treat both as aliases
  // for the same user when present.
  // Classify identifier to determine optimal query route
  // WHY: Eliminates OR condition that prevents optimal index usage.
  // Same optimization pattern as other identifier-routed services.
  const kind = resolveUserIdentifierKind(normalizedUserId);

  // Route to single WHERE condition based on classification
  // WHY sql template for username? Username matching must be case-insensitive to use
  // the functional index idx_users_username_lower. Using eq() would be case-sensitive.
  const portfolioSelect = {
    id: users.id,
    privyId: users.privyId,
    displayName: users.displayName,
    username: users.username,
    virtualBalance: users.virtualBalance,
    totalDeposited: users.totalDeposited,
    totalWithdrawn: users.totalWithdrawn,
  };

  const whereClause =
    kind === 'id'
      ? eq(users.id, normalizedUserId)
      : kind === 'privyId'
        ? eq(users.privyId, normalizedUserId)
        : sql`lower(${users.username}) = lower(${normalizedUserId})`; // Case-insensitive for functional index

  const userResult = await db
    .select(portfolioSelect)
    .from(users)
    .where(whereClause)
    .limit(1);

  type PortfolioUserRow = {
    id: string;
    privyId: string | null;
    displayName: string | null;
    username: string | null;
    virtualBalance: unknown;
    totalDeposited: unknown;
    totalWithdrawn: unknown;
  };

  let user = userResult[0] as PortfolioUserRow | undefined;

  // Fallback: did:privy: identifiers may be stored as the primary key
  // instead of in the privyId column. PK lookup is O(1).
  if (!user && kind !== 'id') {
    const fallbackResult = await db
      .select(portfolioSelect)
      .from(users)
      .where(eq(users.id, normalizedUserId))
      .limit(1);
    user = fallbackResult[0] as PortfolioUserRow | undefined;
  }

  if (!user) return null;

  const canonicalUserId = user.id;
  const positionUserIds = Array.from(
    new Set([canonicalUserId, user.privyId].filter(Boolean))
  ) as string[];

  const agentRows = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      username: users.username,
      virtualBalance: users.virtualBalance,
    })
    .from(users)
    .where(and(eq(users.managedBy, canonicalUserId), eq(users.isAgent, true)));

  const agentCount = agentRows.length;

  const wallet = toNumber(user.virtualBalance);
  const agents = agentRows.reduce(
    (sum, agent) => sum + toNumber(agent.virtualBalance),
    0
  );

  const [perpRows, predictionRows] = await Promise.all([
    db
      .select({
        size: perpPositions.size,
        leverage: perpPositions.leverage,
        unrealizedPnL: perpPositions.unrealizedPnL,
      })
      .from(perpPositions)
      .where(
        and(
          inArray(perpPositions.userId, positionUserIds),
          isNull(perpPositions.closedAt)
        )
      ),
    db
      .select({
        shares: positions.shares,
        avgPrice: positions.avgPrice,
        side: positions.side,
        marketYesShares: markets.yesShares,
        marketNoShares: markets.noShares,
      })
      .from(positions)
      .innerJoin(markets, eq(positions.marketId, markets.id))
      .where(
        and(
          inArray(positions.userId, positionUserIds),
          eq(markets.resolved, false)
        )
      ),
  ]);

  const invalidPerpRows = perpRows.filter(
    (position) => !isOpenPerpPositionStateValid(position)
  );
  if (invalidPerpRows.length > 0) {
    logger.warn(
      'Excluding invalid open perp positions from portfolio breakdown',
      {
        userId: canonicalUserId,
        invalidPerpPositions: invalidPerpRows.length,
      },
      'PortfolioBreakdown'
    );
  }

  const perpsValue = perpRows.reduce(
    (sum, p) => sum + calculatePerpPositionMarketValue(p),
    0
  );

  const predictionsValue = predictionRows.reduce(
    (sum, p) =>
      sum +
      calculatePredictionPositionValue({
        shares: p.shares,
        avgPrice: p.avgPrice,
        side: p.side,
        marketYesShares: p.marketYesShares,
        marketNoShares: p.marketNoShares,
      }),
    0
  );

  const positionsValue = perpsValue + predictionsValue;

  const totalDeposited = toNumber(user.totalDeposited);
  const totalWithdrawn = toNumber(user.totalWithdrawn);

  // Track peer-to-peer trading balance transfers separately from external funding.
  const transferResult = await db
    .select({
      netTransfers: sql<number>`COALESCE(SUM(${balanceTransactions.amount}::numeric), 0)`,
    })
    .from(balanceTransactions)
    .where(
      and(
        inArray(balanceTransactions.userId, positionUserIds),
        inArray(balanceTransactions.type, [
          ...CANONICAL_AGENT_TRANSFER_TRANSACTION_TYPES,
          ...CANONICAL_PEER_TRANSFER_TRANSACTION_TYPES,
          'transfer_sent',
          'transfer_received',
        ])
      )
    )
    .limit(1);

  const netPeerTransfers = toNumber(transferResult[0]?.netTransfers);
  const originalAmount = totalDeposited - totalWithdrawn + netPeerTransfers;

  const available = wallet + agents;
  const totalAssets = wallet + agents + positionsValue;
  const totalPnL = totalAssets - originalAmount;
  const members: PortfolioBreakdownMember[] = [
    {
      id: canonicalUserId,
      name: user.displayName || user.username || 'You (Owner)',
      wallet,
      isAgent: false,
    },
    ...agentRows.map((agent) => ({
      id: agent.id,
      name: agent.displayName || agent.username || 'Agent',
      wallet: toNumber(agent.virtualBalance),
      isAgent: true,
    })),
  ];

  return {
    wallet,
    agents,
    positions: positionsValue,
    available,
    netPeerTransfers,
    originalAmount,
    totalAssets,
    totalPnL,
    agentCount,
    members,
  };
}
