/**
 * Integration tests for the NPC leaderboard fallback metrics path.
 *
 * Verifies that buildFallbackMetricsByPool produces the same results as
 * NPCInvestmentManager.getPortfolioMetrics for identical underlying data,
 * and handles edge cases (empty positions, dedup, all-closed).
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  actorState,
  db,
  eq,
  type Pool,
  perpPositions,
  poolPositions,
} from '@babylon/db';
import {
  buildFallbackMetricsByPool,
  type FallbackPerpRow,
  type FallbackPositionRow,
  NPCInvestmentManager,
} from '@babylon/engine';
import { generateSnowflakeId } from '@babylon/shared';

describe('NPC Leaderboard Fallback Metrics', () => {
  const TEST_POOL_ID = 'test-fallback-pool-' + Date.now();
  const TEST_ACTOR_ID = 'test-fallback-actor-' + Date.now();
  const INITIAL_BALANCE = 10000;

  const testPool = {
    id: TEST_POOL_ID,
    npcActorId: TEST_ACTOR_ID,
    name: 'Fallback Test Pool',
    totalValue: '0',
    totalDeposits: '0',
    availableBalance: '0',
    lifetimePnL: '0',
    performanceFeeRate: 0.05,
    totalFeesCollected: '0',
    isActive: true,
    openedAt: new Date(),
    updatedAt: new Date(),
    status: 'ACTIVE',
  };

  async function fetchFallbackInputs() {
    const [balances, posRows, perpRows] = await Promise.all([
      db
        .select({
          id: actorState.id,
          tradingBalance: actorState.tradingBalance,
        })
        .from(actorState)
        .where(eq(actorState.id, TEST_POOL_ID)),
      db
        .select({
          id: poolPositions.id,
          poolId: poolPositions.poolId,
          marketType: poolPositions.marketType,
          size: poolPositions.size,
          leverage: poolPositions.leverage,
          unrealizedPnL: poolPositions.unrealizedPnL,
          realizedPnL: poolPositions.realizedPnL,
          closedAt: poolPositions.closedAt,
        })
        .from(poolPositions)
        .where(eq(poolPositions.poolId, TEST_POOL_ID)),
      db
        .select({
          id: perpPositions.id,
          userId: perpPositions.userId,
          size: perpPositions.size,
          leverage: perpPositions.leverage,
          unrealizedPnL: perpPositions.unrealizedPnL,
          realizedPnL: perpPositions.realizedPnL,
          closedAt: perpPositions.closedAt,
        })
        .from(perpPositions)
        .where(eq(perpPositions.userId, TEST_POOL_ID)),
    ]);
    return { balances, posRows, perpRows };
  }

  beforeAll(async () => {
    await db.insert(actorState).values({
      id: TEST_POOL_ID,
      tradingBalance: String(INITIAL_BALANCE),
      reputationPoints: 1000,
      hasPool: true,
      updatedAt: new Date(),
    });
  });

  beforeEach(async () => {
    await db
      .delete(poolPositions)
      .where(eq(poolPositions.poolId, TEST_POOL_ID));
    await db
      .delete(perpPositions)
      .where(eq(perpPositions.userId, TEST_POOL_ID));
  });

  afterEach(async () => {
    await db
      .delete(poolPositions)
      .where(eq(poolPositions.poolId, TEST_POOL_ID));
    await db
      .delete(perpPositions)
      .where(eq(perpPositions.userId, TEST_POOL_ID));
  });

  afterAll(async () => {
    await db
      .delete(poolPositions)
      .where(eq(poolPositions.poolId, TEST_POOL_ID));
    await db
      .delete(perpPositions)
      .where(eq(perpPositions.userId, TEST_POOL_ID));
    await db.delete(actorState).where(eq(actorState.id, TEST_POOL_ID));
  });

  test('should match getPortfolioMetrics when no positions exist', async () => {
    const live = await NPCInvestmentManager.getPortfolioMetrics(TEST_POOL_ID);
    const { balances, posRows, perpRows } = await fetchFallbackInputs();

    const fallbackMap = buildFallbackMetricsByPool(
      [testPool as Pool],
      balances,
      posRows as FallbackPositionRow[],
      perpRows as FallbackPerpRow[]
    );
    const fallback = fallbackMap.get(TEST_POOL_ID)!;

    expect(fallback.totalValue).toBe(live.totalValue);
    expect(fallback.availableBalance).toBe(live.availableBalance);
    expect(fallback.realizedPnL).toBe(live.realizedPnL);
    expect(fallback.unrealizedPnL).toBe(live.unrealizedPnL);
    expect(fallback.positionCount).toBe(live.positionCount);
    expect(fallback.utilization).toBe(live.utilization);
  });

  test('should match getPortfolioMetrics with open prediction positions', async () => {
    const posId = await generateSnowflakeId();

    await db.insert(poolPositions).values({
      id: posId,
      poolId: TEST_POOL_ID,
      marketType: 'prediction',
      marketId: 'test-market-fb-1',
      side: 'YES',
      entryPrice: 50,
      currentPrice: 60,
      size: 500,
      unrealizedPnL: 100,
      realizedPnL: null,
      openedAt: new Date(Date.now() - 3600000),
      closedAt: null,
      updatedAt: new Date(),
    });

    const live = await NPCInvestmentManager.getPortfolioMetrics(TEST_POOL_ID);
    const { balances, posRows, perpRows } = await fetchFallbackInputs();

    const fallbackMap = buildFallbackMetricsByPool(
      [testPool as Pool],
      balances,
      posRows as FallbackPositionRow[],
      perpRows as FallbackPerpRow[]
    );
    const fallback = fallbackMap.get(TEST_POOL_ID)!;

    expect(fallback.totalValue).toBe(live.totalValue);
    expect(fallback.unrealizedPnL).toBe(live.unrealizedPnL);
    expect(fallback.positionCount).toBe(live.positionCount);
    expect(fallback.utilization).toBeCloseTo(live.utilization, 2);
  });

  test('should match getPortfolioMetrics with closed positions (realized PnL)', async () => {
    const pos1Id = await generateSnowflakeId();
    const pos2Id = await generateSnowflakeId();

    await db.insert(poolPositions).values([
      {
        id: pos1Id,
        poolId: TEST_POOL_ID,
        marketType: 'prediction',
        marketId: 'test-market-fb-2',
        side: 'YES',
        entryPrice: 50,
        currentPrice: 60,
        size: 100,
        unrealizedPnL: 0,
        realizedPnL: 150,
        openedAt: new Date(Date.now() - 7200000),
        closedAt: new Date(Date.now() - 3600000),
        updatedAt: new Date(),
      },
      {
        id: pos2Id,
        poolId: TEST_POOL_ID,
        marketType: 'prediction',
        marketId: 'test-market-fb-3',
        side: 'NO',
        entryPrice: 40,
        currentPrice: 30,
        size: 200,
        unrealizedPnL: 0,
        realizedPnL: -75,
        openedAt: new Date(Date.now() - 7200000),
        closedAt: new Date(Date.now() - 1800000),
        updatedAt: new Date(),
      },
    ]);

    const live = await NPCInvestmentManager.getPortfolioMetrics(TEST_POOL_ID);
    const { balances, posRows, perpRows } = await fetchFallbackInputs();

    const fallbackMap = buildFallbackMetricsByPool(
      [testPool as Pool],
      balances,
      posRows as FallbackPositionRow[],
      perpRows as FallbackPerpRow[]
    );
    const fallback = fallbackMap.get(TEST_POOL_ID)!;

    expect(fallback.totalValue).toBe(live.totalValue);
    expect(fallback.realizedPnL).toBe(live.realizedPnL);
    expect(fallback.positionCount).toBe(live.positionCount);
  });

  test('should match getPortfolioMetrics with open perp positions', async () => {
    const perpId = await generateSnowflakeId();

    await db.insert(perpPositions).values({
      id: perpId,
      userId: TEST_POOL_ID,
      organizationId: 'org-fb-1',
      ticker: 'ACME',
      side: 'long',
      entryPrice: 100,
      currentPrice: 120,
      size: 600,
      leverage: 3,
      liquidationPrice: 66,
      unrealizedPnL: 120,
      unrealizedPnLPercent: 20,
      realizedPnL: null,
      openedAt: new Date(Date.now() - 3600000),
      closedAt: null,
      lastUpdated: new Date(),
    });

    const live = await NPCInvestmentManager.getPortfolioMetrics(TEST_POOL_ID);
    const { balances, posRows, perpRows } = await fetchFallbackInputs();

    const fallbackMap = buildFallbackMetricsByPool(
      [testPool as Pool],
      balances,
      posRows as FallbackPositionRow[],
      perpRows as FallbackPerpRow[]
    );
    const fallback = fallbackMap.get(TEST_POOL_ID)!;

    expect(fallback.totalValue).toBe(live.totalValue);
    expect(fallback.unrealizedPnL).toBe(live.unrealizedPnL);
    expect(fallback.positionCount).toBe(live.positionCount);
    expect(fallback.utilization).toBeCloseTo(live.utilization, 2);
  });

  test('should match getPortfolioMetrics with mixed pool + perp positions', async () => {
    const poolPosId = await generateSnowflakeId();
    const perpPosId = await generateSnowflakeId();
    const closedPerpId = await generateSnowflakeId();

    await db.insert(poolPositions).values({
      id: poolPosId,
      poolId: TEST_POOL_ID,
      marketType: 'prediction',
      marketId: 'test-market-fb-mix',
      side: 'YES',
      entryPrice: 50,
      currentPrice: 55,
      size: 100,
      unrealizedPnL: 50,
      realizedPnL: null,
      openedAt: new Date(Date.now() - 1800000),
      closedAt: null,
      updatedAt: new Date(),
    });

    await db.insert(perpPositions).values([
      {
        id: perpPosId,
        userId: TEST_POOL_ID,
        organizationId: 'org-fb-mix',
        ticker: 'BETA',
        side: 'long',
        entryPrice: 100,
        currentPrice: 95,
        size: 300,
        leverage: 1,
        liquidationPrice: 50,
        unrealizedPnL: -25,
        unrealizedPnLPercent: -8.33,
        realizedPnL: null,
        openedAt: new Date(Date.now() - 1800000),
        closedAt: null,
        lastUpdated: new Date(),
      },
      {
        id: closedPerpId,
        userId: TEST_POOL_ID,
        organizationId: 'org-fb-mix2',
        ticker: 'GAMMA',
        side: 'short',
        entryPrice: 150,
        currentPrice: 140,
        size: 400,
        leverage: 2,
        liquidationPrice: 300,
        unrealizedPnL: 0,
        unrealizedPnLPercent: 0,
        realizedPnL: 350,
        openedAt: new Date(Date.now() - 5400000),
        closedAt: new Date(Date.now() - 1800000),
        lastUpdated: new Date(),
      },
    ]);

    const live = await NPCInvestmentManager.getPortfolioMetrics(TEST_POOL_ID);
    const { balances, posRows, perpRows } = await fetchFallbackInputs();

    const fallbackMap = buildFallbackMetricsByPool(
      [testPool as Pool],
      balances,
      posRows as FallbackPositionRow[],
      perpRows as FallbackPerpRow[]
    );
    const fallback = fallbackMap.get(TEST_POOL_ID)!;

    expect(fallback.totalValue).toBe(live.totalValue);
    expect(fallback.realizedPnL).toBe(live.realizedPnL);
    expect(fallback.unrealizedPnL).toBe(live.unrealizedPnL);
    expect(fallback.positionCount).toBe(live.positionCount);
    expect(fallback.utilization).toBeCloseTo(live.utilization, 2);
  });

  test('should dedupe legacy perp rows in poolPositions', async () => {
    const sharedId = await generateSnowflakeId();

    // Same position exists in both tables (legacy data pattern)
    await db.insert(poolPositions).values({
      id: sharedId,
      poolId: TEST_POOL_ID,
      marketType: 'perp',
      ticker: 'ACME',
      side: 'long',
      entryPrice: 100,
      currentPrice: 120,
      size: 400,
      leverage: 2,
      liquidationPrice: 50,
      unrealizedPnL: 80,
      realizedPnL: null,
      openedAt: new Date(Date.now() - 3600000),
      closedAt: null,
      updatedAt: new Date(),
    });

    await db.insert(perpPositions).values({
      id: sharedId,
      userId: TEST_POOL_ID,
      organizationId: 'org-fb-dedup',
      ticker: 'ACME',
      side: 'long',
      entryPrice: 100,
      currentPrice: 120,
      size: 400,
      leverage: 2,
      liquidationPrice: 50,
      unrealizedPnL: 80,
      unrealizedPnLPercent: 20,
      realizedPnL: null,
      openedAt: new Date(Date.now() - 3600000),
      closedAt: null,
      lastUpdated: new Date(),
    });

    const live = await NPCInvestmentManager.getPortfolioMetrics(TEST_POOL_ID);
    const { balances, posRows, perpRows } = await fetchFallbackInputs();

    const fallbackMap = buildFallbackMetricsByPool(
      [testPool as Pool],
      balances,
      posRows as FallbackPositionRow[],
      perpRows as FallbackPerpRow[]
    );
    const fallback = fallbackMap.get(TEST_POOL_ID)!;

    // Must count the position only once
    expect(fallback.positionCount).toBe(1);
    expect(live.positionCount).toBe(1);

    expect(fallback.totalValue).toBe(live.totalValue);
    expect(fallback.unrealizedPnL).toBe(live.unrealizedPnL);
  });
});
