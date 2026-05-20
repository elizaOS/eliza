import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  AGENT_TRANSFER_IN_TRANSACTION_TYPE,
  AGENT_TRANSFER_OUT_TRANSACTION_TYPE,
} from '@babylon/shared';

let mockRecipientUser: { id: string } | null = { id: 'user-2' };
let mockSenderBalance = 1000;
let lastDebitCall: {
  userId: string;
  amount: number;
  type: string;
  description: string;
  relatedId?: string;
} | null = null;
let lastCreditCall: {
  userId: string;
  amount: number;
  type: string;
  description: string;
  relatedId?: string;
} | null = null;
let debitShouldFail = false;
let routeTransferResult: {
  success: true;
  transferId: string;
  amount: number;
  senderUserId: string;
  recipientUserId: string;
  senderBalanceBefore: number;
  senderBalanceAfter: number;
  recipientBalanceBefore: number;
  recipientBalanceAfter: number;
} = {
  success: true,
  transferId: 'transfer-1',
  amount: 25,
  senderUserId: 'sender-1',
  recipientUserId: 'receiver-1',
  senderBalanceBefore: 100,
  senderBalanceAfter: 75,
  recipientBalanceBefore: 5,
  recipientBalanceAfter: 30,
};
let routeRateLimitResult = { allowed: true, retryAfter: 60 };

const invalidateUserCacheMock = mock(async () => undefined);
const routeAuthenticateMock = mock(async () => ({
  userId: 'sender-1',
  dbUserId: 'sender-1',
}));
const routeCheckRateLimitAsyncMock = mock(
  async () =>
    (globalThis as Record<string, unknown>).__routeRateLimitResult ??
    routeRateLimitResult
);
const routeTransferMock = mock(
  async () =>
    (globalThis as Record<string, unknown>).__routeTransferResult ??
    routeTransferResult
);

const mockDb = {
  // The only DB query executeDirectSendMoney makes is to check if recipient exists
  select: mock(() => ({
    from: mock(() => ({
      where: mock(() => ({
        limit: mock(async () => (mockRecipientUser ? [mockRecipientUser] : [])),
      })),
    })),
  })),
  insert: mock(() => ({
    values: mock(() => ({
      onConflictDoNothing: mock(() => ({
        returning: mock(async () => []),
      })),
    })),
  })),
  delete: mock(() => ({
    where: mock(() => ({
      returning: mock(async () => []),
    })),
  })),
  update: mock(() => ({
    set: mock(() => ({
      where: mock(async () => []),
    })),
  })),
  transaction: mock(async () => undefined),
};

mock.module('@babylon/db', () => ({
  actorState: {},
  aliasedTable: mock(() => ({})),
  and: (...args: unknown[]) => args,
  asSystem: () => ({}),
  asUser: () => ({}),
  chatParticipants: {},
  chats: {},
  comments: {},
  db: mockDb,
  dmAcceptances: {},
  eq: (a: unknown, b: unknown) => ({ a, b }),
  follows: { id: 'id', followerId: 'followerId', followingId: 'followingId' },
  groupMembers: { role: 'role' },
  groups: { id: 'id' },
  gte: (...args: unknown[]) => args,
  isNull: (...args: unknown[]) => args,
  messages: {},
  perpPositions: {},
  posts: {
    id: 'id',
    authorId: 'authorId',
    content: 'content',
    originalPostId: 'originalPostId',
  },
  reactions: {},
  shares: { id: 'id', postId: 'postId', userId: 'userId' },
  sql: {},
  users: { id: 'id', isActor: 'isActor', displayName: 'displayName' },
  // withTransaction executes the callback immediately (no real DB)
  withTransaction: mock(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(mockDb)
  ),
}));

mock.module('@babylon/api', () => ({
  authenticate: routeAuthenticateMock,
  BusinessLogicError: class BusinessLogicError extends Error {
    code: string;

    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  },
  broadcastAgentActivity: mock(async () => undefined),
  broadcastChatMessage: mock(async () => undefined),
  broadcastToChannel: mock(async () => undefined),
  cachedDb: {
    invalidateUserCache: invalidateUserCacheMock,
  },
  checkRateLimitAsync: routeCheckRateLimitAsyncMock,
  logger: { info: mock(() => undefined) },
  notifyGroupChatMessage: async () => undefined,
  RATE_LIMIT_CONFIGS: {
    A2A_TRANSFER_OPS: {
      maxRequests: 10,
      windowMs: 60000,
      actionType: 'a2a_transfer_ops',
    },
  },
  rateLimitError: (retryAfter?: number) =>
    Response.json({ error: 'Too many requests', retryAfter }, { status: 429 }),
  successResponse: (body: unknown) => Response.json(body),
  TradingBalanceTransferService: {
    transfer: routeTransferMock,
  },
  withErrorHandling: (handler: (...args: unknown[]) => unknown) => handler,
}));

mock.module('@babylon/core/markets/perps', () => ({
  PerpDbAdapter: class {},
  PerpMarketService: class {},
}));

mock.module('@babylon/core/markets/prediction', () => ({
  PredictionDbAdapter: class {},
  PredictionMarketService: class {},
}));

mock.module('@babylon/engine', () => ({
  FEE_CONFIG: {
    TRADING_FEE_RATE: 0,
    PLATFORM_SHARE: 0,
    REFERRER_SHARE: 0,
    MIN_FEE_AMOUNT: 0,
    FEE_TYPES: {},
  },
  FeeService: { processTradingFee: mock(async () => ({ feeCharged: 0 })) },
  generateTagsFromPost: mock(async () => []),
  invalidateAfterPredictionTrade: mock(async () => undefined),
  PredictionPricing: {},
  createPerpPriceImpactPort: mock(() => ({})),
  StaticDataRegistry: { getActor: mock(() => null) },
  storeTagsForPost: mock(async () => undefined),
  WalletService: {
    debit: mock(
      async (
        userId: string,
        amount: number,
        type: string,
        description: string,
        relatedId?: string,
        _tx?: unknown
      ) => {
        if (debitShouldFail) {
          throw new Error('Insufficient balance');
        }
        lastDebitCall = { userId, amount, type, description, relatedId };
        mockSenderBalance -= amount;
      }
    ),
    credit: mock(
      async (
        userId: string,
        amount: number,
        type: string,
        description: string,
        relatedId?: string,
        _tx?: unknown
      ) => {
        lastCreditCall = { userId, amount, type, description, relatedId };
      }
    ),
    getBalance: mock(async () => ({
      balance: mockSenderBalance,
      totalDeposited: 0,
      totalWithdrawn: 0,
      lifetimePnL: 0,
    })),
  },
}));

mock.module('../../shared/logger', () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    debug: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

mock.module('../../shared/snowflake', () => ({
  generateSnowflakeId: mock(async () => 'snowflake-tx-id'),
}));

mock.module('../../services/AgentPnLService', () => ({
  agentPnLService: { recordTrade: mock(async () => undefined) },
}));

mock.module('../TopicDiversityService', () => ({
  topicDiversityService: { trackPostTopics: mock(async () => undefined) },
}));

mock.module('../utils/resolvePerpTicker', () => ({
  resolvePerpTicker: mock(() => null),
}));

const { executeDirectSendMoney } = await import('../DirectExecutors');

describe('executeDirectSendMoney', () => {
  beforeEach(() => {
    mockRecipientUser = { id: 'user-2' };
    mockSenderBalance = 1000;
    lastDebitCall = null;
    lastCreditCall = null;
    debitShouldFail = false;
    routeTransferResult = {
      success: true,
      transferId: 'transfer-1',
      amount: 25,
      senderUserId: 'sender-1',
      recipientUserId: 'receiver-1',
      senderBalanceBefore: 100,
      senderBalanceAfter: 75,
      recipientBalanceBefore: 5,
      recipientBalanceAfter: 30,
    };
    routeRateLimitResult = { allowed: true, retryAfter: 60 };
    delete (globalThis as Record<string, unknown>).__routeTransferResult;
    delete (globalThis as Record<string, unknown>).__routeRateLimitResult;
  });

  test('sends money successfully and returns updated balance', async () => {
    const result = await executeDirectSendMoney({
      agentUserId: 'agent-1',
      recipientId: 'user-2',
      amount: 100,
      reason: 'payment for services',
    });

    expect(result.success).toBe(true);
    expect(result.transactionId).toBe('snowflake-tx-id');
    expect(result.newBalance).toBe(900);
    expect(lastDebitCall).toBeDefined();
    expect(lastDebitCall!.userId).toBe('agent-1');
    expect(lastDebitCall!.amount).toBe(100);
    expect(lastDebitCall!.type).toBe(AGENT_TRANSFER_OUT_TRANSACTION_TYPE);
    expect(lastCreditCall).toBeDefined();
    expect(lastCreditCall!.userId).toBe('user-2');
    expect(lastCreditCall!.amount).toBe(100);
    expect(lastCreditCall!.type).toBe(AGENT_TRANSFER_IN_TRANSACTION_TYPE);
  });

  test('links debit and credit with same transactionId', async () => {
    await executeDirectSendMoney({
      agentUserId: 'agent-1',
      recipientId: 'user-2',
      amount: 50,
    });

    expect(lastDebitCall!.relatedId).toBe('snowflake-tx-id');
    expect(lastCreditCall!.relatedId).toBe('snowflake-tx-id');
  });

  test('includes reason in transaction descriptions', async () => {
    await executeDirectSendMoney({
      agentUserId: 'agent-1',
      recipientId: 'user-2',
      amount: 50,
      reason: 'bet payment',
    });

    expect(lastDebitCall!.description).toContain('bet payment');
    expect(lastCreditCall!.description).toContain('bet payment');
  });

  test('caps transfer at 50% of balance', async () => {
    mockSenderBalance = 1000;

    const result = await executeDirectSendMoney({
      agentUserId: 'agent-1',
      recipientId: 'user-2',
      amount: 800, // > 50% of 1000
    });

    expect(result.success).toBe(true);
    // Should be capped to 500 (50% of 1000)
    expect(lastDebitCall!.amount).toBe(500);
    expect(lastCreditCall!.amount).toBe(500);
  });

  test('allows transfer at exactly 50% of balance', async () => {
    mockSenderBalance = 1000;

    const result = await executeDirectSendMoney({
      agentUserId: 'agent-1',
      recipientId: 'user-2',
      amount: 500,
    });

    expect(result.success).toBe(true);
    expect(lastDebitCall!.amount).toBe(500);
  });

  test('rejects self-transfer', async () => {
    const result = await executeDirectSendMoney({
      agentUserId: 'agent-1',
      recipientId: 'agent-1',
      amount: 100,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot send money to yourself');
    expect(lastDebitCall).toBeNull();
  });

  test('rejects zero amount', async () => {
    const result = await executeDirectSendMoney({
      agentUserId: 'agent-1',
      recipientId: 'user-2',
      amount: 0,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('positive number');
    expect(lastDebitCall).toBeNull();
  });

  test('rejects negative amount', async () => {
    const result = await executeDirectSendMoney({
      agentUserId: 'agent-1',
      recipientId: 'user-2',
      amount: -50,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('positive number');
  });

  test('rejects NaN amount', async () => {
    const result = await executeDirectSendMoney({
      agentUserId: 'agent-1',
      recipientId: 'user-2',
      amount: Number.NaN,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('positive number');
  });

  test('rejects empty recipientId', async () => {
    const result = await executeDirectSendMoney({
      agentUserId: 'agent-1',
      recipientId: '  ',
      amount: 100,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Recipient ID is required');
  });

  test('rejects nonexistent recipient', async () => {
    mockRecipientUser = null;

    const result = await executeDirectSendMoney({
      agentUserId: 'agent-1',
      recipientId: 'nonexistent',
      amount: 100,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('rejects when sender has zero balance', async () => {
    mockSenderBalance = 0;

    const result = await executeDirectSendMoney({
      agentUserId: 'agent-1',
      recipientId: 'user-2',
      amount: 100,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Insufficient balance');
  });

  test('rejects when debit fails (insufficient funds)', async () => {
    debitShouldFail = true;

    const result = await executeDirectSendMoney({
      agentUserId: 'agent-1',
      recipientId: 'user-2',
      amount: 100,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Insufficient balance');
  });

  test('sends without reason (optional parameter)', async () => {
    const result = await executeDirectSendMoney({
      agentUserId: 'agent-1',
      recipientId: 'user-2',
      amount: 25,
    });

    expect(result.success).toBe(true);
    expect(lastDebitCall!.description).not.toContain('undefined');
  });
});
