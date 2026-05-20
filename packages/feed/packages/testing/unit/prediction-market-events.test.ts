import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type {
  PredictionDbPort,
  PredictionMarketRecord,
  PredictionPositionRecord,
  PredictionServiceDeps,
  QuestionRecord,
} from '../../core/markets/prediction';
import {
  PredictionMarketService,
  PredictionPricing,
} from '../../core/markets/prediction';

describe('PredictionMarketService broadcast events', () => {
  const mockBroadcast = {
    emit: mock(
      async (_channel: string, _payload: Record<string, unknown>) => {}
    ),
  };

  const createMockMarket = (
    overrides: Partial<PredictionMarketRecord> = {}
  ): PredictionMarketRecord => ({
    id: 'market-1',
    question: 'Will BTC reach $100k?',
    yesShares: 5000,
    noShares: 5000,
    liquidity: 10000,
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000), // tomorrow
    resolved: false,
    ...overrides,
  });

  const createMockPosition = (
    overrides: Partial<PredictionPositionRecord> = {}
  ): PredictionPositionRecord => ({
    id: 'pos-1',
    userId: 'user-1',
    marketId: 'market-1',
    side: 'yes',
    shares: 100,
    avgPrice: 0.5,
    status: 'active',
    ...overrides,
  });

  let mockDb: PredictionDbPort;
  let mockWallet: PredictionServiceDeps['wallet'];
  let deps: PredictionServiceDeps;
  let service: PredictionMarketService;

  beforeEach(() => {
    mockBroadcast.emit.mockClear();

    mockDb = {
      getMarketById: mock(async () => createMockMarket()),
      getMarketsByIds: mock(async () => [createMockMarket()]),
      createMarketFromQuestion: mock(async (q: QuestionRecord) =>
        createMockMarket({ id: q.id, question: q.text })
      ),
      updateMarketState: mock(async (id, updates) => ({
        ...createMockMarket({ id }),
        ...updates,
      })),
      getPosition: mock(async () => null),
      upsertPosition: mock(async (pos) => ({
        ...pos,
        id: pos.id ?? 'new-pos-id',
      })) as PredictionDbPort['upsertPosition'],
      deletePosition: mock(async () => {}),
      listPositionsForMarket: mock(async () => []),
      insertPriceSnapshot: mock(async () => {}),
    };

    mockWallet = {
      debit: mock(async () => {}),
      credit: mock(async () => {}),
      recordPnL: mock(async () => {}),
      getBalance: mock(async () => ({ balance: 10000, lifetimePnL: 0 })),
    };

    deps = {
      db: mockDb,
      wallet: mockWallet,
      broadcast: mockBroadcast,
      fees: {
        tradingFeeRate: 0.01,
        platformShare: 0.8,
        referrerShare: 0.1,
        minFeeAmount: 0.01,
      },
    };

    service = new PredictionMarketService(deps);
  });

  test('buy() emits prediction_trade broadcast event', async () => {
    await service.buy({
      userId: 'user-1',
      marketId: 'market-1',
      side: 'yes',
      amount: 100,
    });

    expect(mockBroadcast.emit).toHaveBeenCalledTimes(1);
    const calls = mockBroadcast.emit.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [channel, payload] = calls[0]!;
    expect(channel).toBe('markets');
    expect(payload.type).toBe('prediction_trade');
    expect(payload.marketId).toBe('market-1');
    expect(payload.trade).toBeDefined();

    const trade = payload.trade as Record<string, unknown>;
    expect(trade.actorType).toBe('user');
    expect(trade.actorId).toBe('user-1');
    expect(trade.action).toBe('buy');
    expect(trade.side).toBe('yes');
  });

  test('sell() emits prediction_trade broadcast event', async () => {
    // Setup: user has exactly one position to sell (yes side only)
    mockDb.getPosition = mock(async (_userId, _marketId, side) =>
      side === 'yes' ? createMockPosition() : null
    );

    await service.sell({
      userId: 'user-1',
      marketId: 'market-1',
      shares: 50,
    });

    expect(mockBroadcast.emit).toHaveBeenCalledTimes(1);
    const calls = mockBroadcast.emit.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [channel, payload] = calls[0]!;
    expect(channel).toBe('markets');
    expect(payload.type).toBe('prediction_trade');
    expect(payload.marketId).toBe('market-1');

    const trade = payload.trade as Record<string, unknown>;
    expect(trade.action).toBe('sell');
    expect(trade.side).toBe('yes');
    expect(trade.shares).toBe(50);
  });

  test('resolve() emits prediction_resolution broadcast event', async () => {
    // Setup: market with positions
    const positions = [
      createMockPosition({ userId: 'user-1', side: 'yes', shares: 100 }),
      createMockPosition({
        id: 'pos-2',
        userId: 'user-2',
        side: 'no',
        shares: 50,
      }),
    ];
    mockDb.listPositionsForMarket = mock(async () => positions);

    await service.resolve({
      marketId: 'market-1',
      winningSide: 'yes',
      resolutionDescription: 'BTC reached $100k on Dec 14',
    });

    expect(mockBroadcast.emit).toHaveBeenCalledTimes(1);
    const calls = mockBroadcast.emit.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [channel, payload] = calls[0]!;
    expect(channel).toBe('markets');
    expect(payload.type).toBe('prediction_resolution');
    expect(payload.marketId).toBe('market-1');
    expect(payload.winningSide).toBe('yes');
    // Winner: 100 shares @ avg 0.5, loser: 50 shares @ avg 0.5
    // totalWinnerShares=100, totalLoserDeposits=50*0.5=25
    // payout = costBasis + proportion*loserDeposits = 50 + 1.0*25 = 75
    expect(payload.totalPayout).toBe(
      PredictionPricing.calculateExpectedPayout(100, 0.5, 100, 25)
    );
  });

  test('no broadcast when broadcast dep is not provided', async () => {
    const serviceWithoutBroadcast = new PredictionMarketService({
      ...deps,
      broadcast: undefined,
    });

    // Should not throw when broadcast is missing
    await serviceWithoutBroadcast.buy({
      userId: 'user-1',
      marketId: 'market-1',
      side: 'yes',
      amount: 100,
    });

    expect(mockBroadcast.emit).not.toHaveBeenCalled();
  });
});
