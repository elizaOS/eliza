import { beforeEach, describe, expect, it } from "bun:test";
import type {
  BroadcastPort,
  CachePort,
  FeeProcessor,
  WalletPort,
} from "../../shared/common";
import { PredictionMarketService } from "../PredictionMarketService";
import { PredictionPricing } from "../pricing";
import type {
  PredictionDbPort,
  PredictionMarketRecord,
  PredictionPositionRecord,
  PredictionPriceSnapshotRecord,
  PredictionSide,
} from "../types";

const feeConfig = {
  tradingFeeRate: 0.001,
  platformShare: 0.5,
  referrerShare: 0.5,
  minFeeAmount: 0.01,
};

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`${label} was not created`);
  }
  return value;
}

class InMemoryWallet implements WalletPort {
  balances = new Map<string, number>();
  pnls: Array<{ userId: string; pnl: number; reason: string }> = [];

  constructor(private defaultBalance = 10_000) {}

  async debit({
    userId,
    amount,
  }: {
    userId: string;
    amount: number;
    reason: string;
  }): Promise<void> {
    const balance = this.balances.get(userId) ?? this.defaultBalance;
    if (balance < amount) throw new Error("Insufficient funds");
    this.balances.set(userId, balance - amount);
  }

  async credit({
    userId,
    amount,
  }: {
    userId: string;
    amount: number;
    reason: string;
  }): Promise<void> {
    const balance = this.balances.get(userId) ?? this.defaultBalance;
    this.balances.set(userId, balance + amount);
  }

  async recordPnL({
    userId,
    pnl,
    reason,
  }: {
    userId: string;
    pnl: number;
    reason: string;
  }): Promise<void> {
    this.pnls.push({ userId, pnl, reason });
  }

  async getBalance(userId: string): Promise<{ balance: number }> {
    return { balance: this.balances.get(userId) ?? this.defaultBalance };
  }
}

class InMemoryDb implements PredictionDbPort {
  markets = new Map<string, PredictionMarketRecord>();
  positions = new Map<string, PredictionPositionRecord>();
  snapshots: PredictionPriceSnapshotRecord[] = [];
  idCounter = 1;

  constructor(initialMarket?: PredictionMarketRecord) {
    if (initialMarket) {
      this.markets.set(initialMarket.id, { ...initialMarket });
    }
  }

  async getMarketById(id: string): Promise<PredictionMarketRecord | null> {
    const m = this.markets.get(id);
    return m ? { ...m } : null;
  }

  async getMarketsByIds(ids: string[]): Promise<PredictionMarketRecord[]> {
    return ids
      .map((id) => this.markets.get(id))
      .filter((m): m is PredictionMarketRecord => !!m)
      .map((m) => ({ ...m }));
  }

  async listMarkets(options?: {
    limit?: number;
    offset?: number;
  }): Promise<PredictionMarketRecord[]> {
    const all = Array.from(this.markets.values())
      .filter((m) => !m.resolved)
      .sort(
        (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
      )
      .map((m) => ({ ...m }));
    if (options?.limit == null) return all;
    const off = options.offset ?? 0;
    return all.slice(off, off + options.limit);
  }

  async countUnresolvedMarkets(): Promise<number> {
    return Array.from(this.markets.values()).filter((m) => !m.resolved).length;
  }

  async listUserPositions(userId: string): Promise<PredictionPositionRecord[]> {
    return Array.from(this.positions.values())
      .filter((p) => p.userId === userId)
      .map((p) => ({ ...p }));
  }

  async createMarketFromQuestion(
    _question: unknown,
    _initialLiquidity: number,
    _options?: { description?: string | null },
  ): Promise<PredictionMarketRecord> {
    throw new Error("not used in tests");
  }

  async updateMarketState(
    marketId: string,
    updates: Partial<PredictionMarketRecord>,
  ): Promise<PredictionMarketRecord> {
    const m = this.markets.get(marketId);
    if (!m) throw new Error("market not found");
    const updated = { ...m, ...updates };
    this.markets.set(marketId, updated);
    return { ...updated };
  }

  async getPosition(
    userId: string,
    marketId: string,
    side: PredictionSide,
  ): Promise<PredictionPositionRecord | null> {
    const pos = Array.from(this.positions.values()).find(
      (p) => p.userId === userId && p.marketId === marketId && p.side === side,
    );
    return pos ? { ...pos } : null;
  }

  async upsertPosition(
    position: Omit<PredictionPositionRecord, "id"> & { id?: string },
  ): Promise<PredictionPositionRecord> {
    const id = position.id ?? `pos-${this.idCounter++}`;
    const record: PredictionPositionRecord = {
      id,
      userId: position.userId,
      marketId: position.marketId,
      side: position.side,
      shares: position.shares,
      avgPrice: position.avgPrice,
      status: position.status ?? "active",
      outcome: position.outcome ?? null,
      pnl: position.pnl,
      resolvedAt: position.resolvedAt ?? null,
      createdAt: position.createdAt ?? new Date(),
      updatedAt: position.updatedAt ?? new Date(),
    };
    this.positions.set(id, record);
    return { ...record };
  }

  async deletePosition(positionId: string): Promise<void> {
    this.positions.delete(positionId);
  }

  async listPositionsForMarket(
    marketId: string,
  ): Promise<PredictionPositionRecord[]> {
    return Array.from(this.positions.values())
      .filter((p) => p.marketId === marketId)
      .map((p) => ({ ...p }));
  }

  async insertPriceSnapshot(
    snapshot: PredictionPriceSnapshotRecord,
  ): Promise<void> {
    this.snapshots.push({ ...snapshot });
  }
}

class InMemoryBroadcast implements BroadcastPort {
  events: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  async emit(channel: string, payload: Record<string, unknown>): Promise<void> {
    this.events.push({ channel, payload });
  }
}

class InMemoryCache implements CachePort {
  keys: string[] = [];
  async invalidate(pattern: string): Promise<void> {
    this.keys.push(pattern);
  }
}

describe("PredictionMarketService", () => {
  const market: PredictionMarketRecord = {
    id: "m1",
    question: "Will it rain?",
    yesShares: 5000,
    noShares: 5000,
    liquidity: 10_000,
    endDate: new Date(Date.now() + 3600_000),
    resolved: false,
  };

  let db: InMemoryDb;
  let wallet: InMemoryWallet;
  let broadcast: InMemoryBroadcast;
  let cache: InMemoryCache;
  let feeProcessor: FeeProcessor;
  let service: PredictionMarketService;

  beforeEach(() => {
    db = new InMemoryDb(market);
    wallet = new InMemoryWallet();
    broadcast = new InMemoryBroadcast();
    cache = new InMemoryCache();
    feeProcessor = {
      processTradingFee: async () => ({ feeCharged: 0, referrerPaid: 0 }),
    };
    service = new PredictionMarketService({
      db,
      wallet,
      broadcast,
      cache,
      clock: { now: () => new Date() },
      fees: feeConfig,
      feeProcessor,
    });
  });

  it("buy should increase shares, position, liquidity and emit snapshot/event", async () => {
    const result = await service.buy({
      userId: "u1",
      marketId: "m1",
      side: "yes",
      amount: 100,
    });

    expect(result.shares).toBeGreaterThan(0);
    expect(result.market.liquidity).toBeGreaterThan(market.liquidity);
    const pos = await db.getPosition("u1", "m1", "yes");
    expect(pos?.shares).toBeCloseTo(result.shares);
    expect(db.snapshots.length).toBe(1);
    expect(broadcast.events.length).toBe(1);
    expect(cache.keys).toContain("prediction:m1:*");
  });

  it("buy should allow overriding trade attribution", async () => {
    service = new PredictionMarketService({
      db,
      wallet,
      broadcast,
      cache,
      clock: { now: () => new Date() },
      fees: feeConfig,
      feeProcessor,
      tradeSource: "npc_trade",
      tradeActorType: "npc",
    });

    await service.buy({
      userId: "u1",
      marketId: "m1",
      side: "yes",
      amount: 100,
    });

    expect(db.snapshots[0]?.source).toBe("npc_trade");

    const event = broadcast.events[0]?.payload as unknown as {
      type?: string;
      trade?: { actorType?: string; source?: string };
    };
    expect(event.type).toBe("prediction_trade");
    expect(event.trade?.actorType).toBe("npc");
    expect(event.trade?.source).toBe("npc_trade");
  });

  it("sell should decrease position, compute pnl, and close when remaining small", async () => {
    await service.buy({
      userId: "u1",
      marketId: "m1",
      side: "yes",
      amount: 100,
    });
    const pos = await db.getPosition("u1", "m1", "yes");
    expect(pos).not.toBeNull();
    const position = requireValue(pos, "yes position");
    const sellShares = position.shares * 0.9;
    const result = await service.sell({
      userId: "u1",
      marketId: "m1",
      shares: sellShares,
    });
    expect(result.netProceeds).toBeGreaterThan(0);
    expect(result.positionClosed).toBe(false);

    const result2 = await service.sell({
      userId: "u1",
      marketId: "m1",
      shares: position.shares - sellShares,
    });
    expect(result2.positionClosed).toBe(true);
    const closed = await db.getPosition("u1", "m1", "yes");
    expect(closed).not.toBeNull();
    expect(closed?.status).toBe("closed");
    expect(closed?.shares).toBe(0);
  });

  it("should ignore closed positions when selecting a position to sell", async () => {
    await service.buy({
      userId: "u1",
      marketId: "m1",
      side: "yes",
      amount: 50,
    });
    await service.buy({ userId: "u1", marketId: "m1", side: "no", amount: 50 });

    const yesPos = await db.getPosition("u1", "m1", "yes");
    const noPos = await db.getPosition("u1", "m1", "no");
    expect(yesPos).not.toBeNull();
    expect(noPos).not.toBeNull();
    const yesPosition = requireValue(yesPos, "yes position");
    const noPosition = requireValue(noPos, "no position");

    await service.sell({
      userId: "u1",
      marketId: "m1",
      positionId: yesPosition.id,
      shares: yesPosition.shares,
    });

    const sellNo = await service.sell({
      userId: "u1",
      marketId: "m1",
      shares: noPosition.shares,
    });
    expect(sellNo.positionClosed).toBe(true);
  });

  it("should require positionId when both sides exist", async () => {
    await service.buy({
      userId: "u1",
      marketId: "m1",
      side: "yes",
      amount: 50,
    });
    await service.buy({ userId: "u1", marketId: "m1", side: "no", amount: 50 });
    await expect(
      service.sell({ userId: "u1", marketId: "m1", shares: 1 }),
    ).rejects.toThrow(/Specify positionId/);
  });

  it("should block buys on resolved markets", async () => {
    await db.updateMarketState("m1", { resolved: true });
    await expect(
      service.buy({ userId: "u1", marketId: "m1", side: "yes", amount: 10 }),
    ).rejects.toThrow(/resolved/);
  });

  it("should block buys on expired markets", async () => {
    await db.updateMarketState("m1", {
      resolved: false,
      endDate: new Date(Date.now() - 1000),
    });
    await expect(
      service.buy({ userId: "u1", marketId: "m1", side: "yes", amount: 10 }),
    ).rejects.toThrow(/expired/);
  });

  it("should allow sells on expired but unresolved markets", async () => {
    // First buy a position while market is active
    await service.buy({
      userId: "u1",
      marketId: "m1",
      side: "yes",
      amount: 100,
    });
    const pos = await db.getPosition("u1", "m1", "yes");
    expect(pos).not.toBeNull();
    const position = requireValue(pos, "yes position");

    // Expire the market (but don't resolve it)
    await db.updateMarketState("m1", {
      endDate: new Date(Date.now() - 1000),
    });

    // User should still be able to close their position
    const result = await service.sell({
      userId: "u1",
      marketId: "m1",
      shares: position.shares,
    });
    expect(result.positionClosed).toBe(true);
    expect(result.netProceeds).toBeGreaterThan(0);
  });

  it("should block sells on resolved markets with outcome", async () => {
    // First buy a position
    await service.buy({
      userId: "u1",
      marketId: "m1",
      side: "yes",
      amount: 100,
    });

    // Resolve the market with an outcome (YES wins)
    await db.updateMarketState("m1", { resolved: true, resolution: true });

    await expect(
      service.sell({ userId: "u1", marketId: "m1", shares: 1 }),
    ).rejects.toThrow(/resolved/);
  });

  it("should allow sells on cancelled markets (resolved but no outcome)", async () => {
    // First buy a position
    await service.buy({
      userId: "u1",
      marketId: "m1",
      side: "yes",
      amount: 100,
    });

    // Cancel the market (resolved but no outcome)
    await db.updateMarketState("m1", { resolved: true, resolution: null });

    // Should be able to sell on cancelled market
    const result = await service.sell({
      userId: "u1",
      marketId: "m1",
      shares: 1,
    });
    expect(result.shares).toBe(1);
  });

  it("should block sells on cancelled positions (double-refund prevention)", async () => {
    // Security test: Ensure users cannot sell positions that have been refunded via cancel()
    // This prevents a double-payment exploit where user gets refund + sell proceeds

    // First buy a position
    await service.buy({
      userId: "u1",
      marketId: "m1",
      side: "yes",
      amount: 100,
    });

    const balanceBeforeCancel = (await wallet.getBalance("u1")).balance;

    // Cancel the market - this refunds the position and marks it 'cancelled'
    const cancelResult = await service.cancel({
      marketId: "m1",
      reason: "Test cancel",
    });
    expect(cancelResult.positionsRefunded).toBe(1);
    expect(cancelResult.totalRefunded).toBeGreaterThan(0);

    const balanceAfterCancel = (await wallet.getBalance("u1")).balance;
    expect(balanceAfterCancel).toBeGreaterThan(balanceBeforeCancel);

    // Verify position is now cancelled
    const pos = await db.getPosition("u1", "m1", "yes");
    expect(pos?.status).toBe("cancelled");

    // Attempt to sell the cancelled position should fail
    // This is the critical security check - without it, user could get double payment
    await expect(
      service.sell({ userId: "u1", marketId: "m1", shares: 1 }),
    ).rejects.toThrow(/not found/);
  });

  it("should prevent liquidity going negative on sell", async () => {
    // Force tiny liquidity but large reserves so proceeds exceed liquidity
    await db.updateMarketState("m1", { liquidity: 1 });
    const pos = await db.upsertPosition({
      userId: "u1",
      marketId: "m1",
      side: "yes",
      shares: 100,
      avgPrice: 0.5,
    });
    await expect(
      service.sell({ userId: "u1", marketId: "m1", shares: pos.shares }),
    ).rejects.toThrow(/liquidity/);
  });

  it("resolve should payout winners and set positions resolved", async () => {
    await service.buy({
      userId: "u1",
      marketId: "m1",
      side: "yes",
      amount: 100,
    });
    await service.buy({
      userId: "u2",
      marketId: "m1",
      side: "no",
      amount: 100,
    });

    const marketPreResolve = await service.getMarket("m1");
    expect(marketPreResolve).not.toBeNull();
    const marketBeforeResolve = requireValue(
      marketPreResolve,
      "pre-resolve market",
    );

    const preWinnerBalance = (await wallet.getBalance("u1")).balance;
    const preLoserBalance = (await wallet.getBalance("u2")).balance;
    await service.resolve({
      marketId: "m1",
      winningSide: "yes",
      resolutionDescription: "It rained",
    });
    const pos1 = await db.getPosition("u1", "m1", "yes");
    const pos2 = await db.getPosition("u2", "m1", "no");
    const winnerPosition = requireValue(pos1, "winner position");
    const loserPosition = requireValue(pos2, "loser position");
    expect(winnerPosition.status).toBe("resolved");
    expect(loserPosition.status).toBe("resolved");
    expect(winnerPosition.outcome).toBe(true);
    expect(loserPosition.outcome).toBe(false);
    const postWinnerBalance = (await wallet.getBalance("u1")).balance;
    const postLoserBalance = (await wallet.getBalance("u2")).balance;
    expect(postWinnerBalance).toBeGreaterThan(preWinnerBalance);
    expect(postLoserBalance).toBeLessThanOrEqual(preLoserBalance);

    // Pool-proportional payout: winner gets cost back + loser's deposits
    const totalWinnerShares = winnerPosition.shares;
    const totalLoserDeposits = loserPosition.shares * loserPosition.avgPrice;
    const expectedWinnerPayout = PredictionPricing.calculateExpectedPayout(
      winnerPosition.shares,
      winnerPosition.avgPrice,
      totalWinnerShares,
      totalLoserDeposits,
    );
    const expectedWinnerPnl = expectedWinnerPayout - 100;
    const expectedLoserPnl = -100;

    expect(postWinnerBalance - preWinnerBalance).toBeCloseTo(
      expectedWinnerPayout,
    );
    expect(winnerPosition.pnl).toBeCloseTo(expectedWinnerPnl);
    expect(winnerPosition.pnl).toBeGreaterThan(0);
    expect(loserPosition.pnl).toBeCloseTo(expectedLoserPnl);

    // Liquidity should decrease by total payouts (capped at available liquidity)
    const marketAfterResolve = await service.getMarket("m1");
    expect(marketAfterResolve?.resolved).toBe(true);
    const payout = expectedWinnerPayout;
    const expectedReduction = Math.min(payout, marketBeforeResolve.liquidity);
    expect(marketAfterResolve?.liquidity).toBeCloseTo(
      marketBeforeResolve.liquidity - expectedReduction,
      6,
    );

    // PnL should be recorded for both winner and loser (loser negative)
    const pnlByUser = new Map(wallet.pnls.map((p) => [p.userId, p.pnl]));
    const winnerPnl = pnlByUser.get("u1") ?? 0;
    const loserPnl = pnlByUser.get("u2") ?? 0;
    expect(winnerPnl).toBeCloseTo(expectedWinnerPnl);
    expect(loserPnl).toBeCloseTo(expectedLoserPnl);
    expect(loserPnl).toBeLessThan(0);
    expect(winnerPnl).toBeGreaterThan(0);
  });

  it("resolve with no losers returns net cost basis minus fees", async () => {
    await db.upsertPosition({
      userId: "u1",
      marketId: "m1",
      side: "yes",
      shares: 10,
      avgPrice: 999,
      status: "active",
      pnl: 0,
      outcome: null,
      resolvedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const preBalance = (await wallet.getBalance("u1")).balance;

    await service.resolve({
      marketId: "m1",
      winningSide: "yes",
      resolutionDescription: "No opposing bets — cost basis returned",
    });

    const pos = await db.getPosition("u1", "m1", "yes");
    const postBalance = (await wallet.getBalance("u1")).balance;

    expect(pos?.status).toBe("resolved");
    expect(pos?.outcome).toBe(true);
    // With no losers, payout = cost basis (net). PnL is slightly negative
    // because the entry fee is not recovered.
    const netCostBasis = 10 * 999; // 9990
    expect(postBalance - preBalance).toBeCloseTo(netCostBasis);
    expect(pos?.pnl).toBeLessThanOrEqual(0);
  });

  it("pricing getCurrentPrice returns 0.5 when total is zero for display", () => {
    expect(PredictionPricing.getCurrentPrice(0, 0, "yes")).toBe(0.5);
  });
});
