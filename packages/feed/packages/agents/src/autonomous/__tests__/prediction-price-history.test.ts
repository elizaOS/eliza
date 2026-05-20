import { beforeEach, describe, expect, mock, test } from 'bun:test';

const actorState = {
  id: 'id',
  tradingBalance: 'tradingBalance',
};

const agentLogs = { table: 'AgentLog' };
const agentTrades = { table: 'AgentTrade' };
const markets = { table: 'Market', id: 'id', question: 'question' };
const positions = {
  table: 'Position',
  id: 'id',
  userId: 'userId',
  marketId: 'marketId',
  side: 'side',
  status: 'status',
  shares: 'shares',
  avgPrice: 'avgPrice',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
};
const predictionPriceHistories = { table: 'PredictionPriceHistory' };
const questions = {
  table: 'Question',
  id: 'id',
  questionNumber: 'questionNumber',
};
const users = { table: 'User', id: 'id', displayName: 'displayName' };

const baseMarketRow = {
  id: 'm1',
  question: 'Will something happen?',
  description: null,
  yesShares: '100',
  noShares: '100',
  liquidity: '10000',
  endDate: new Date(Date.now() + 60 * 60 * 1000),
  resolved: false,
  resolution: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const marketRow = { ...baseMarketRow };

const userRow = { displayName: 'Test Agent' };

type PositionRow = {
  id: string;
  userId: string;
  marketId: string;
  side: boolean;
  shares: number;
  avgPrice: number;
  status: string;
  outcome: null;
  pnl: number;
  resolvedAt: null;
  createdAt: Date;
  updatedAt: Date;
  amount: number;
  questionId: null;
};

const basePositionRow: PositionRow = {
  id: 'pos1',
  userId: 'agent1',
  marketId: marketRow.id,
  side: true,
  shares: 10,
  avgPrice: 0.5,
  status: 'active',
  outcome: null,
  pnl: 0,
  resolvedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  amount: 5,
  questionId: null,
};

let positionRow: PositionRow | null = null;

const insertedPredictionHistory: Array<Record<string, unknown>> = [];
const broadcastedMarketsEvents: Array<Record<string, unknown>> = [];

const walletGetBalance = mock(async () => ({ balance: 10000 }));

const mockTxDb = {
  select: mock(() => ({
    from: mock((table: unknown) => ({
      where: mock(() => ({
        limit: mock(async () => {
          if (table === markets) return [marketRow];
          if (table === positions) return positionRow ? [positionRow] : [];
          return [];
        }),
        orderBy: mock(() => ({
          limit: mock(async () => {
            if (table === positions) return positionRow ? [positionRow] : [];
            return [];
          }),
        })),
      })),
    })),
  })),
  update: mock((table: unknown) => ({
    set: mock((updates: Record<string, unknown>) => ({
      where: mock(() => ({
        returning: mock(async () => {
          if (table === markets) {
            Object.assign(marketRow, updates, { updatedAt: new Date() });
            return [marketRow];
          }
          return [];
        }),
      })),
    })),
  })),
  insert: mock((table: unknown) => ({
    values: mock((values: Record<string, unknown>) => {
      if (table === predictionPriceHistories) {
        insertedPredictionHistory.push(values);
        return Promise.resolve([]);
      }

      if (table === markets) {
        return {
          onConflictDoNothing: () => ({
            returning: async () => [],
          }),
        };
      }

      if (table === positions) {
        return {
          onConflictDoUpdate: () => ({
            returning: async () => [values],
          }),
        };
      }

      return Promise.resolve([]);
    }),
  })),
  delete: mock(() => ({
    where: mock(async () => []),
  })),
};

const mockDb = {
  select: mock(() => ({
    from: mock((table: unknown) => ({
      where: mock(() => ({
        limit: mock(async () => {
          if (table === users) return [userRow];
          if (table === markets) return [marketRow];
          return [];
        }),
      })),
    })),
  })),
};

mock.module('@babylon/api', () => ({
  broadcastAgentActivity: mock(async () => undefined),
  broadcastChatMessage: mock(async () => undefined),
  broadcastToChannel: mock(
    async (_channel: string, payload: Record<string, unknown>) => {
      broadcastedMarketsEvents.push(payload);
    }
  ),
  cachedDb: {
    invalidateUserCache: mock(async () => undefined),
  },
}));

mock.module('@babylon/core/markets/perps', () => ({
  PerpDbAdapter: class {},
  PerpMarketService: class {},
}));

mock.module('@babylon/engine', () => ({
  FEE_CONFIG: {
    TRADING_FEE_RATE: 0.001,
    PLATFORM_SHARE: 0.5,
    REFERRER_SHARE: 0.5,
    MIN_FEE_AMOUNT: 0.01,
    FEE_TYPES: {
      pred_buy: 'pred_buy',
      pred_sell: 'pred_sell',
      perp_open: 'perp_open',
      perp_close: 'perp_close',
    },
  },
  FeeService: {
    processTradingFee: mock(async () => ({ feeCharged: 0, referrerPaid: 0 })),
  },
  invalidateAfterPredictionTrade: mock(async () => undefined),
  PredictionPricing: {
    getCurrentPrice: mock(() => 0.5),
    calculateExpectedPayout: mock(
      (shares: number, avgPrice: number) => shares * (1 + avgPrice)
    ),
    calculateBuy: mock(() => ({
      shares: 10,
      totalCost: 5,
      newYesShares: 110,
      newNoShares: 100,
    })),
    calculateSell: mock(() => ({
      shares: 10,
      totalCost: 5,
      newYesShares: 90,
      newNoShares: 100,
    })),
    calculateBuyWithFees: mock(() => ({
      shares: 10,
      totalCost: 9.99,
      newYesShares: 110,
      newNoShares: 100,
      fee: 0.01,
      netAmount: 9.99,
      totalWithFee: 10,
    })),
    calculateSellWithFees: mock(() => ({
      shares: 10,
      totalCost: 5,
      newYesShares: 90,
      newNoShares: 100,
      fee: 0.005,
      netAmount: 4.995,
      totalWithFee: 5,
    })),
  },
  createPerpPriceImpactPort: mock(() => ({})),
  StaticDataRegistry: {
    getActor: () => null,
    getAllOrganizations: () => [],
  },
  WalletService: {
    getBalance: walletGetBalance,
    debit: mock(async () => undefined),
    credit: mock(async () => undefined),
    recordPnL: mock(async () => undefined),
  },
  generateTagsFromPost: mock(async () => []),
  storeTagsForPost: mock(async () => undefined),
}));

mock.module('@babylon/db', () => ({
  actorState,
  agentLogs,
  agentTrades,
  aliasedTable: (table: unknown) => table,
  and: (...args: unknown[]) => args,
  asSystem: async (
    operation: (database: typeof mockTxDb) => Promise<unknown>
  ) => operation(mockTxDb),
  asUser: async (
    _user: { userId: string },
    operation: (database: typeof mockTxDb) => Promise<unknown>
  ) => operation(mockTxDb),
  chatParticipants: {},
  chats: {},
  comments: {},
  db: mockDb,
  dmAcceptances: {},
  eq: (a: unknown, b: unknown) => ({ a, b }),
  follows: { id: 'id', followerId: 'followerId', followingId: 'followingId' },
  groupMembers: {},
  groups: {},
  gte: (a: unknown, b: unknown) => ({ a, b }),
  isNull: (a: unknown) => ({ a }),
  markets,
  messages: {},
  perpPositions: {},
  positions,
  posts: {},
  predictionPriceHistories,
  questions,
  reactions: {},
  shares: {},
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  }),
  users,
  withTransaction: async (
    operation: (database: typeof mockTxDb) => Promise<unknown>
  ) => operation(mockTxDb),
  desc: (a: unknown) => a,
}));

// Import after mocks are set up
import { executeDirectTrade } from '../DirectExecutors';

describe('DirectExecutors prediction history pipeline', () => {
  beforeEach(() => {
    insertedPredictionHistory.length = 0;
    broadcastedMarketsEvents.length = 0;
    Object.assign(marketRow, baseMarketRow);
    positionRow = null;
    walletGetBalance.mockImplementation(async () => ({ balance: 10000 }));
  });

  test('records PredictionPriceHistory + broadcasts for agent prediction buys', async () => {
    const result = await executeDirectTrade({
      agentUserId: 'agent1',
      marketType: 'prediction',
      marketId: marketRow.id,
      side: 'buy_yes',
      amount: 10,
      reasoning: 'test',
    });

    expect(result.success).toBe(true);
    expect(insertedPredictionHistory).toHaveLength(1);

    const snapshot = insertedPredictionHistory[0]!;
    expect(snapshot.marketId).toBe(marketRow.id);
    expect(snapshot.eventType).toBe('trade');

    expect(
      broadcastedMarketsEvents.some((e) => e.type === 'prediction_trade')
    ).toBe(true);
  });

  test('allows sell_yes exits with zero balance', async () => {
    positionRow = { ...basePositionRow, side: true };
    walletGetBalance.mockImplementationOnce(async () => ({ balance: 0 }));

    const result = await executeDirectTrade({
      agentUserId: 'agent1',
      marketType: 'prediction',
      marketId: marketRow.id,
      side: 'sell_yes',
      amount: 0,
      reasoning: 'exit',
    });

    expect(result.success).toBe(true);
  });

  test('allows sell_no exits with zero balance', async () => {
    positionRow = { ...basePositionRow, side: false };
    walletGetBalance.mockImplementationOnce(async () => ({ balance: 0 }));

    const result = await executeDirectTrade({
      agentUserId: 'agent1',
      marketType: 'prediction',
      marketId: marketRow.id,
      side: 'sell_no',
      amount: 0,
      reasoning: 'exit',
    });

    expect(result.success).toBe(true);
  });

  test('blocks entry trades with zero balance', async () => {
    walletGetBalance.mockImplementationOnce(async () => ({ balance: 0 }));

    const result = await executeDirectTrade({
      agentUserId: 'agent1',
      marketType: 'prediction',
      marketId: marketRow.id,
      side: 'buy_yes',
      amount: 10,
      reasoning: 'entry',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Insufficient balance');
  });

  test('rejects non-finite trade amounts', async () => {
    const result = await executeDirectTrade({
      agentUserId: 'agent1',
      marketType: 'prediction',
      marketId: marketRow.id,
      side: 'buy_yes',
      amount: Number.NaN,
      reasoning: 'invalid',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid trade amount');
  });

  test('rejects invalid runtime trade sides instead of coercing them', async () => {
    const result = await executeDirectTrade({
      agentUserId: 'agent1',
      marketType: 'prediction',
      marketId: marketRow.id,
      side: 'none' as never,
      amount: 10,
      reasoning: 'invalid-side',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid prediction trade side');
  });
});
