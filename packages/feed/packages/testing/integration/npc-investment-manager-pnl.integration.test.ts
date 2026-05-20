/**
 * Integration test for NPCInvestmentManager.getPortfolioMetrics() realized PnL
 * calculation.
 *
 * This test performs real database writes/reads and belongs in the integration
 * suite (not unit).
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
import { actorState, db, eq, perpPositions, poolPositions } from '@babylon/db';
import { NPCInvestmentManager } from '@babylon/engine';
import { generateSnowflakeId } from '@babylon/shared';

describe('NPCInvestmentManager - Realized PnL Calculation', () => {
  const TEST_ACTOR_ID = 'test-actor-pnl-' + Date.now();
  const INITIAL_BALANCE = 10000;

  beforeAll(async () => {
    // Create test actor state
    await db.insert(actorState).values({
      id: TEST_ACTOR_ID,
      tradingBalance: String(INITIAL_BALANCE),
      reputationPoints: 1000,
      hasPool: true,
      updatedAt: new Date(),
    });
  });

  beforeEach(async () => {
    await db
      .delete(poolPositions)
      .where(eq(poolPositions.poolId, TEST_ACTOR_ID));
    await db
      .delete(perpPositions)
      .where(eq(perpPositions.userId, TEST_ACTOR_ID));
  });

  afterEach(async () => {
    await db
      .delete(poolPositions)
      .where(eq(poolPositions.poolId, TEST_ACTOR_ID));
    await db
      .delete(perpPositions)
      .where(eq(perpPositions.userId, TEST_ACTOR_ID));
  });

  afterAll(async () => {
    // Clean up test data
    await db
      .delete(poolPositions)
      .where(eq(poolPositions.poolId, TEST_ACTOR_ID));
    await db
      .delete(perpPositions)
      .where(eq(perpPositions.userId, TEST_ACTOR_ID));
    await db.delete(actorState).where(eq(actorState.id, TEST_ACTOR_ID));
  });

  test('should return 0 realized PnL when no positions exist', async () => {
    const metrics =
      await NPCInvestmentManager.getPortfolioMetrics(TEST_ACTOR_ID);

    expect(metrics.realizedPnL).toBe(0);
    expect(metrics.unrealizedPnL).toBe(0);
    expect(metrics.positionCount).toBe(0);
  });

  test('should calculate realized PnL from closed pool positions', async () => {
    const pos1Id = await generateSnowflakeId();
    const pos2Id = await generateSnowflakeId();

    // Create closed positions with realized PnL
    await db.insert(poolPositions).values([
      {
        id: pos1Id,
        poolId: TEST_ACTOR_ID,
        marketType: 'prediction',
        marketId: 'test-market-1',
        side: 'YES',
        entryPrice: 50,
        currentPrice: 60,
        size: 100,
        unrealizedPnL: 0, // Closed positions have 0 unrealized
        realizedPnL: 150, // Profit of $150
        openedAt: new Date(Date.now() - 3600000),
        closedAt: new Date(Date.now() - 1800000), // Closed 30 min ago
        updatedAt: new Date(),
      },
      {
        id: pos2Id,
        poolId: TEST_ACTOR_ID,
        marketType: 'prediction',
        marketId: 'test-market-2',
        side: 'NO',
        entryPrice: 40,
        currentPrice: 30,
        size: 200,
        unrealizedPnL: 0,
        realizedPnL: -75, // Loss of $75
        openedAt: new Date(Date.now() - 7200000),
        closedAt: new Date(Date.now() - 3600000), // Closed 1 hr ago
        updatedAt: new Date(),
      },
    ]);

    const metrics =
      await NPCInvestmentManager.getPortfolioMetrics(TEST_ACTOR_ID);

    // Total realized should be 150 + (-75) = 75
    expect(metrics.realizedPnL).toBe(75);
    expect(metrics.unrealizedPnL).toBe(0);
    expect(metrics.positionCount).toBe(0); // No open positions

    // Clean up
    await db
      .delete(poolPositions)
      .where(eq(poolPositions.poolId, TEST_ACTOR_ID));
  });

  test('should calculate realized PnL from closed perp positions', async () => {
    const perpPos1Id = await generateSnowflakeId();
    const perpPos2Id = await generateSnowflakeId();

    // Create closed perp positions
    await db.insert(perpPositions).values([
      {
        id: perpPos1Id,
        userId: TEST_ACTOR_ID,
        organizationId: 'org-1',
        ticker: 'ACME',
        side: 'long',
        entryPrice: 100,
        currentPrice: 110,
        size: 500,
        leverage: 2,
        liquidationPrice: 50,
        unrealizedPnL: 0,
        unrealizedPnLPercent: 0,
        realizedPnL: 250, // Profit of $250
        openedAt: new Date(Date.now() - 7200000),
        closedAt: new Date(Date.now() - 3600000),
        lastUpdated: new Date(),
      },
      {
        id: perpPos2Id,
        userId: TEST_ACTOR_ID,
        organizationId: 'org-2',
        ticker: 'BETA',
        side: 'short',
        entryPrice: 200,
        currentPrice: 190,
        size: 300,
        leverage: 1,
        liquidationPrice: 400,
        unrealizedPnL: 0,
        unrealizedPnLPercent: 0,
        realizedPnL: -100, // Loss of $100
        openedAt: new Date(Date.now() - 5400000),
        closedAt: new Date(Date.now() - 1800000),
        lastUpdated: new Date(),
      },
    ]);

    const metrics =
      await NPCInvestmentManager.getPortfolioMetrics(TEST_ACTOR_ID);

    // Total realized should be 250 + (-100) = 150
    expect(metrics.realizedPnL).toBe(150);
    expect(metrics.unrealizedPnL).toBe(0);
    expect(metrics.positionCount).toBe(0);

    // Clean up
    await db
      .delete(perpPositions)
      .where(eq(perpPositions.userId, TEST_ACTOR_ID));
  });

  test('should sum realized PnL from closed pool and perp positions', async () => {
    const poolPosId = await generateSnowflakeId();
    const perpPosId = await generateSnowflakeId();

    await db.insert(poolPositions).values({
      id: poolPosId,
      poolId: TEST_ACTOR_ID,
      marketType: 'prediction',
      marketId: 'test-market-3b',
      side: 'YES',
      entryPrice: 50,
      currentPrice: 55,
      size: 120,
      unrealizedPnL: 0,
      realizedPnL: 120, // Profit of $120
      openedAt: new Date(Date.now() - 7200000),
      closedAt: new Date(Date.now() - 3600000),
      updatedAt: new Date(),
    });

    await db.insert(perpPositions).values({
      id: perpPosId,
      userId: TEST_ACTOR_ID,
      organizationId: 'org-2b',
      ticker: 'OMEGA',
      side: 'short',
      entryPrice: 200,
      currentPrice: 190,
      size: 300,
      leverage: 1,
      liquidationPrice: 400,
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,
      realizedPnL: -30, // Loss of $30
      openedAt: new Date(Date.now() - 5400000),
      closedAt: new Date(Date.now() - 1800000),
      lastUpdated: new Date(),
    });

    const metrics =
      await NPCInvestmentManager.getPortfolioMetrics(TEST_ACTOR_ID);

    expect(metrics.realizedPnL).toBe(90);
    expect(metrics.unrealizedPnL).toBe(0);
    expect(metrics.positionCount).toBe(0);

    await db
      .delete(poolPositions)
      .where(eq(poolPositions.poolId, TEST_ACTOR_ID));
    await db
      .delete(perpPositions)
      .where(eq(perpPositions.userId, TEST_ACTOR_ID));
  });

  test('should calculate both realized and unrealized PnL correctly', async () => {
    const openPosId = await generateSnowflakeId();
    const closedPosId = await generateSnowflakeId();
    const openPerpId = await generateSnowflakeId();
    const closedPerpId = await generateSnowflakeId();

    // Create mix of open and closed positions
    await db.insert(poolPositions).values([
      {
        id: openPosId,
        poolId: TEST_ACTOR_ID,
        marketType: 'prediction',
        marketId: 'test-market-3',
        side: 'YES',
        entryPrice: 50,
        currentPrice: 55,
        size: 100,
        unrealizedPnL: 50, // Open position with unrealized profit
        realizedPnL: null,
        openedAt: new Date(Date.now() - 1800000),
        closedAt: null,
        updatedAt: new Date(),
      },
      {
        id: closedPosId,
        poolId: TEST_ACTOR_ID,
        marketType: 'prediction',
        marketId: 'test-market-4',
        side: 'NO',
        entryPrice: 60,
        currentPrice: 50,
        size: 200,
        unrealizedPnL: 0,
        realizedPnL: 200, // Closed with profit
        openedAt: new Date(Date.now() - 7200000),
        closedAt: new Date(Date.now() - 3600000),
        updatedAt: new Date(),
      },
    ]);

    await db.insert(perpPositions).values([
      {
        id: openPerpId,
        userId: TEST_ACTOR_ID,
        organizationId: 'org-3',
        ticker: 'GAMMA',
        side: 'long',
        entryPrice: 100,
        currentPrice: 95,
        size: 300,
        leverage: 1,
        liquidationPrice: 50,
        unrealizedPnL: -25, // Open position with unrealized loss
        unrealizedPnLPercent: -8.33,
        realizedPnL: null,
        openedAt: new Date(Date.now() - 1800000),
        closedAt: null,
        lastUpdated: new Date(),
      },
      {
        id: closedPerpId,
        userId: TEST_ACTOR_ID,
        organizationId: 'org-4',
        ticker: 'DELTA',
        side: 'short',
        entryPrice: 150,
        currentPrice: 140,
        size: 400,
        leverage: 2,
        liquidationPrice: 300,
        unrealizedPnL: 0,
        unrealizedPnLPercent: 0,
        realizedPnL: 350, // Closed with profit
        openedAt: new Date(Date.now() - 5400000),
        closedAt: new Date(Date.now() - 1800000),
        lastUpdated: new Date(),
      },
    ]);

    const metrics =
      await NPCInvestmentManager.getPortfolioMetrics(TEST_ACTOR_ID);

    // Unrealized: 50 (pool) + (-25) (perp) = 25
    expect(metrics.unrealizedPnL).toBe(25);

    // Realized: 200 (pool) + 350 (perp) = 550
    expect(metrics.realizedPnL).toBe(550);

    // Open positions: 1 pool + 1 perp = 2
    expect(metrics.positionCount).toBe(2);

    // Total value should include unrealized PnL
    const expectedTotalValue =
      INITIAL_BALANCE + // 10000
      100 + // openPoolPos.size
      300 + // openPerpPos.size (margin at 1x leverage)
      25; // unrealizedPnL
    expect(metrics.totalValue).toBe(expectedTotalValue);

    // Clean up
    await db
      .delete(poolPositions)
      .where(eq(poolPositions.poolId, TEST_ACTOR_ID));
    await db
      .delete(perpPositions)
      .where(eq(perpPositions.userId, TEST_ACTOR_ID));
  });

  test('should handle null realizedPnL gracefully', async () => {
    const posId = await generateSnowflakeId();

    // Create a closed position with null realizedPnL (shouldn't happen, but defensive)
    await db.insert(poolPositions).values({
      id: posId,
      poolId: TEST_ACTOR_ID,
      marketType: 'prediction',
      marketId: 'test-market-5',
      side: 'YES',
      entryPrice: 50,
      currentPrice: 50,
      size: 100,
      unrealizedPnL: 0,
      realizedPnL: null, // null instead of 0
      openedAt: new Date(Date.now() - 3600000),
      closedAt: new Date(Date.now() - 1800000),
      updatedAt: new Date(),
    });

    const metrics =
      await NPCInvestmentManager.getPortfolioMetrics(TEST_ACTOR_ID);

    // Should treat null as 0
    expect(metrics.realizedPnL).toBe(0);

    // Clean up
    await db
      .delete(poolPositions)
      .where(eq(poolPositions.poolId, TEST_ACTOR_ID));
  });

  test('should dedupe legacy pool perp rows when perp positions exist', async () => {
    const sharedId = await generateSnowflakeId();

    await db.insert(poolPositions).values({
      id: sharedId,
      poolId: TEST_ACTOR_ID,
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
      userId: TEST_ACTOR_ID,
      organizationId: 'org-dedupe',
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

    const metrics =
      await NPCInvestmentManager.getPortfolioMetrics(TEST_ACTOR_ID);

    expect(metrics.positionCount).toBe(1);
    expect(metrics.unrealizedPnL).toBe(80);
    expect(metrics.totalValue).toBe(INITIAL_BALANCE + 200 + 80);
  });
});
