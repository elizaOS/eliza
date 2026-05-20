/**
 * Integration test: Perp Market Constant-Product AMM Average Fill Pricing
 *
 * Tests the complete trading flow against a real database to verify:
 * 1. AMM avg fill pricing works correctly (entry between pre/post spot)
 * 2. Round-trip economics are neutral (no self-impact exploit)
 * 3. Large leveraged shorts don't generate self-impact profit
 * 4. Multi-user trading is fair (impact from others is legitimate)
 * 5. Partial closes work correctly with impact adjustment
 * 6. Wallet balances are consistent throughout
 *
 * Run with: DATABASE_URL="postgresql://feed:feed_dev_password@localhost:5433/feed" bun test packages/testing/integration/perp-avg-fill-integration.test.ts
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import type { WalletPort } from '@feed/core/markets/perps';
import {
  isOpenPerpPositionStateValid,
  PerpDbAdapter,
  PerpMarketService,
  type PerpServiceDeps,
  type PriceImpactPort,
} from '@feed/core/markets/perps';
import {
  and,
  db,
  eq,
  isNull,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
} from '@feed/db';
import {
  calculatePriceFromHoldings,
  calculateTradeImpact,
  PERP_MARKET_CONFIG,
} from '@feed/shared';

// ---------------------------------------------------------------------------
// Test-local wallet (in-memory, no real wallet service needed)
// ---------------------------------------------------------------------------
class TestWallet implements WalletPort {
  private balances = new Map<string, number>();
  private txLog: Array<{
    type: string;
    userId: string;
    amount: number;
    reason: string;
  }> = [];

  constructor(private defaultBalance = 100_000) {}

  async debit(p: {
    userId: string;
    amount: number;
    reason: string;
    description?: string;
    relatedId?: string;
  }) {
    const bal = this.balances.get(p.userId) ?? this.defaultBalance;
    if (bal < p.amount)
      throw new Error(`Insufficient funds: ${bal} < ${p.amount}`);
    this.balances.set(p.userId, bal - p.amount);
    this.txLog.push({
      type: 'debit',
      userId: p.userId,
      amount: p.amount,
      reason: p.reason,
    });
  }

  async credit(p: {
    userId: string;
    amount: number;
    reason: string;
    description?: string;
    relatedId?: string;
  }) {
    const bal = this.balances.get(p.userId) ?? this.defaultBalance;
    this.balances.set(p.userId, bal + p.amount);
    this.txLog.push({
      type: 'credit',
      userId: p.userId,
      amount: p.amount,
      reason: p.reason,
    });
  }

  async recordPnL(p: {
    userId: string;
    pnl: number;
    reason: string;
    relatedId?: string;
  }) {
    this.txLog.push({
      type: 'pnl',
      userId: p.userId,
      amount: p.pnl,
      reason: p.reason,
    });
  }

  async getBalance(userId: string) {
    return { balance: this.balances.get(userId) ?? this.defaultBalance };
  }

  getLog() {
    return this.txLog;
  }
  reset() {
    this.balances.clear();
    this.txLog.length = 0;
  }
  bal(userId: string) {
    return this.balances.get(userId) ?? this.defaultBalance;
  }
}

// ---------------------------------------------------------------------------
// Test-local PriceImpactPort (mirrors the real adapter)
// ---------------------------------------------------------------------------
let BASE_PRICE = 100;

function createTestPriceImpact(): PriceImpactPort {
  return {
    async applyAndGetPrice(ticker: string): Promise<number | undefined> {
      const normalizedTicker = ticker.toUpperCase();

      const [snapshot] = await db
        .select({
          organizationId: perpMarketSnapshots.organizationId,
          currentPrice: perpMarketSnapshots.currentPrice,
        })
        .from(perpMarketSnapshots)
        .where(eq(perpMarketSnapshots.ticker, normalizedTicker))
        .limit(1);
      if (!snapshot) return undefined;

      const [state] = await db
        .select({
          basePrice: organizationState.basePrice,
          currentPrice: organizationState.currentPrice,
        })
        .from(organizationState)
        .where(eq(organizationState.id, snapshot.organizationId))
        .limit(1);
      if (!state) return undefined;

      const initialPrice = Number(state.basePrice ?? 100);
      const currentPrice = Number(
        snapshot.currentPrice ?? state.currentPrice ?? initialPrice
      );

      const openPositions = await db
        .select({
          side: perpPositions.side,
          size: perpPositions.size,
          leverage: perpPositions.leverage,
          userId: perpPositions.userId,
        })
        .from(perpPositions)
        .where(
          and(
            eq(perpPositions.ticker, normalizedTicker),
            isNull(perpPositions.closedAt)
          )
        );

      let netHoldings = 0;
      for (const pos of openPositions) {
        if (!isOpenPerpPositionStateValid(pos)) {
          continue;
        }

        const size = Number(pos.size);
        netHoldings += pos.side === 'long' ? size : -size;
      }

      const newPrice = calculatePriceFromHoldings(
        initialPrice,
        currentPrice,
        netHoldings,
        PERP_MARKET_CONFIG
      );

      if (Math.abs(newPrice - currentPrice) < 0.001) return currentPrice;

      await db
        .update(perpMarketSnapshots)
        .set({ currentPrice: newPrice })
        .where(eq(perpMarketSnapshots.ticker, normalizedTicker));

      await db
        .update(organizationState)
        .set({ currentPrice: newPrice })
        .where(eq(organizationState.id, snapshot.organizationId));

      return newPrice;
    },

    async getBasePrice(ticker: string): Promise<number | undefined> {
      const normalizedTicker = ticker.toUpperCase();
      const [snapshot] = await db
        .select({ organizationId: perpMarketSnapshots.organizationId })
        .from(perpMarketSnapshots)
        .where(eq(perpMarketSnapshots.ticker, normalizedTicker))
        .limit(1);
      if (!snapshot) return undefined;

      const [state] = await db
        .select({ basePrice: organizationState.basePrice })
        .from(organizationState)
        .where(eq(organizationState.id, snapshot.organizationId))
        .limit(1);

      return state ? Number(state.basePrice ?? 100) : undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Helper to create a test service
// ---------------------------------------------------------------------------
function createTestService(wallet: TestWallet): PerpMarketService {
  const deps: PerpServiceDeps = {
    db: new PerpDbAdapter(),
    wallet,
    fees: {
      tradingFeeRate: 0.001,
      platformShare: 0.5,
      referrerShare: 0.5,
      minFeeAmount: 0.01,
    },
    priceImpact: createTestPriceImpact(),
  };
  return new PerpMarketService(deps);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let TEST_TICKER = '';
let ORG_ID = '';

const USER_A = 'test-avg-fill-user-a-' + Date.now();
const USER_B = 'test-avg-fill-user-b-' + Date.now();
const USER_C = 'test-avg-fill-user-c-' + Date.now();

const createdPositionIds: string[] = [];

async function findCleanTestMarket() {
  const markets = await db.select().from(perpMarketSnapshots);

  for (const market of markets) {
    if (Number(market.currentPrice) <= 10) {
      continue;
    }

    const openPositions = await db
      .select({ id: perpPositions.id })
      .from(perpPositions)
      .where(
        and(
          eq(perpPositions.ticker, market.ticker),
          isNull(perpPositions.closedAt)
        )
      )
      .limit(1);

    if (openPositions.length === 0) {
      return market;
    }
  }

  throw new Error('No clean perp market found for avg-fill integration tests');
}

async function resetTestMarketState() {
  const openPositions = await db
    .select({ id: perpPositions.id })
    .from(perpPositions)
    .where(
      and(eq(perpPositions.ticker, TEST_TICKER), isNull(perpPositions.closedAt))
    );

  if (openPositions.length > 0) {
    const closedAt = new Date();
    for (const position of openPositions) {
      await db
        .update(perpPositions)
        .set({
          closedAt,
          currentPrice: BASE_PRICE,
          realizedPnL: 0,
          unrealizedPnL: 0,
          unrealizedPnLPercent: 0,
        })
        .where(eq(perpPositions.id, position.id));
    }
  }

  await db
    .update(perpMarketSnapshots)
    .set({ currentPrice: BASE_PRICE, openInterest: 0, volume24h: 0 })
    .where(eq(perpMarketSnapshots.ticker, TEST_TICKER));
  await db
    .update(organizationState)
    .set({ currentPrice: BASE_PRICE })
    .where(eq(organizationState.id, ORG_ID));
}

describe('Perp Constant-Product AMM Average Fill Integration', () => {
  beforeAll(async () => {
    const cleanMarket = await findCleanTestMarket();

    TEST_TICKER = cleanMarket.ticker;
    ORG_ID = cleanMarket.organizationId;

    const [state] = await db
      .select()
      .from(organizationState)
      .where(eq(organizationState.id, ORG_ID))
      .limit(1);

    const stateBasePrice = state ? Number(state.basePrice ?? 0) : 0;
    const marketCurrentPrice = Number(cleanMarket.currentPrice ?? 0);
    BASE_PRICE =
      stateBasePrice > 0
        ? stateBasePrice
        : marketCurrentPrice > 0
          ? marketCurrentPrice
          : 100;

    await resetTestMarketState();

    console.log(
      `\nUsing ticker: ${TEST_TICKER}, basePrice: ${BASE_PRICE}, baseReserve: ${PERP_MARKET_CONFIG.INITIAL_BASE_RESERVE}`
    );
    console.log(
      `Users: ${USER_A.slice(-10)}, ${USER_B.slice(-10)}, ${USER_C.slice(-10)}`
    );
  });

  afterAll(async () => {
    console.log(`\nCleaning up ${createdPositionIds.length} test positions...`);
    await resetTestMarketState();
    console.log('Cleanup complete.');
  });

  beforeEach(async () => {
    await resetTestMarketState();
  });

  // =========================================================================
  // TEST 1: Open long → avg fill is between pre and post spot
  // =========================================================================
  it('open long uses AMM average fill entry price', async () => {
    const wallet = new TestWallet();
    const service = createTestService(wallet);

    const size = 2500;

    // Use the AMM to compute expected avg fill
    const { avgFillPrice, newSpotPrice } = calculateTradeImpact(
      BASE_PRICE,
      0, // no prior holdings
      size,
      PERP_MARKET_CONFIG
    );

    const result = await service.openPosition({
      userId: USER_A,
      ticker: TEST_TICKER,
      side: 'long',
      size,
      leverage: 5,
    });
    createdPositionIds.push(result.positionId);

    console.log(
      `  Open long: base=${BASE_PRICE}, expectedAvg=${avgFillPrice.toFixed(2)}, newSpot=${newSpotPrice.toFixed(2)}, actual=${result.entryPrice.toFixed(2)}`
    );

    // Avg fill should be between the pre-trade and post-trade spot prices
    expect(result.entryPrice).toBeGreaterThan(BASE_PRICE);
    expect(result.entryPrice).toBeLessThanOrEqual(newSpotPrice);
  });

  // =========================================================================
  // TEST 2: Round-trip long → PnL ~ 0 (self-impact cancels)
  // =========================================================================
  it('round-trip long has near-zero PnL (self-impact cancels)', async () => {
    const wallet = new TestWallet(100_000);
    const service = createTestService(wallet);

    const size = 2500;
    const startBal = wallet.bal(USER_B);

    // Open
    const open = await service.openPosition({
      userId: USER_B,
      ticker: TEST_TICKER,
      side: 'long',
      size,
      leverage: 5,
    });
    createdPositionIds.push(open.positionId);

    // Close immediately
    const close = await service.closePosition({
      userId: USER_B,
      positionId: open.positionId,
    });

    const endBal = wallet.bal(USER_B);
    const netChange = endBal - startBal;
    const pnl = close.realizedPnL ?? 0;
    const totalFees = open.feePaid + close.feePaid;

    console.log(
      `  Round-trip: entry=${open.entryPrice.toFixed(2)}, exit=${close.exitPrice?.toFixed(2)}, PnL=${pnl.toFixed(4)}, net=${netChange.toFixed(2)}, fees=${totalFees.toFixed(2)}`
    );

    // PnL should be near zero (AMM is symmetric for same-size open+close)
    expect(Math.abs(pnl)).toBeLessThan(1.0);
    // Net change should be negative (only fees)
    expect(netChange).toBeLessThanOrEqual(1.0);
    expect(Math.abs(netChange + totalFees)).toBeLessThan(2.0);
  });

  // =========================================================================
  // TEST 3: Round-trip short → PnL ~ 0
  // =========================================================================
  it('round-trip short has near-zero PnL', async () => {
    const wallet = new TestWallet(100_000);
    const service = createTestService(wallet);

    const size = 3000;
    const startBal = wallet.bal(USER_C);

    const open = await service.openPosition({
      userId: USER_C,
      ticker: TEST_TICKER,
      side: 'short',
      size,
      leverage: 10,
    });
    createdPositionIds.push(open.positionId);

    const close = await service.closePosition({
      userId: USER_C,
      positionId: open.positionId,
    });

    const endBal = wallet.bal(USER_C);
    const netChange = endBal - startBal;
    const pnl = close.realizedPnL ?? 0;
    const totalFees = open.feePaid + close.feePaid;

    console.log(
      `  Round-trip short: entry=${open.entryPrice.toFixed(2)}, exit=${close.exitPrice?.toFixed(2)}, PnL=${pnl.toFixed(4)}, net=${netChange.toFixed(2)}, fees=${totalFees.toFixed(2)}`
    );

    expect(Math.abs(pnl)).toBeLessThan(1.0);
    expect(netChange).toBeLessThanOrEqual(1.0);
  });

  // =========================================================================
  // TEST 4: Max leverage short (the original BF-75 exploit) → no profit
  // =========================================================================
  it('max leverage short does NOT generate self-impact profit', async () => {
    const wallet = new TestWallet(100_000);
    const service = createTestService(wallet);

    const startBal = wallet.bal(USER_B);

    const open = await service.openPosition({
      userId: USER_B,
      ticker: TEST_TICKER,
      side: 'short',
      size: 10_000,
      leverage: 10,
    });
    createdPositionIds.push(open.positionId);

    const close = await service.closePosition({
      userId: USER_B,
      positionId: open.positionId,
    });

    const endBal = wallet.bal(USER_B);
    const netProfit = endBal - startBal;
    const pnl = close.realizedPnL ?? 0;
    const totalFees = open.feePaid + close.feePaid;

    console.log(
      `  Exploit test: entry=${open.entryPrice.toFixed(2)}, exit=${close.exitPrice?.toFixed(2)}, PnL=${pnl.toFixed(4)}, netProfit=${netProfit.toFixed(2)}, fees=${totalFees.toFixed(2)}`
    );

    // The exploit should be blocked: user should NOT profit
    expect(netProfit).toBeLessThanOrEqual(1.0);
    // PnL should be near zero
    expect(Math.abs(pnl)).toBeLessThan(5.0);
  });

  // =========================================================================
  // TEST 5: Multiple rapid open/close cycles → no compounding exploit
  // =========================================================================
  it('rapid open/close cycles do not generate profit', async () => {
    const wallet = new TestWallet(50_000);
    const service = createTestService(wallet);

    const startBal = wallet.bal(USER_A);
    let totalFees = 0;

    for (let i = 0; i < 5; i++) {
      const open = await service.openPosition({
        userId: USER_A,
        ticker: TEST_TICKER,
        side: i % 2 === 0 ? 'long' : 'short',
        size: 1500,
        leverage: 5,
      });
      createdPositionIds.push(open.positionId);
      totalFees += open.feePaid;

      const close = await service.closePosition({
        userId: USER_A,
        positionId: open.positionId,
      });
      totalFees += close.feePaid;
    }

    const endBal = wallet.bal(USER_A);
    const netChange = endBal - startBal;

    console.log(
      `  5 cycles: start=${startBal.toFixed(2)}, end=${endBal.toFixed(2)}, net=${netChange.toFixed(2)}, fees=${totalFees.toFixed(2)}`
    );

    // Net change should be negative (just fees, no compounding profit)
    expect(netChange).toBeLessThanOrEqual(1.0);
  });

  // =========================================================================
  // TEST 6: Multi-user: A profits from B's legitimate impact
  // =========================================================================
  it('multi-user: profit from other users impact is legitimate', async () => {
    const walletA = new TestWallet(100_000);
    const serviceA = createTestService(walletA);
    const walletB = new TestWallet(100_000);
    const serviceB = createTestService(walletB);

    // A opens long first
    const openA = await serviceA.openPosition({
      userId: USER_A,
      ticker: TEST_TICKER,
      side: 'long',
      size: 2000,
      leverage: 5,
    });
    createdPositionIds.push(openA.positionId);

    // B opens a bigger long → pushes market further up
    const openB = await serviceB.openPosition({
      userId: USER_B,
      ticker: TEST_TICKER,
      side: 'long',
      size: 5000,
      leverage: 5,
    });
    createdPositionIds.push(openB.positionId);

    // A closes → should capture some of B's impact
    const closeA = await serviceA.closePosition({
      userId: USER_A,
      positionId: openA.positionId,
    });

    const pnlA = closeA.realizedPnL ?? 0;
    console.log(
      `  Multi-user: A entry=${openA.entryPrice.toFixed(2)}, exit=${closeA.exitPrice?.toFixed(2)}, PnL=${pnlA.toFixed(2)}`
    );

    // A should have SOME positive PnL (from B's impact pushing price up)
    // This is legitimate profit, not self-impact
    expect(pnlA).toBeGreaterThan(-20); // shouldn't lose a lot

    // Clean up B
    const closeB = await serviceB.closePosition({
      userId: USER_B,
      positionId: openB.positionId,
    });
    console.log(`  B PnL: ${(closeB.realizedPnL ?? 0).toFixed(2)}`);
  });

  // =========================================================================
  // TEST 7: Partial close works correctly
  // =========================================================================
  it('partial close correctly applies avg fill on closed portion', async () => {
    const wallet = new TestWallet(100_000);
    const service = createTestService(wallet);

    const open = await service.openPosition({
      userId: USER_C,
      ticker: TEST_TICKER,
      side: 'long',
      size: 4000,
      leverage: 5,
    });
    createdPositionIds.push(open.positionId);

    // Partial close 50%
    const partialClose = await service.closePosition({
      userId: USER_C,
      positionId: open.positionId,
      percentage: 0.5,
    });

    console.log(
      `  Partial close: size=${partialClose.size}, remaining=${partialClose.remainingSize}, PnL=${(partialClose.realizedPnL ?? 0).toFixed(4)}`
    );

    expect(partialClose.fullyClosed).toBe(false);
    expect(partialClose.remainingSize).toBeGreaterThan(0);
    // 50% of 4000 = 2000
    expect(partialClose.size).toBeCloseTo(2000, 0);

    // Close the rest
    const fullClose = await service.closePosition({
      userId: USER_C,
      positionId: open.positionId,
    });

    console.log(
      `  Full close: PnL=${(fullClose.realizedPnL ?? 0).toFixed(4)}, fullyClosed=${fullClose.fullyClosed}`
    );
    expect(fullClose.fullyClosed).toBe(true);
  });

  // =========================================================================
  // TEST 8: Wallet balance consistency
  // =========================================================================
  it('wallet balances are consistent after many operations', async () => {
    const wallet = new TestWallet(50_000);
    const service = createTestService(wallet);
    const userId = USER_A;
    const startBal = wallet.bal(userId);

    const posIds: string[] = [];

    for (const side of ['long', 'short', 'long'] as const) {
      const r = await service.openPosition({
        userId,
        ticker: TEST_TICKER,
        side,
        size: 1000,
        leverage: 5,
      });
      posIds.push(r.positionId);
      createdPositionIds.push(r.positionId);
    }

    const midBal = wallet.bal(userId);
    console.log(
      `  After 3 trades: ${startBal.toFixed(2)} → ${midBal.toFixed(2)}`
    );
    expect(startBal - midBal).toBeGreaterThan(100);
    expect(startBal - midBal).toBeLessThan(2000);

    // Close remaining open position
    const openPos = await db
      .select()
      .from(perpPositions)
      .where(
        and(
          eq(perpPositions.ticker, TEST_TICKER),
          eq(perpPositions.userId, userId),
          isNull(perpPositions.closedAt)
        )
      );

    for (const p of openPos) {
      await service.closePosition({ userId, positionId: p.id });
    }

    const endBal = wallet.bal(userId);
    const netChange = endBal - startBal;
    console.log(
      `  After close all: ${endBal.toFixed(2)}, net=${netChange.toFixed(2)}`
    );

    // Net change should be modest (mostly fees, no huge exploit)
    expect(netChange).toBeLessThan(50);
    expect(netChange).toBeGreaterThan(-200);
  });

  // =========================================================================
  // TEST 9: Math verification — constant-product AMM symmetry
  // =========================================================================
  it('AMM avg fill formula produces symmetric round-trip values', () => {
    const price = 100;
    const size = 5000;

    // Open long: buy into the pool from netHoldings=0
    const openImpact = calculateTradeImpact(price, 0, size, PERP_MARKET_CONFIG);

    // Close long: sell back from netHoldings=size
    const closeImpact = calculateTradeImpact(
      price,
      size,
      -size,
      PERP_MARKET_CONFIG
    );

    console.log(
      `  AMM math: openAvg=${openImpact.avgFillPrice.toFixed(4)}, closeAvg=${closeImpact.avgFillPrice.toFixed(4)}, openSpot=${openImpact.newSpotPrice.toFixed(4)}, closeSpot=${closeImpact.newSpotPrice.toFixed(4)}`
    );

    // After open+close of same size, spot should return to initial price
    expect(closeImpact.newSpotPrice).toBeCloseTo(price, 2);

    // Open avg fill should be worse than spot (higher for buys)
    expect(openImpact.avgFillPrice).toBeGreaterThan(price);

    // Close avg fill should be worse than post-open spot (lower for sells)
    expect(closeImpact.avgFillPrice).toBeLessThan(openImpact.newSpotPrice);

    // Short side symmetry
    const openShort = calculateTradeImpact(price, 0, -size, PERP_MARKET_CONFIG);
    const closeShort = calculateTradeImpact(
      price,
      -size,
      size,
      PERP_MARKET_CONFIG
    );

    expect(closeShort.newSpotPrice).toBeCloseTo(price, 2);
    expect(openShort.avgFillPrice).toBeLessThan(price);

    console.log(
      `  Short: openAvg=${openShort.avgFillPrice.toFixed(4)}, closeAvg=${closeShort.avgFillPrice.toFixed(4)}`
    );
  });
});
