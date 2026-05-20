import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { NextRequest } from "next/server";
import * as actualApiModule from "../../../api/src/index";
import * as actualDbModule from "../../../db/src/index";
import * as actualEngineModule from "../../../engine/src/index";

/**
 * Article Tick Cron Job Tests
 *
 * Tests for the article-tick cron endpoint which handles centralized
 * article generation with rate limiting.
 */

/**
 * Mock game state type
 */
interface MockGame {
  id: string;
  isContinuous: boolean;
  isRunning: boolean;
  currentDay: number | null;
}

/**
 * Drizzle SQL condition result
 */
interface SqlCondition {
  sql?: string;
}

interface CronMockState {
  articleGame: MockGame | null;
  articleCount: number;
  articleCronAuthResult: boolean;
  articleCoveredEventIds: Set<string>;
  marketsGame: MockGame | null;
  marketsActiveQuestions: Array<{
    id: string;
    questionNumber: number;
    resolutionDate: Date;
    status: string;
  }>;
  marketsWorldEvents: Array<{
    id: string;
    timestamp: Date;
    description: string;
  }>;
  marketsCronAuthResult: boolean;
  marketsAcquireLockResult: boolean;
}

const CRON_MOCK_STATE_KEY = "__feedCronMockState";

type GlobalWithCronMockState = typeof globalThis & {
  [CRON_MOCK_STATE_KEY]?: CronMockState;
};

const globalWithCronMockState = globalThis as GlobalWithCronMockState;

const cronMockState =
  globalWithCronMockState[CRON_MOCK_STATE_KEY] ??
  (globalWithCronMockState[CRON_MOCK_STATE_KEY] = {
    articleGame: null,
    articleCount: 0,
    articleCronAuthResult: true,
    articleCoveredEventIds: new Set<string>(),
    marketsGame: null,
    marketsActiveQuestions: [],
    marketsWorldEvents: [],
    marketsCronAuthResult: true,
    marketsAcquireLockResult: true,
  });

let mockSnowflakeCounter = 0;

const nextMockSnowflakeId = (): string => {
  mockSnowflakeCounter += 1;
  return `mock-snowflake-${Date.now()}-${mockSnowflakeCounter}`;
};

// Create query builder for Drizzle-style operations
// The resultFn is called at query execution time to get the current mock state
// This mirrors the markets-tick.test.ts pattern for dynamic result evaluation
const createQueryBuilder = (
  resultFn: () => unknown = () => [{ id: "mock-id" }],
) => {
  const builder = {
    set: mock(() => builder),
    where: mock(() => builder),
    values: mock(() => builder),
    from: mock(() => builder),
    limit: mock(() => builder),
    returning: mock(async () => resultFn()),
    onConflictDoNothing: mock(() => builder),
    then: <TResult1, TResult2 = never>(
      onFulfilled?:
        | ((value: unknown) => TResult1 | PromiseLike<TResult1>)
        | null,
      onRejected?:
        | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
        | null,
    ): Promise<TResult1 | TResult2> => {
      return Promise.resolve(resultFn()).then(onFulfilled, onRejected);
    },
  };
  return builder;
};

const registerMocks = () => {
  // Mock @feed/db - uses resultFn pattern for dynamic state evaluation
  mock.module("@feed/db", () => ({
    ...actualDbModule,
    db: {
      select: mock(() =>
        createQueryBuilder(() =>
          cronMockState.articleGame ? [cronMockState.articleGame] : [],
        ),
      ),
      insert: mock(() =>
        createQueryBuilder(() => [{ id: `mock-${Date.now()}` }]),
      ),
      update: mock(() => createQueryBuilder(() => [{ id: "mock-updated" }])),
      delete: mock(() => createQueryBuilder(() => [{ id: "mock-deleted" }])),
    },
    games: {
      _tableName: "games",
      id: "id",
      isRunning: "isRunning",
      isContinuous: "isContinuous",
      currentDay: "currentDay",
    },
    questions: {
      _tableName: "questions",
      status: "status",
      resolutionDate: "resolutionDate",
      id: "id",
      questionNumber: "questionNumber",
    },
    userAgentConfigs: { _tableName: "userAgentConfigs" },
    users: { _tableName: "users" },
    actors: { _tableName: "actors" },
    comments: { _tableName: "comments" },
    organizations: { _tableName: "organizations" },
    balanceTransactions: { _tableName: "balanceTransactions" },
    pointsTransactions: { _tableName: "pointsTransactions" },
    perpPositions: { _tableName: "perpPositions" },
    poolPositions: { _tableName: "poolPositions" },
    markets: { _tableName: "markets" },
    generationLocks: { _tableName: "generationLocks" },
    agentPerformanceMetrics: { _tableName: "agentPerformanceMetrics" },
    agentTrades: { _tableName: "agentTrades" },
    npcTrades: { _tableName: "npcTrades" },
    timeframedMarkets: { _tableName: "timeframedMarkets" },
    worldEvents: { _tableName: "worldEvents", timestamp: "timestamp" },
    posts: {
      _tableName: "posts",
      type: "type",
      timestamp: "timestamp",
      deletedAt: "deletedAt",
    },
    eq: (): SqlCondition => ({}),
    ne: (): SqlCondition => ({}),
    gt: (): SqlCondition => ({}),
    gte: (): SqlCondition => ({}),
    lt: (): SqlCondition => ({}),
    lte: (): SqlCondition => ({}),
    and: (): SqlCondition => ({}),
    or: (): SqlCondition => ({}),
    not: (): SqlCondition => ({}),
    inArray: (): SqlCondition => ({}),
    desc: (): SqlCondition => ({}),
    asc: (): SqlCondition => ({}),
    isNull: (): SqlCondition => ({}),
    isNotNull: (): SqlCondition => ({}),
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      sql: strings.join("?"),
      values,
    }),
    max: (col: unknown) => ({ _aggregation: "max", column: col }),
    generateSnowflakeId: async () => nextMockSnowflakeId(),
    withTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
    asUser: async <T>(_userId: string, fn: (db: unknown) => Promise<T>) =>
      fn({}),
    asSystem: async <T>(fn: (db: unknown) => Promise<T>) => fn({}),
    asPublic: async <T>(fn: (db: unknown) => Promise<T>) => fn({}),
  }));

  // Mock @feed/api - supports both article-tick and markets-tick consumers
  mock.module("@feed/api", () => ({
    ...actualApiModule,
    CACHE_KEYS: {
      gameState: (_gameId: string) => "game-state",
    },
    DEFAULT_TTLS: {
      gameState: 60,
    },
    verifyCronAuth: (req: Request | NextRequest) => {
      const pathname = new URL(req.url).pathname;
      return pathname.includes("/markets-tick")
        ? cronMockState.marketsCronAuthResult
        : cronMockState.articleCronAuthResult;
    },
    relayCronToStaging: async () => ({ forwarded: false }),
    broadcastAgentActivity: async () => {},
    broadcastToChannel: async () => {},
    notifyGroupChatInvite: async () => {},
    checkRateLimit: async () => ({ allowed: true, remaining: 1 }),
    checkRateLimitAsync: async () => ({ allowed: true, remaining: 1 }),
    clearAllRateLimits: async () => {},
    getRateLimitStatus: async () => ({ remaining: 1, resetAt: Date.now() }),
    resetRateLimit: async () => {},
    invalidateCache: async () => {},
    getCacheOrFetch: async <T>(_key: string, fn: () => Promise<T>) => {
      if (_key === "continuous-game") {
        return cronMockState.articleGame as T;
      }
      if (_key.includes("game-state")) {
        return (cronMockState.marketsGame || {
          id: "continuous",
          isRunning: false,
          isContinuous: true,
          currentDay: 1,
        }) as T;
      }
      return fn();
    },
    recordCronExecution: () => {},
    DistributedLockService: {
      acquireLock: async (options?: { lockId?: string }) => {
        if (options?.lockId?.includes("markets-tick")) {
          return cronMockState.marketsAcquireLockResult;
        }
        return true;
      },
      releaseLock: async () => {},
    },
  }));

  mock.module("@feed/core/markets/prediction", () => ({
    PredictionDbAdapter: class {},
    PredictionMarketService: class {
      ensureMarketExists = async () => ({ id: "mock-market-id" });
    },
  }));

  // Mock @feed/engine - includes exports needed by both cron routes
  mock.module("@feed/engine", () => ({
    ...actualEngineModule,
    articleRateLimiter: {
      canGenerateArticle: async () => ({
        allowed: cronMockState.articleCount < 2,
        currentCount: cronMockState.articleCount,
        maxAllowed: 2,
        remaining: Math.max(0, 2 - cronMockState.articleCount),
      }),
    },
    ArticleGenerator: class {
      generateArticleForQuestion = async () => ({
        // Complete Article interface with all required fields
        id: `mock-article-${Date.now()}`,
        title: "Test Article",
        summary: "Test summary",
        content: "Test content that is long enough to pass validation. ".repeat(
          20,
        ),
        authorOrgId: "org-1",
        authorOrgName: "Test News",
        byline: "Test Author",
        bylineActorId: "actor-1",
        biasScore: 0,
        sentiment: "neutral" as const,
        slant: "Neutral coverage",
        relatedEventId: "event-1",
        relatedActorIds: [],
        relatedOrgIds: ["org-1"],
        category: "news",
        tags: ["test", "article"],
        publishedAt: new Date(),
      });
    },
    FeedLLMClient: {
      forGameTick: () => ({
        generateJSON: async () => ({
          title: "Test Article",
          summary: "Test summary",
          article: "Test article body",
        }),
      }),
    },
    QuestionManager: class {
      async generateTimeframeQuestion() {
        return {
          text: "Will AIlon Musk launch a new product?",
          expectedOutcome: true,
          resolutionCriteria: "Product launch announcement",
          affiliatedActorIds: [],
          affiliatedOrgIds: [],
        };
      }
      async generateResolutionWithProof() {
        return {
          description: "The product was launched",
          confidence: 0.95,
          requiresManualReview: false,
          proof: null,
        };
      }
    },
    getActiveEventsForPosting: async () => ({ activeEvents: [] }),
    hasEventBeenCovered: async (eventId: string) =>
      cronMockState.articleCoveredEventIds.has(eventId),
    markEventAsCovered: async (eventId: string) => {
      cronMockState.articleCoveredEventIds.add(eventId);
    },
    persistArticle: async (input: { id: string }) => ({
      success: true,
      articleId: input.id,
    }),
    getReputationBreakdown: () => ({
      total: 0,
      level: "neutral",
      trend: 0,
      factors: {},
    }),
    recalculateReputation: async () => {},
    resolveQuestionPayouts: async () => {},
    SignalExtractionService: {
      extractMarketSignal: async () => ({
        suggestedOutcome: "YES",
        confidence: 0.8,
        yesSignal: 0.7,
        noSignal: 0.3,
        signalStrength: 0.6,
        totalPosts: 10,
      }),
    },
    StaticDataRegistry: {
      getOrganizationsByType: () => [
        {
          id: "org-1",
          name: "Test News",
          description: "A news org",
          type: "media",
          canBeInvolved: true,
        },
      ],
      getTopActors: () => [
        {
          id: "actor-1",
          name: "Test Actor",
          description: "A test actor",
          domain: ["tech"],
          personality: "Analytical and cautious",
          tier: "mid",
          affiliations: [],
          postStyle: "Neutral analysis",
          postExample: [],
          role: "Analyst",
          initialLuck: "medium",
          initialMood: 0,
        },
      ],
      getAllActors: () => [],
      getAllOrganizations: () => [],
      getActor: () => null,
      getOrganization: () => null,
    },
    isEligibleActor: () => true,
    mapGranularToDbTimeframe: (timeframe: string) => timeframe,
    secureRandom: () => Math.random(),
    weightedPick: <T>(items: T[]) => items[0] ?? null,
    gameService: {
      getCurrentGame: async () => null,
    },
    setBroadcastToChannel: () => {},
    setDistributedLockProvider: () => {},
    setNotifyGroupChatInvite: () => {},
    setRateLimitProvider: () => {},
    timeframeArcPlanner: {
      planTimeframeArc: () => ({
        questionId: "q-1",
        timeframe: "1d",
        category: "daily",
        outcome: true,
        durationMs: 86400000,
        phases: {},
        phaseOrder: ["setup", "peak", "resolution"],
        insiders: [],
        deceivers: [],
        affiliatedOrgIds: [],
        affiliatedActorIds: [],
        createdAt: new Date(),
      }),
    },
    worldFactsService: {
      generatePromptContext: async () => "Test world facts context",
    },
  }));
};

// @feed/shared is intentionally not mocked here.

// Route handlers are loaded dynamically after mock registration.
let GET: (req: NextRequest) => Promise<Response>;
let POST: (req: NextRequest) => Promise<Response>;

describe("Article Tick Cron", () => {
  beforeAll(async () => {
    registerMocks();
    const routeModule = await import("@/app/api/cron/article-tick/route");
    GET = routeModule.GET;
    POST = routeModule.POST;
  });

  afterAll(() => {
    mock.restore();
  });

  beforeEach(() => {
    cronMockState.articleGame = null;
    cronMockState.articleCount = 0;
    cronMockState.articleCronAuthResult = true;
    cronMockState.articleCoveredEventIds.clear();
  });

  describe("Authorization", () => {
    test("should reject unauthorized requests when verifyCronAuth returns false", async () => {
      cronMockState.articleCronAuthResult = false;

      const req = new NextRequest("http://localhost/api/cron/article-tick", {
        method: "POST",
      });
      const res = await POST(req);

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("Unauthorized cron request");
      expect(data.success).toBeUndefined();
    });

    test("GET should delegate to POST and return identical response", async () => {
      // Set up a known game state so we get predictable responses
      cronMockState.articleGame = null; // No game = skipped state

      // Create identical requests for GET and POST
      const getReq = new NextRequest("http://localhost/api/cron/article-tick", {
        method: "GET",
      });
      const postReq = new NextRequest(
        "http://localhost/api/cron/article-tick",
        {
          method: "POST",
        },
      );

      // Call both handlers
      const getRes = await GET(getReq);
      const postRes = await POST(postReq);

      // Both should return the same status
      expect(getRes.status).toBe(postRes.status);

      // Both should return the same response body
      const getBody = await getRes.json();
      const postBody = await postRes.json();

      expect(getBody.success).toBe(postBody.success);
      expect(getBody.skipped).toBe(postBody.skipped);
      expect(getBody.reason).toBe(postBody.reason);

      // Verify the expected behavior (skipped because no game)
      expect(getBody.success).toBe(true);
      expect(getBody.skipped).toBe(true);
      expect(getBody.reason).toBe("No continuous game found");
    });
  });

  describe("Game State Checks", () => {
    test("should be skipped when no continuous game exists", async () => {
      cronMockState.articleGame = null;

      const req = new NextRequest("http://localhost/api/cron/article-tick", {
        method: "POST",
      });
      const res = await POST(req);
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.skipped).toBe(true);
      expect(data.reason).toBe("No continuous game found");
    });

    test("should be paused when game.isRunning is false", async () => {
      cronMockState.articleGame = {
        id: "game-123",
        isContinuous: true,
        isRunning: false,
        currentDay: 1,
      };

      const req = new NextRequest("http://localhost/api/cron/article-tick", {
        method: "POST",
      });
      const res = await POST(req);
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.skipped).toBe(true);
      expect(data.reason).toBe("Game is paused");
    });
  });

  describe("Rate Limiting", () => {
    test("should skip when rate limit reached", async () => {
      cronMockState.articleGame = {
        id: "game-123",
        isContinuous: true,
        isRunning: true,
        currentDay: 1,
      };
      cronMockState.articleCount = 2; // At limit

      const req = new NextRequest("http://localhost/api/cron/article-tick", {
        method: "POST",
      });
      const res = await POST(req);
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.skipped).toBe(true);
      expect(data.reason).toBe("Rate limit reached");
    });

    test("should proceed when under rate limit", async () => {
      cronMockState.articleGame = {
        id: "game-123",
        isContinuous: true,
        isRunning: true,
        currentDay: 1,
      };
      cronMockState.articleCount = 0; // Under limit

      const req = new NextRequest("http://localhost/api/cron/article-tick", {
        method: "POST",
      });
      const res = await POST(req);
      const data = await res.json();

      // Positive assertions: handler succeeded and actually processed
      expect(res.status).toBe(200);
      expect(res.ok).toBe(true);
      expect(data.success).toBe(true);
      expect(data.skipped).toBe(false);

      // Should not be skipped due to rate limit
      expect(data.reason).not.toBe("Rate limit reached");
    });
  });

  describe("Response Structure", () => {
    test("should return rate limit info in response", async () => {
      cronMockState.articleGame = {
        id: "game-123",
        isContinuous: true,
        isRunning: true,
        currentDay: 1,
      };
      cronMockState.articleCount = 1; // Under limit (2), so processing should proceed

      const req = new NextRequest("http://localhost/api/cron/article-tick", {
        method: "POST",
      });
      const res = await POST(req);
      const data = await res.json();

      // Verify handler succeeded and was not skipped
      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.skipped).toBe(false); // Explicit assertion - test fails if skipped

      // Rate limit info should always be included when not skipped
      expect(data.rateLimit).toBeDefined();
      expect(data.rateLimit.currentCount).toBe(1);
      expect(data.rateLimit.maxAllowed).toBe(2);
    });
  });
});
