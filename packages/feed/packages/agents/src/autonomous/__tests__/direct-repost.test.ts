import { describe, expect, mock, test } from "bun:test";

const mockPost = {
  id: "post-1",
  authorId: "user-1",
  content: "",
  originalPostId: "post-0",
};

const mockDb = {
  select: mock(() => ({
    from: mock(() => ({
      where: mock(() => ({
        limit: mock(async () => [mockPost]),
      })),
    })),
  })),
  insert: mock(() => ({
    values: mock(async () => undefined),
  })),
  transaction: mock(async () => undefined),
};

const generateTagsFromPostMock = mock(async () => []);

mock.module("@feed/db", () => ({
  actorState: {},
  aliasedTable: mock(() => ({})),
  and: (...args: unknown[]) => args,
  asSystem: () => ({}),
  asUser: () => ({}),
  chatParticipants: {},
  chats: {},
  comments: {},
  db: mockDb,
  desc: (...args: unknown[]) => args,
  dmAcceptances: {},
  eq: (a: unknown, b: unknown) => ({ a, b }),
  follows: { id: "id", followerId: "followerId", followingId: "followingId" },
  groupMembers: {},
  groups: {},
  gte: (...args: unknown[]) => args,
  inArray: (...args: unknown[]) => args,
  isNull: (...args: unknown[]) => args,
  messages: {},
  perpPositions: {},
  posts: {
    id: "id",
    authorId: "authorId",
    content: "content",
    originalPostId: "originalPostId",
  },
  reactions: {},
  shares: { id: "id", postId: "postId", userId: "userId" },
  sql: {},
  users: { id: "id" },
  withTransaction: mock(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback(mockDb),
  ),
}));

mock.module("@feed/api", () => ({
  broadcastAgentActivity: mock(async () => undefined),
  broadcastChatMessage: mock(async () => undefined),
  broadcastToChannel: mock(async () => undefined),
  cachedDb: {
    invalidateUserCache: mock(async () => undefined),
  },
  notifyGroupChatMessage: async () => undefined,
}));

mock.module("@feed/core/markets/perps", () => ({
  PerpDbAdapter: class {},
  PerpMarketService: class {},
}));

mock.module("@feed/core/markets/prediction", () => ({
  PredictionDbAdapter: class {},
  PredictionMarketService: class {},
}));

mock.module("@feed/engine", () => ({
  FEE_CONFIG: {
    TRADING_FEE_RATE: 0,
    PLATFORM_SHARE: 0,
    REFERRER_SHARE: 0,
    MIN_FEE_AMOUNT: 0,
    FEE_TYPES: {},
  },
  FeeService: { processTradingFee: mock(async () => ({ feeCharged: 0 })) },
  generateTagsFromPost: generateTagsFromPostMock,
  invalidateAfterPredictionTrade: mock(async () => undefined),
  PredictionPricing: {},
  createPerpPriceImpactPort: mock(() => ({})),
  StaticDataRegistry: { getActor: mock(() => null) },
  storeTagsForPost: mock(async () => undefined),
  WalletService: class {},
}));

mock.module("../../shared/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    debug: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

mock.module("../../shared/snowflake", () => ({
  generateSnowflakeId: mock(async () => "snowflake-id"),
}));

mock.module("../../services/AgentPnLService", () => ({
  agentPnLService: { recordTrade: mock(async () => undefined) },
}));

mock.module("../TopicDiversityService", () => ({
  topicDiversityService: {
    calculateSimilarity: mock(() => 0),
    recordTopicCoverage: mock(() => undefined),
    trackPostTopics: mock(async () => undefined),
    validateContent: mock(() => []),
  },
}));

mock.module("../utils/resolvePerpTicker", () => ({
  resolvePerpTicker: mock(() => null),
}));

const { executeDirectPost, executeDirectRepost } = await import(
  "../DirectExecutors"
);
const { db: activeDb } = (await import("@feed/db")) as {
  db: typeof mockDb;
};

activeDb.select = mockDb.select;
activeDb.insert = mockDb.insert;
activeDb.transaction = mockDb.transaction;

describe("executeDirectPost", () => {
  test("persists the post even when optional tag generation fails", async () => {
    activeDb.insert = mock(() => ({
      values: mock(async () => undefined),
    })) as typeof mockDb.insert;
    generateTagsFromPostMock.mockImplementationOnce(async () => {
      throw new Error("tag quota exhausted");
    });

    const result = await executeDirectPost({
      agentUserId: "user-2",
      content: "Tariff war is the real AI killer",
    });

    expect(result.success).toBe(true);
    expect(result.postId).toBe("snowflake-id");
    expect(activeDb.insert).toHaveBeenCalled();
  });
});

describe("executeDirectRepost", () => {
  test("reposts the original when given a repost", async () => {
    const originalPost = {
      id: "post-0",
      authorId: "user-9",
      content: "Original content",
      originalPostId: null,
    };
    let selectCallCount = 0;
    activeDb.select = mock(() => ({
      from: mock(() => ({
        where: mock(() => ({
          limit: mock(async () => {
            selectCallCount += 1;
            return selectCallCount === 1 ? [mockPost] : [originalPost];
          }),
        })),
      })),
    }));

    let sharedPostId: string | undefined;
    activeDb.transaction = mock(
      async (callback: (tx: unknown) => Promise<void>) => {
        await callback({
          insert: mock(() => ({
            values: mock(async (values: { postId: string }) => {
              sharedPostId = values.postId;
            }),
          })),
        });
        return undefined;
      },
    ) as typeof mockDb.transaction;

    const result = await executeDirectRepost({
      agentUserId: "user-2",
      postId: "post-1",
      comment: undefined,
    });

    expect(result.success).toBe(true);
    expect(activeDb.transaction).toHaveBeenCalled();
    expect(sharedPostId).toBe(originalPost.id);
  });

  test("allows reposting an original post", async () => {
    // Create a mock for an original post (no originalPostId)
    const originalPost = {
      id: "post-original",
      authorId: "user-1",
      content: "Original content",
      originalPostId: null,
    };

    // Override the select mock for this test to return original post
    const mockDbSuccess = {
      select: mock(() => ({
        from: mock(() => ({
          where: mock(() => ({
            limit: mock(async () => [originalPost]),
          })),
        })),
      })),
      transaction: mock(async (callback: (tx: unknown) => Promise<void>) => {
        // Simulate successful transaction
        await callback({
          insert: mock(() => ({ values: mock(async () => undefined) })),
        });
        return undefined;
      }),
    };

    // Temporarily replace the db mock
    const originalSelect = activeDb.select;
    const originalTransaction = activeDb.transaction;
    activeDb.select = mockDbSuccess.select;
    activeDb.transaction =
      mockDbSuccess.transaction as typeof mockDb.transaction;

    try {
      const result = await executeDirectRepost({
        agentUserId: "user-2",
        postId: "post-original",
        comment: undefined,
      });

      expect(result.success).toBe(true);
      expect(mockDbSuccess.transaction).toHaveBeenCalled();
    } finally {
      // Restore original mocks
      activeDb.select = originalSelect;
      activeDb.transaction = originalTransaction;
    }
  });

  test("does not redirect quote reposts", async () => {
    const quotePost = {
      id: "post-quote",
      authorId: "user-3",
      content: "My take on this",
      originalPostId: "post-0",
    };

    activeDb.select = mock(() => ({
      from: mock(() => ({
        where: mock(() => ({
          limit: mock(async () => [quotePost]),
        })),
      })),
    }));

    let sharedPostId: string | undefined;
    activeDb.transaction = mock(
      async (callback: (tx: unknown) => Promise<void>) => {
        await callback({
          insert: mock(() => ({
            values: mock(async (values: { postId: string }) => {
              sharedPostId = values.postId;
            }),
          })),
        });
        return undefined;
      },
    ) as typeof mockDb.transaction;

    const result = await executeDirectRepost({
      agentUserId: "user-2",
      postId: "post-quote",
      comment: undefined,
    });

    expect(result.success).toBe(true);
    expect(sharedPostId).toBe(quotePost.id);
  });
});
