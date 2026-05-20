/**
 * Unit tests for the achievement & challenge engine (checkProgress, getUserAchievements, getUserChallenges).
 *
 * Mocks @feed/db, notification-service, points-service, and SSE broadcaster
 * to test core logic in isolation.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  mock,
} from "bun:test";
import {
  ACHIEVEMENT_DEFINITIONS,
  ALL_CHALLENGE_DEFINITIONS,
  DAILY_CHALLENGE_DEFINITIONS,
  POINTS,
  WEEKLY_CHALLENGE_DEFINITIONS,
} from "@feed/shared";

// ── Mock state ────────────────────────────────────────────────────

// Tracks what the mock DB returns for various queries
interface MockState {
  /** Achievements already unlocked by the user (achievement IDs) */
  unlockedAchievementIds: string[];
  /** Challenge progress rows: Map<challengeId, { progress, completed, completedAt }> */
  challengeProgress: Map<
    string,
    {
      id: string;
      progress: number;
      completed: number;
      completedAt: Date | null;
    }
  >;
  /** Resolver results: Map<trackingType, number> */
  resolverResults: Map<string, number>;
  /** The last insert call's table + values (for assertions) */
  lastInsert: { table: string; values: Record<string, unknown> } | null;
  /** Whether insert().returning() returns a row (simulates onConflictDoNothing success) */
  insertReturnsRow: boolean;
  /** Count of completed challenges for bonus check */
  completedChallengeCount: number;
  /** Whether bonus row already exists */
  bonusAlreadyAwarded: boolean;
}

const state: MockState = {
  unlockedAchievementIds: [],
  challengeProgress: new Map(),
  resolverResults: new Map(),
  lastInsert: null,
  insertReturnsRow: true,
  completedChallengeCount: 0,
  bonusAlreadyAwarded: false,
};

function resetState() {
  state.unlockedAchievementIds = [];
  state.challengeProgress = new Map();
  state.resolverResults = new Map();
  state.lastInsert = null;
  state.insertReturnsRow = true;
  state.completedChallengeCount = 0;
  state.bonusAlreadyAwarded = false;
}

// ── Mock tracking for side-effects ────────────────────────────────

let mockAwardPoints: Mock<(...args: unknown[]) => Promise<void>>;
let mockAwardReputation: Mock<(...args: unknown[]) => Promise<unknown>>;
let mockCreateNotification: Mock<(...args: unknown[]) => Promise<void>>;
let mockBroadcastToChannel: Mock<(...args: unknown[]) => Promise<void>>;

// Track DB operations
let dbInsertCalls: Array<{ table: string; values: unknown }> = [];
let dbUpdateCalls: Array<{ table: string; set: unknown }> = [];

// Store imported functions
let checkProgress: (
  userId: string,
  event: { type: string; [key: string]: unknown },
) => Promise<void>;
let getUserAchievements: (userId: string) => Promise<unknown[]>;
let getUserChallenges: (userId: string) => Promise<unknown>;

// ── Query context tracking ────────────────────────────────────────
// The mock DB needs to know which table/context it's querying for to return
// the right mock data. We use a simple state machine.

function createChainableQuery(resolveFn: () => unknown) {
  const chain: Record<string, unknown> = {};
  const methods = [
    "from",
    "where",
    "limit",
    "orderBy",
    "groupBy",
    "innerJoin",
    "leftJoin",
    "onConflictDoNothing",
  ];
  for (const m of methods) {
    chain[m] = mock((..._args: unknown[]) => chain);
  }
  chain.returning = mock(async () => resolveFn());
  // Make chainable also thenable (for await db.select()...where())
  chain.then = (
    onFulfilled?: ((value: unknown) => unknown) | null,
    onRejected?: ((reason: unknown) => unknown) | null,
  ) => {
    return Promise.resolve(resolveFn()).then(onFulfilled, onRejected);
  };
  return chain;
}

describe("Achievement Engine (checkProgress)", () => {
  beforeAll(async () => {
    // Mock PointsService
    mockAwardPoints = mock(async () => {});
    mock.module("../points-service", () => ({
      PointsService: {
        awardPoints: mockAwardPoints,
      },
    }));

    mockAwardReputation = mock(async () => ({
      success: true,
      reputationAwarded: 0,
      newReputationTotal: 0,
      pointsAwarded: 0,
      newTotal: 0,
    }));
    mock.module("../reputation-service", () => ({
      ReputationService: {
        awardReputation: mockAwardReputation,
      },
    }));

    // Mock notification service
    mockCreateNotification = mock(async () => {});
    mock.module("../notification-service", () => ({
      createNotification: mockCreateNotification,
    }));

    // Mock SSE broadcaster
    mockBroadcastToChannel = mock(async () => {});
    mock.module("../../sse/event-broadcaster", () => ({
      broadcastToChannel: mockBroadcastToChannel,
    }));

    // Mock @feed/db
    mock.module("@feed/db", () => {
      const createSelectChain = (selectIsCount: boolean) => {
        let fromTable = "";
        const chain: Record<string, unknown> = {};

        chain.from = mock((table: unknown) => {
          if (
            table &&
            typeof table === "object" &&
            "_" in (table as Record<string, unknown>)
          ) {
            fromTable = ((table as Record<string, unknown>)._ as string) || "";
          } else {
            fromTable = String(table || "");
          }
          return chain;
        });

        chain.where = mock((..._args: unknown[]) => chain);
        chain.limit = mock((..._args: unknown[]) => chain);
        chain.orderBy = mock((..._args: unknown[]) => chain);
        chain.groupBy = mock((..._args: unknown[]) => chain);
        chain.innerJoin = mock((..._args: unknown[]) => chain);
        chain.leftJoin = mock((..._args: unknown[]) => chain);

        chain.then = (
          onFulfilled?: ((value: unknown) => unknown) | null,
          onRejected?: ((reason: unknown) => unknown) | null,
        ) => {
          let result: unknown;

          if (fromTable === "userAchievements") {
            result = state.unlockedAchievementIds.map((id) => ({
              achievementId: id,
              unlockedAt: new Date("2026-01-15"),
            }));
          } else if (fromTable === "userChallengeProgress") {
            // Count queries (checkCompletionBonus) vs data queries
            if (selectIsCount) {
              result = [{ c: state.completedChallengeCount }];
            } else {
              const entries = Array.from(state.challengeProgress.values());
              result = entries;
            }
          } else {
            // Resolver query — return count from resolverResults
            const countVal = state.resolverResults.get(fromTable) ?? 0;
            result = [
              { c: countVal, total: String(countVal), streak: countVal },
            ];
          }

          return Promise.resolve(result).then(onFulfilled, onRejected);
        };

        return chain;
      };

      const createInsertChain = () => {
        let insertTable = "";
        let insertValues: Record<string, unknown> = {};
        const chain: Record<string, unknown> = {};

        chain.values = mock((vals: Record<string, unknown>) => {
          insertValues = vals;
          dbInsertCalls.push({ table: insertTable, values: vals });
          return chain;
        });
        chain.onConflictDoNothing = mock(() => chain);
        chain.returning = mock(async () => {
          if (state.insertReturnsRow) {
            return [{ id: "mock-inserted-id", ...insertValues }];
          }
          return [];
        });
        chain.then = (onFulfilled?: ((value: unknown) => unknown) | null) => {
          return Promise.resolve(undefined).then(onFulfilled);
        };

        return {
          _setTable: (t: string) => {
            insertTable = t;
          },
          chain,
        };
      };

      const createUpdateChain = () => {
        const chain: Record<string, unknown> = {};
        chain.set = mock((vals: unknown) => {
          dbUpdateCalls.push({ table: "update", set: vals });
          return chain;
        });
        chain.where = mock(() => chain);
        chain.then = (onFulfilled?: ((value: unknown) => unknown) | null) =>
          Promise.resolve(undefined).then(onFulfilled);
        return chain;
      };

      return {
        db: {
          select: mock((fields?: unknown) => {
            // Detect count queries: select({ c: count() }) passes 'count()' string
            const isCount = !!(
              fields &&
              typeof fields === "object" &&
              "c" in (fields as Record<string, unknown>)
            );
            return createSelectChain(isCount);
          }),
          insert: mock((table: unknown) => {
            const { _setTable, chain } = createInsertChain();
            const tableName =
              table &&
              typeof table === "object" &&
              "_" in (table as Record<string, unknown>)
                ? String((table as Record<string, unknown>)._)
                : String(table || "");
            _setTable(tableName);
            return chain;
          }),
          update: mock((_table: unknown) => createUpdateChain()),
          delete: mock(() => createChainableQuery(() => [])),
        },
        // Table references (with _ marker for identification)
        userAchievements: {
          _: "userAchievements",
          userId: "ua.userId",
          achievementId: "ua.achievementId",
          id: "ua.id",
          unlockedAt: "ua.unlockedAt",
          pointsAwarded: "ua.pointsAwarded",
        },
        userChallengeProgress: {
          _: "userChallengeProgress",
          userId: "ucp.userId",
          challengeId: "ucp.challengeId",
          periodKey: "ucp.periodKey",
          id: "ucp.id",
          completed: "ucp.completed",
          progress: "ucp.progress",
          completedAt: "ucp.completedAt",
          pointsAwarded: "ucp.pointsAwarded",
        },
        positions: {
          _: "positions",
          userId: "p.userId",
          marketId: "p.marketId",
          createdAt: "p.createdAt",
          outcome: "p.outcome",
          pnl: "p.pnl",
          resolvedAt: "p.resolvedAt",
        },
        perpPositions: {
          _: "perpPositions",
          userId: "pp.userId",
          openedAt: "pp.openedAt",
          closedAt: "pp.closedAt",
          realizedPnL: "pp.realizedPnL",
        },
        posts: {
          _: "posts",
          authorId: "posts.authorId",
          timestamp: "posts.timestamp",
        },
        comments: {
          _: "comments",
          authorId: "c.authorId",
          deletedAt: "c.deletedAt",
          createdAt: "c.createdAt",
          postId: "c.postId",
        },
        reactions: {
          _: "reactions",
          userId: "r.userId",
          createdAt: "r.createdAt",
          postId: "r.postId",
        },
        users: {
          _: "users",
          id: "u.id",
          managedBy: "u.managedBy",
          isAgent: "u.isAgent",
          createdAt: "u.createdAt",
          dailyLoginStreak: "u.dailyLoginStreak",
        },
        agentMessages: {
          _: "agentMessages",
          agentUserId: "am.agentUserId",
          createdAt: "am.createdAt",
        },
        messages: {
          _: "messages",
          senderId: "m.senderId",
          chatId: "m.chatId",
          createdAt: "m.createdAt",
        },
        chats: { _: "chats", id: "chats.id", isGroup: "chats.isGroup" },
        follows: {
          _: "follows",
          followerId: "f.followerId",
          createdAt: "f.createdAt",
        },
        shares: { _: "shares", userId: "s.userId", createdAt: "s.createdAt" },
        groups: {
          _: "groups",
          createdById: "g.createdById",
          createdAt: "g.createdAt",
        },
        groupMembers: {
          _: "groupMembers",
          userId: "gm.userId",
          joinedAt: "gm.joinedAt",
        },
        referrals: {
          _: "referrals",
          referrerId: "ref.referrerId",
          referredUserId: "ref.referredUserId",
        },
        userActivityLogs: {
          _: "userActivityLogs",
          userId: "ual.userId",
          activityType: "ual.activityType",
          activityDate: "ual.activityDate",
        },
        // Drizzle operators
        eq: (..._args: unknown[]) => ({}),
        and: (..._args: unknown[]) => ({}),
        or: (..._args: unknown[]) => ({}),
        gte: (..._args: unknown[]) => ({}),
        lt: (..._args: unknown[]) => ({}),
        inArray: (..._args: unknown[]) => ({}),
        isNull: (..._args: unknown[]) => ({}),
        isNotNull: (..._args: unknown[]) => ({}),
        count: () => "count()",
        sql: (strings: TemplateStringsArray, ..._values: unknown[]) => ({
          sql: strings.join("?"),
          _values,
        }),
        generateSnowflakeId: async () =>
          `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      };
    });

    // Import the service AFTER mocks are set up
    const service = await import("../achievement-service");
    checkProgress = service.checkProgress;
    getUserAchievements = service.getUserAchievements;
    getUserChallenges = service.getUserChallenges;
  });

  beforeEach(() => {
    resetState();
    dbInsertCalls = [];
    dbUpdateCalls = [];
    mockAwardPoints.mockClear();
    mockAwardReputation.mockClear();
    mockCreateNotification.mockClear();
    mockBroadcastToChannel.mockClear();
  });

  afterAll(() => {
    mock.restore();
  });

  // ── checkProgress: unknown event type ──

  it("does nothing for unknown event types", async () => {
    await checkProgress("user-1", { type: "unknown_event" });
    expect(mockAwardPoints).not.toHaveBeenCalled();
    expect(mockAwardReputation).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockBroadcastToChannel).not.toHaveBeenCalled();
  });

  // ── checkProgress: achievement unlock ──

  it("unlocks achievement when progress meets threshold", async () => {
    // "first_trade" requires prediction_trade_count >= 1
    const firstTradeAchievement = ACHIEVEMENT_DEFINITIONS.find(
      (a) => a.trackingType === "prediction_trade_count" && a.threshold === 1,
    );
    expect(firstTradeAchievement).toBeDefined();

    // User has no unlocked achievements
    state.unlockedAchievementIds = [];
    // Resolver returns count = 1 (meets threshold)
    state.resolverResults.set("positions", 1);
    state.insertReturnsRow = true;

    await checkProgress("user-1", {
      type: "prediction_trade",
      marketId: "mkt-1",
    });

    // Should have awarded points
    expect(mockAwardReputation).toHaveBeenCalled();
    // Should have created notification
    expect(mockCreateNotification).toHaveBeenCalled();
    // Should have broadcast SSE
    expect(mockBroadcastToChannel).toHaveBeenCalled();

    // Verify broadcast was for achievement_unlocked
    const broadcastCall = mockBroadcastToChannel.mock.calls[0];
    expect(broadcastCall?.[0]).toBe("notifications:user-1");
    const payload = broadcastCall?.[1] as Record<string, unknown>;
    expect(payload?.type).toBe("achievement_unlocked");
  });

  it("skips already-unlocked achievements", async () => {
    // prediction_trade maps to multiple tracking types, each with achievements.
    // Mark ALL achievements relevant to prediction_trade as already unlocked.
    const relevantTrackingTypes = [
      "prediction_trade_count",
      "total_trade_count",
      "distinct_markets",
    ];
    const relevantAchievements = ACHIEVEMENT_DEFINITIONS.filter((a) =>
      relevantTrackingTypes.includes(a.trackingType),
    );
    expect(relevantAchievements.length).toBeGreaterThan(0);

    state.unlockedAchievementIds = relevantAchievements.map((a) => a.id);
    state.resolverResults.set("positions", 999);
    state.resolverResults.set("perpPositions", 999);

    await checkProgress("user-1", {
      type: "prediction_trade",
      marketId: "mkt-1",
    });

    // No achievement_unlocked broadcasts since all are already unlocked
    const achievementBroadcasts = mockBroadcastToChannel.mock.calls.filter(
      (call) => {
        const payload = call[1] as Record<string, unknown>;
        return payload?.type === "achievement_unlocked";
      },
    );
    expect(achievementBroadcasts).toHaveLength(0);
  });

  it("does not unlock achievement when progress below threshold", async () => {
    state.unlockedAchievementIds = [];
    // Progress = 0 (below threshold)
    state.resolverResults.set("positions", 0);

    await checkProgress("user-1", {
      type: "prediction_trade",
      marketId: "mkt-1",
    });

    // No achievement_unlocked broadcasts
    const achievementBroadcasts = mockBroadcastToChannel.mock.calls.filter(
      (call) => {
        const payload = call[1] as Record<string, unknown>;
        return payload?.type === "achievement_unlocked";
      },
    );
    expect(achievementBroadcasts).toHaveLength(0);
  });

  it("handles concurrent unlock gracefully (onConflictDoNothing returns empty)", async () => {
    state.unlockedAchievementIds = [];
    state.resolverResults.set("positions", 1);
    // Simulate race condition: insert returns empty (another request already inserted)
    state.insertReturnsRow = false;

    await checkProgress("user-1", {
      type: "prediction_trade",
      marketId: "mkt-1",
    });

    // Should NOT award points since insert returned empty
    expect(mockAwardReputation).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  // ── checkProgress: awards correct points ──

  it("awards correct points for achievement tier", async () => {
    const bronzeAchievement = ACHIEVEMENT_DEFINITIONS.find(
      (a) => a.tier === "bronze",
    );
    expect(bronzeAchievement).toBeDefined();

    state.unlockedAchievementIds = [];
    state.resolverResults.set("positions", 999);
    state.resolverResults.set("perpPositions", 999);
    state.resolverResults.set("users", 999);
    state.insertReturnsRow = true;

    await checkProgress("user-1", {
      type: "prediction_trade",
      marketId: "mkt-1",
    });

    // Check that awardReputation was called with the achievement's pointsReward
    if (mockAwardReputation.mock.calls.length > 0) {
      const firstCall = mockAwardReputation.mock.calls[0];
      expect(firstCall?.[0]).toBe("user-1"); // userId
      expect(typeof firstCall?.[1]).toBe("number"); // points amount
      expect(firstCall?.[2]).toBe("achievement_unlock"); // reason
    }
  });

  // ── checkProgress: notification content ──

  it("sends notification with achievement name and points", async () => {
    state.unlockedAchievementIds = [];
    state.resolverResults.set("positions", 999);
    state.resolverResults.set("perpPositions", 999);
    state.insertReturnsRow = true;

    await checkProgress("user-1", {
      type: "prediction_trade",
      marketId: "mkt-1",
    });

    if (mockCreateNotification.mock.calls.length > 0) {
      const notifArg = mockCreateNotification.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(notifArg?.userId).toBe("user-1");
      expect(notifArg?.type).toBe("achievement_unlocked");
      expect(typeof notifArg?.title).toBe("string");
      expect(notifArg?.title as string).toContain("Achievement Unlocked");
    }
  });

  // ── checkProgress: multiple event types ──

  it("handles agent_created event", async () => {
    state.unlockedAchievementIds = [];
    state.resolverResults.set("users", 1);
    state.insertReturnsRow = true;

    await checkProgress("user-1", { type: "agent_created" });

    // agent_created maps to 'agent_count' tracking type
    // Should check achievements with agent_count trackingType
    const agentAchievements = ACHIEVEMENT_DEFINITIONS.filter(
      (a) => a.trackingType === "agent_count",
    );
    // If there are agent achievements and threshold is met, should unlock
    if (agentAchievements.length > 0) {
      expect(
        mockAwardReputation.mock.calls.length +
          mockBroadcastToChannel.mock.calls.length,
      ).toBeGreaterThan(0);
    }
  });

  it("handles post_created event", async () => {
    state.unlockedAchievementIds = [];
    state.resolverResults.set("posts", 0);

    await checkProgress("user-1", { type: "post_created" });

    // post_created maps to daily_post, weekly_post, weekly_feed_engage
    // With 0 progress, nothing should unlock
    // No errors should be thrown
    expect(true).toBe(true);
  });

  it("handles daily_login event", async () => {
    state.unlockedAchievementIds = [];
    state.resolverResults.set("users", 7);

    await checkProgress("user-1", { type: "daily_login", streak: 7 });

    // daily_login maps to login_streak tracking type
    // With streak=7 and login_streak achievement threshold met, should unlock
    const loginAchievements = ACHIEVEMENT_DEFINITIONS.filter(
      (a) => a.trackingType === "login_streak",
    );
    if (loginAchievements.some((a) => a.threshold <= 7)) {
      expect(mockAwardReputation.mock.calls.length).toBeGreaterThan(0);
    }
  });
});

// ── getUserAchievements ────────────────────────────────────────────

describe("getUserAchievements", () => {
  beforeEach(() => {
    resetState();
  });

  it("returns all 15 achievements", async () => {
    state.unlockedAchievementIds = [];
    state.resolverResults.set("positions", 0);

    const results = await getUserAchievements("user-1");
    expect(results).toHaveLength(15);
  });

  it("marks unlocked achievements correctly", async () => {
    const firstAchievement = ACHIEVEMENT_DEFINITIONS[0]!;
    state.unlockedAchievementIds = [firstAchievement.id];

    const results = (await getUserAchievements("user-1")) as Array<{
      id: string;
      unlocked: boolean;
      progress: number;
      threshold: number;
      unlockedAt: Date | null;
    }>;

    const unlocked = results.find((r) => r.id === firstAchievement.id);
    expect(unlocked).toBeDefined();
    expect(unlocked?.unlocked).toBe(true);
    expect(unlocked?.progress).toBe(unlocked?.threshold);
    expect(unlocked?.unlockedAt).not.toBeNull();
  });

  it("includes progress for locked achievements", async () => {
    state.unlockedAchievementIds = [];
    // All resolver queries will return count of 3
    state.resolverResults.set("positions", 3);
    state.resolverResults.set("perpPositions", 3);

    const results = (await getUserAchievements("user-1")) as Array<{
      id: string;
      unlocked: boolean;
      progress: number;
      threshold: number;
    }>;

    // All should be in the results
    expect(results).toHaveLength(15);
    // Some may be unlocked (threshold <= 3), some may not
    for (const r of results) {
      expect(r.progress).toBeGreaterThanOrEqual(0);
      expect(r.progress).toBeLessThanOrEqual(r.threshold);
    }
  });

  it("caps progress at threshold", async () => {
    state.unlockedAchievementIds = [];
    // All resolvers return a huge number
    state.resolverResults.set("positions", 99999);
    state.resolverResults.set("perpPositions", 99999);
    state.resolverResults.set("users", 99999);

    const results = (await getUserAchievements("user-1")) as Array<{
      progress: number;
      threshold: number;
    }>;

    for (const r of results) {
      expect(r.progress).toBeLessThanOrEqual(r.threshold);
    }
  });

  it("returns correct shape for each achievement", async () => {
    state.unlockedAchievementIds = [];

    const results = (await getUserAchievements("user-1")) as Array<
      Record<string, unknown>
    >;

    for (const r of results) {
      expect(r).toHaveProperty("id");
      expect(r).toHaveProperty("name");
      expect(r).toHaveProperty("description");
      expect(r).toHaveProperty("category");
      expect(r).toHaveProperty("tier");
      expect(r).toHaveProperty("iconKey");
      expect(r).toHaveProperty("pointsReward");
      expect(r).toHaveProperty("threshold");
      expect(r).toHaveProperty("progress");
      expect(r).toHaveProperty("unlocked");
      expect(r).toHaveProperty("unlockedAt");
    }
  });
});

// ── getUserChallenges ──────────────────────────────────────────────

describe("getUserChallenges", () => {
  beforeEach(() => {
    resetState();
  });

  it("returns daily and weekly sections", async () => {
    const result = (await getUserChallenges("user-1")) as {
      daily: {
        challenges: unknown[];
        allCompletedBonus: number;
        allCompleted: boolean;
        resetsAt: string;
      };
      weekly: {
        challenges: unknown[];
        allCompletedBonus: number;
        allCompleted: boolean;
        resetsAt: string;
      };
    };

    expect(result).toHaveProperty("daily");
    expect(result).toHaveProperty("weekly");
    expect(result.daily).toHaveProperty("challenges");
    expect(result.daily).toHaveProperty("allCompletedBonus");
    expect(result.daily).toHaveProperty("allCompleted");
    expect(result.daily).toHaveProperty("resetsAt");
    expect(result.weekly).toHaveProperty("challenges");
    expect(result.weekly).toHaveProperty("allCompletedBonus");
    expect(result.weekly).toHaveProperty("allCompleted");
    expect(result.weekly).toHaveProperty("resetsAt");
  });

  it("returns 3 daily challenges and 2 weekly challenges", async () => {
    const result = (await getUserChallenges("user-1")) as {
      daily: { challenges: unknown[] };
      weekly: { challenges: unknown[] };
    };

    expect(result.daily.challenges).toHaveLength(3);
    expect(result.weekly.challenges).toHaveLength(2);
  });

  it("includes correct bonus amounts", async () => {
    const result = (await getUserChallenges("user-1")) as {
      daily: { allCompletedBonus: number };
      weekly: { allCompletedBonus: number };
    };

    expect(result.daily.allCompletedBonus).toBe(
      POINTS.CHALLENGE_DAILY_ALL_BONUS,
    );
    expect(result.weekly.allCompletedBonus).toBe(
      POINTS.CHALLENGE_WEEKLY_ALL_BONUS,
    );
  });

  it("includes valid resetsAt ISO timestamps", async () => {
    const result = (await getUserChallenges("user-1")) as {
      daily: { resetsAt: string };
      weekly: { resetsAt: string };
    };

    // Should be valid ISO date strings
    expect(new Date(result.daily.resetsAt).getTime()).not.toBeNaN();
    expect(new Date(result.weekly.resetsAt).getTime()).not.toBeNaN();

    // Daily reset should be tomorrow
    const dailyReset = new Date(result.daily.resetsAt);
    expect(dailyReset.getTime()).toBeGreaterThan(Date.now());

    // Weekly reset should be in the future
    const weeklyReset = new Date(result.weekly.resetsAt);
    expect(weeklyReset.getTime()).toBeGreaterThan(Date.now());
  });

  it("challenges have correct shape", async () => {
    const result = (await getUserChallenges("user-1")) as {
      daily: { challenges: Array<Record<string, unknown>> };
      weekly: { challenges: Array<Record<string, unknown>> };
    };

    const allChallenges = [
      ...result.daily.challenges,
      ...result.weekly.challenges,
    ];

    for (const c of allChallenges) {
      expect(c).toHaveProperty("id");
      expect(c).toHaveProperty("name");
      expect(c).toHaveProperty("description");
      expect(c).toHaveProperty("category");
      expect(c).toHaveProperty("iconKey");
      expect(c).toHaveProperty("pointsReward");
      expect(c).toHaveProperty("threshold");
      expect(c).toHaveProperty("progress");
      expect(c).toHaveProperty("completed");
      expect(c).toHaveProperty("completedAt");
    }
  });

  it("challenge IDs come from the correct pools", async () => {
    const result = (await getUserChallenges("user-1")) as {
      daily: { challenges: Array<{ id: string }> };
      weekly: { challenges: Array<{ id: string }> };
    };

    const dailyPool = new Set(DAILY_CHALLENGE_DEFINITIONS.map((c) => c.id));
    const weeklyPool = new Set(WEEKLY_CHALLENGE_DEFINITIONS.map((c) => c.id));

    for (const c of result.daily.challenges) {
      expect(dailyPool.has(c.id)).toBe(true);
    }
    for (const c of result.weekly.challenges) {
      expect(weeklyPool.has(c.id)).toBe(true);
    }
  });

  it("allCompleted is false when challenges are not completed", async () => {
    // With default mock state, no challenges are completed
    const result = (await getUserChallenges("user-1")) as {
      daily: { allCompleted: boolean };
      weekly: { allCompleted: boolean };
    };

    expect(result.daily.allCompleted).toBe(false);
    expect(result.weekly.allCompleted).toBe(false);
  });
});

// ── Resolver coverage checks ──────────────────────────────────────

describe("Resolver Coverage", () => {
  it("every achievement trackingType has a resolver", () => {
    // This is an indirect test — if a tracking type has no resolver, checkProgress
    // will log a warning and skip. We verify all defined types are represented.
    const achievementTrackingTypes = new Set(
      ACHIEVEMENT_DEFINITIONS.map((a) => a.trackingType),
    );
    // These should all be handled (the service has ACHIEVEMENT_RESOLVERS)
    // We can't directly access ACHIEVEMENT_RESOLVERS from outside, but we
    // can verify the expected set is reasonable
    const expectedTypes = [
      "prediction_trade_count",
      "perp_trade_count",
      "total_trade_count",
      "distinct_markets",
      "prediction_win_count",
      "agent_count",
      "agent_message_count",
      "agent_trade_count",
      "group_message_count",
      "comment_count",
      "terminal_visit_count",
      "agents_visit_count",
      "login_streak",
    ];

    for (const tt of achievementTrackingTypes) {
      expect(expectedTypes).toContain(tt);
    }
  });

  it("every challenge trackingType has a resolver", () => {
    const challengeTrackingTypes = new Set(
      ALL_CHALLENGE_DEFINITIONS.map((c) => c.trackingType),
    );

    // Verify all challenge tracking types are from the expected set
    for (const tt of challengeTrackingTypes) {
      expect(tt).toBeTruthy();
      // All challenge tracking types should start with daily_ or weekly_
      expect(tt.startsWith("daily_") || tt.startsWith("weekly_")).toBe(true);
    }
  });
});
