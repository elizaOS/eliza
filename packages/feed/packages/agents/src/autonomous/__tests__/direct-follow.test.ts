import { beforeEach, describe, expect, mock, test } from 'bun:test';

let mockTargetUser: { id: string; isActor: boolean } | null = {
  id: 'target-user',
  isActor: false,
};
let shouldCreateFollow = true;
let deleteReturningRows: Array<{ id: string }> = [{ id: 'follow-1' }];

const invalidateUserCacheMock = mock(async () => undefined);

const mockDb = {
  select: mock(() => ({
    from: mock(() => ({
      where: mock(() => ({
        limit: mock(async () => (mockTargetUser ? [mockTargetUser] : [])),
      })),
    })),
  })),
  insert: mock(() => ({
    values: mock(() => ({
      onConflictDoNothing: mock(() => ({
        returning: mock(async () =>
          shouldCreateFollow ? [{ id: 'follow-1' }] : []
        ),
      })),
    })),
  })),
  delete: mock(() => ({
    where: mock(() => ({
      returning: mock(async () => deleteReturningRows),
    })),
  })),
  transaction: mock(async () => undefined),
};

mock.module('@feed/db', () => ({
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
  groupMembers: {},
  groups: {},
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
}));

mock.module('@feed/api', () => ({
  broadcastAgentActivity: mock(async () => undefined),
  broadcastChatMessage: mock(async () => undefined),
  broadcastToChannel: mock(async () => undefined),
  cachedDb: {
    invalidateUserCache: invalidateUserCacheMock,
  },
  notifyGroupChatMessage: async () => undefined,
}));

mock.module('@feed/core/markets/perps', () => ({
  PerpDbAdapter: class {},
  PerpMarketService: class {},
}));

mock.module('@feed/core/markets/prediction', () => ({
  PredictionDbAdapter: class {},
  PredictionMarketService: class {},
}));

mock.module('@feed/engine', () => ({
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
  WalletService: class {},
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
  generateSnowflakeId: mock(async () => 'snowflake-id'),
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

const { executeDirectFollow, executeDirectUnfollow } = await import(
  '../DirectExecutors'
);

describe('executeDirectFollow / executeDirectUnfollow', () => {
  beforeEach(() => {
    mockTargetUser = { id: 'target-user', isActor: false };
    shouldCreateFollow = true;
    deleteReturningRows = [{ id: 'follow-1' }];
    invalidateUserCacheMock.mockClear();
  });

  test('follows a valid target user and invalidates caches', async () => {
    const result = await executeDirectFollow({
      agentUserId: 'agent-1',
      targetUserId: 'target-user',
    });

    expect(result.success).toBe(true);
    expect(result.followed).toBe(true);
    expect(result.alreadyFollowing).toBe(false);
    expect(invalidateUserCacheMock).toHaveBeenCalledTimes(2);
  });

  test('returns idempotent success when already following', async () => {
    shouldCreateFollow = false;

    const result = await executeDirectFollow({
      agentUserId: 'agent-1',
      targetUserId: 'target-user',
    });

    expect(result.success).toBe(true);
    expect(result.followed).toBe(false);
    expect(result.alreadyFollowing).toBe(true);
    expect(invalidateUserCacheMock).not.toHaveBeenCalled();
  });

  test('rejects FOLLOW for actor targets', async () => {
    mockTargetUser = { id: 'npc-1', isActor: true };

    const result = await executeDirectFollow({
      agentUserId: 'agent-1',
      targetUserId: 'npc-1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('users/agents only');
  });

  test('rejects FOLLOW when targetUserId is empty', async () => {
    const result = await executeDirectFollow({
      agentUserId: 'agent-1',
      targetUserId: '  ',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Target user ID is required');
  });

  test('rejects FOLLOW on self', async () => {
    const result = await executeDirectFollow({
      agentUserId: 'agent-1',
      targetUserId: 'agent-1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot follow yourself');
  });

  test('rejects FOLLOW when target user does not exist', async () => {
    mockTargetUser = null;

    const result = await executeDirectFollow({
      agentUserId: 'agent-1',
      targetUserId: 'nonexistent',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('User not found');
  });

  test('rejects UNFOLLOW on self', async () => {
    const result = await executeDirectUnfollow({
      agentUserId: 'agent-1',
      targetUserId: 'agent-1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot unfollow yourself');
  });

  test('rejects UNFOLLOW for actor targets', async () => {
    mockTargetUser = { id: 'npc-1', isActor: true };

    const result = await executeDirectUnfollow({
      agentUserId: 'agent-1',
      targetUserId: 'npc-1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('users/agents only');
  });

  test('unfollows an existing relationship and invalidates caches', async () => {
    deleteReturningRows = [{ id: 'follow-1' }];

    const result = await executeDirectUnfollow({
      agentUserId: 'agent-1',
      targetUserId: 'target-user',
    });

    expect(result.success).toBe(true);
    expect(result.unfollowed).toBe(true);
    expect(result.wasFollowing).toBe(true);
    expect(invalidateUserCacheMock).toHaveBeenCalledTimes(2);
  });

  test('unfollow is idempotent when no relationship exists', async () => {
    deleteReturningRows = [];

    const result = await executeDirectUnfollow({
      agentUserId: 'agent-1',
      targetUserId: 'target-user',
    });

    expect(result.success).toBe(true);
    expect(result.unfollowed).toBe(false);
    expect(result.wasFollowing).toBe(false);
    expect(invalidateUserCacheMock).not.toHaveBeenCalled();
  });
});
