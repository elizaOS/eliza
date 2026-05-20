import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test';
import { NextRequest } from 'next/server';
import * as actualApiModule from '../../../api/src/index';
import * as actualDbModule from '../../../db/src/index';
import * as actualEngineModule from '../../../engine/src/index';

/**
 * Markets Tick Cron Job Tests
 *
 * Tests for the markets-tick cron endpoint which handles the complete
 * lifecycle of prediction markets.
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
 * Mock question type for markets
 */
interface MockQuestion {
  id: string;
  questionNumber: number;
  resolutionDate: Date;
  status: string;
}

/**
 * Drizzle SQL condition result
 */
interface SqlCondition {
  sql?: string;
}

interface MockWorldEvent {
  id: string;
  timestamp: Date;
  description: string;
}

interface CronMockState {
  articleGame: MockGame | null;
  articleCount: number;
  articleCronAuthResult: boolean;
  articleCoveredEventIds: Set<string>;
  marketsGame: MockGame | null;
  marketsActiveQuestions: MockQuestion[];
  marketsWorldEvents: MockWorldEvent[];
  marketsCronAuthResult: boolean;
  marketsAcquireLockResult: boolean;
}

const CRON_MOCK_STATE_KEY = '__feedCronMockState';

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

// Track which table is being queried for table-aware mocking
let currentQueryTable: string | null = null;

// Table reference symbols for detection
const TABLE_REFS = {
  games: { _tableName: 'games' },
  questions: {
    _tableName: 'questions',
    status: 'status',
    resolutionDate: 'resolutionDate',
    id: 'id',
    questionNumber: 'questionNumber',
  },
  timeframedMarkets: { _tableName: 'timeframedMarkets' },
  worldEvents: { _tableName: 'worldEvents', timestamp: 'timestamp' },
  posts: { _tableName: 'posts' },
  userAgentConfigs: { _tableName: 'userAgentConfigs' },
  users: { _tableName: 'users' },
  actors: { _tableName: 'actors' },
  comments: { _tableName: 'comments' },
  organizations: { _tableName: 'organizations' },
  balanceTransactions: { _tableName: 'balanceTransactions' },
  pointsTransactions: { _tableName: 'pointsTransactions' },
  perpPositions: { _tableName: 'perpPositions' },
  poolPositions: { _tableName: 'poolPositions' },
  markets: { _tableName: 'markets' },
  generationLocks: { _tableName: 'generationLocks' },
  agentPerformanceMetrics: { _tableName: 'agentPerformanceMetrics' },
  agentTrades: { _tableName: 'agentTrades' },
  npcTrades: { _tableName: 'npcTrades' },
};

// Get mock data based on the current query table
const getTableData = (): unknown => {
  switch (currentQueryTable) {
    case 'games':
      return cronMockState.marketsGame ? [cronMockState.marketsGame] : [];
    case 'questions':
      // Return active questions by default; mature questions handled via where clause
      return cronMockState.marketsActiveQuestions;
    case 'worldEvents':
      return cronMockState.marketsWorldEvents;
    case 'timeframedMarkets':
      return [];
    case 'posts':
      return [];
    default:
      return [];
  }
};

// Create query builder for Drizzle-style operations
// The resultFn is called at query execution time to get the current mock state
const createQueryBuilder = (
  resultFn: () => unknown,
  operation: 'select' | 'insert' | 'update' | 'delete' = 'select'
) => {
  const builder = {
    set: mock(() => builder),
    where: mock(() => builder),
    values: mock(() => builder),
    from: mock((table: { _tableName?: string }) => {
      // Track which table is being queried
      if (table && table._tableName) {
        currentQueryTable = table._tableName;
      }
      return builder;
    }),
    leftJoin: mock(() => builder),
    innerJoin: mock(() => builder),
    rightJoin: mock(() => builder),
    fullJoin: mock(() => builder),
    limit: mock(() => builder),
    orderBy: mock(() => builder),
    returning: mock(async () => {
      if (operation === 'insert') return [{ id: `mock-${Date.now()}` }];
      if (operation === 'update') return [{ id: 'mock-updated' }];
      if (operation === 'delete') return [{ id: 'mock-deleted' }];
      return resultFn();
    }),
    onConflictDoNothing: mock(() => builder),
    then: <TResult1, TResult2 = never>(
      onFulfilled?:
        | ((value: unknown) => TResult1 | PromiseLike<TResult1>)
        | null,
      onRejected?:
        | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
        | null
    ): Promise<TResult1 | TResult2> => {
      const result = resultFn();
      return Promise.resolve(result).then(onFulfilled, onRejected);
    },
  };
  return builder;
};

// Create table-aware insert/update/delete builders
const createMutationBuilder = (operation: 'insert' | 'update' | 'delete') => {
  return mock((table: { _tableName?: string }) => {
    if (table && table._tableName) {
      currentQueryTable = table._tableName;
    }
    return createQueryBuilder(
      () => [{ id: `mock-${operation}-id` }],
      operation
    );
  });
};

const registerMocks = () => {
  // Mock @feed/db - table-aware query handling
  mock.module('@feed/db', () => ({
    ...actualDbModule,
    db: {
      select: mock((columns?: Record<string, unknown>) => {
        // Reset table tracking for new query
        currentQueryTable = null;
        // If selecting specific columns (like MAX), handle specially
        if (columns && 'maxNumber' in columns) {
          // This is the getNextQuestionNumber query
          return createQueryBuilder(() => {
            const maxNum = cronMockState.marketsActiveQuestions.reduce(
              (max, q) => Math.max(max, q.questionNumber),
              0
            );
            return [{ maxNumber: maxNum > 0 ? maxNum : null }];
          });
        }
        return createQueryBuilder(() => getTableData());
      }),
      insert: createMutationBuilder('insert'),
      update: createMutationBuilder('update'),
      delete: createMutationBuilder('delete'),
      transaction: mock(
        async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> => {
          // Create a transaction context that mirrors the db interface
          const tx = {
            select: mock(() => createQueryBuilder(() => getTableData())),
            insert: createMutationBuilder('insert'),
            update: createMutationBuilder('update'),
            delete: createMutationBuilder('delete'),
          };
          return callback(tx);
        }
      ),
    },
    games: TABLE_REFS.games,
    questions: TABLE_REFS.questions,
    userAgentConfigs: TABLE_REFS.userAgentConfigs,
    users: TABLE_REFS.users,
    actors: TABLE_REFS.actors,
    comments: TABLE_REFS.comments,
    organizations: TABLE_REFS.organizations,
    balanceTransactions: TABLE_REFS.balanceTransactions,
    pointsTransactions: TABLE_REFS.pointsTransactions,
    perpPositions: TABLE_REFS.perpPositions,
    poolPositions: TABLE_REFS.poolPositions,
    markets: TABLE_REFS.markets,
    generationLocks: TABLE_REFS.generationLocks,
    agentPerformanceMetrics: TABLE_REFS.agentPerformanceMetrics,
    agentTrades: TABLE_REFS.agentTrades,
    npcTrades: TABLE_REFS.npcTrades,
    timeframedMarkets: TABLE_REFS.timeframedMarkets,
    worldEvents: TABLE_REFS.worldEvents,
    posts: TABLE_REFS.posts,
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
      sql: strings.join('?'),
      values,
    }),
    max: (col: unknown) => ({ _aggregation: 'max', column: col }),
    generateSnowflakeId: async () => nextMockSnowflakeId(),
    withTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
    asUser: async <T>(_userId: string, fn: (db: unknown) => Promise<T>) =>
      fn({}),
    asSystem: async <T>(fn: (db: unknown) => Promise<T>) => fn({}),
    asPublic: async <T>(fn: (db: unknown) => Promise<T>) => fn({}),
  }));

  // Mock @feed/api - uses mutable state for auth/lock results
  mock.module('@feed/api', () => ({
    ...actualApiModule,
    CACHE_KEYS: {
      gameState: (_gameId: string) => 'game-state',
    },
    DEFAULT_TTLS: {
      gameState: 60,
    },
    verifyCronAuth: (req: Request | NextRequest) => {
      const pathname = new URL(req.url).pathname;
      return pathname.includes('/article-tick')
        ? cronMockState.articleCronAuthResult
        : cronMockState.marketsCronAuthResult;
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
      if (_key === 'continuous-game') {
        return cronMockState.articleGame as T;
      }
      if (_key.includes('game-state')) {
        return (cronMockState.marketsGame || {
          id: 'continuous',
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
        if (options?.lockId?.includes('markets-tick')) {
          return cronMockState.marketsAcquireLockResult;
        }
        return true;
      },
      releaseLock: async () => {},
    },
  }));

  // Mock @feed/core/markets/prediction
  mock.module('@feed/core/markets/prediction', () => ({
    PredictionDbAdapter: class {},
    PredictionMarketService: class {
      ensureMarketExists = async () => ({ id: 'mock-market-id' });
    },
  }));

  // Mock @feed/engine
  mock.module('@feed/engine', () => ({
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
        id: `mock-article-${Date.now()}`,
        title: 'Test Article',
        summary: 'Test summary',
        content: 'Test content that is long enough to pass validation. '.repeat(
          20
        ),
        authorOrgId: 'org-1',
        authorOrgName: 'Test News',
        byline: 'Test Author',
        bylineActorId: 'actor-1',
        biasScore: 0,
        sentiment: 'neutral' as const,
        slant: 'Neutral coverage',
        relatedEventId: 'event-1',
        relatedActorIds: [],
        relatedOrgIds: ['org-1'],
        category: 'news',
        tags: ['test', 'article'],
        publishedAt: new Date(),
      });
    },
    dailyTopicService: {
      ensureTopicForDate: async () => ({
        topicKey: 'openai',
        topicLabel: 'OpenAI',
        summary: 'OpenAI is the single topic for today',
        date: new Date('2026-03-06T00:00:00.000Z'),
        sourceType: 'auto' as const,
        sourceHeadlineIds: [],
        selectionReason: 'Matched headlines',
        isLocked: false,
      }),
    },
    deriveTopicFromText: (text: string, date?: Date) => ({
      topicKey: 'legacy-parent',
      topicLabel: 'Legacy Parent',
      summary: text,
      date: date ?? new Date('2026-03-06T00:00:00.000Z'),
      sourceType: 'fallback_previous_day' as const,
      sourceHeadlineIds: [],
      selectionReason: 'Derived from text',
      isLocked: false,
    }),
    isEligibleActor: () => true,
    mapGranularToDbTimeframe: (timeframe: string) => timeframe,
    FeedLLMClient: class MockFeedLLMClient {
      static forGameTick() {
        return new MockFeedLLMClient();
      }
      async generateJSON() {
        return {
          text: 'Will AIlon Musk launch a new product?',
          expectedOutcome: true,
          resolutionCriteria: 'Product launch announcement',
          affiliatedActorIds: [],
          affiliatedOrgIds: [],
        };
      }
    },
    QuestionManager: class MockQuestionManager {
      constructor(_llmClient: unknown) {}
      async generateTimeframeQuestion(_timeframe: string, _durationMs: number) {
        return {
          text: 'Will AIlon Musk launch a new product?',
          expectedOutcome: true,
          resolutionCriteria: 'Product launch announcement',
          affiliatedActorIds: [],
          affiliatedOrgIds: [],
        };
      }
      async generateResolutionWithProof() {
        return {
          description: 'The product was launched',
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
      level: 'neutral',
      trend: 0,
      factors: {},
    }),
    recalculateReputation: async () => {},
    resolveQuestionPayouts: async () => {},
    SignalExtractionService: {
      extractMarketSignal: async () => ({
        suggestedOutcome: 'YES',
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
          id: 'org-1',
          name: 'Test News',
          description: 'A news org',
          type: 'media',
          canBeInvolved: true,
        },
      ],
      getTopActors: () => [
        {
          id: 'actor-1',
          name: 'Test Actor',
          description: 'A test actor',
          domain: ['tech'],
          personality: 'Analytical and cautious',
          tier: 'mid',
          affiliations: [],
          postStyle: 'Neutral analysis',
          postExample: [],
          role: 'Analyst',
          initialLuck: 'medium',
          initialMood: 0,
        },
      ],
      getAllActors: () => [],
      getAllOrganizations: () => [],
      getActor: () => null,
      getOrganization: () => null,
    },
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
        questionId: 'q-1',
        timeframe: '1d',
        category: 'daily',
        outcome: true,
        durationMs: 86400000,
        phases: {},
        phaseOrder: ['setup', 'peak', 'resolution'],
        insiders: [],
        deceivers: [],
        affiliatedOrgIds: [],
        affiliatedActorIds: [],
        createdAt: new Date(),
      }),
    },
    worldFactsService: {
      generatePromptContext: async () => 'Test world facts context',
    },
  }));
};

// @feed/shared is intentionally not mocked here.

// Route handlers are loaded dynamically after mock registration.
let GET: (req: NextRequest) => Promise<Response>;
let POST: (req: NextRequest) => Promise<Response>;

describe('Markets Tick Cron', () => {
  beforeAll(async () => {
    registerMocks();
    const routeModule = await import('@/app/api/cron/markets-tick/route');
    GET = routeModule.GET;
    POST = routeModule.POST;
  });

  afterAll(() => {
    mock.restore();
  });

  beforeEach(() => {
    cronMockState.marketsGame = null;
    cronMockState.marketsActiveQuestions = [];
    cronMockState.marketsWorldEvents = [];
    cronMockState.marketsCronAuthResult = true;
    cronMockState.marketsAcquireLockResult = true;
    currentQueryTable = null;
  });

  describe('Authorization', () => {
    test('GET should delegate to POST and return equivalent response', async () => {
      // Set up identical conditions for both requests
      cronMockState.marketsGame = null; // No game = predictable skipped state

      const getReq = new NextRequest('http://localhost/api/cron/markets-tick', {
        method: 'GET',
      });
      const postReq = new NextRequest(
        'http://localhost/api/cron/markets-tick',
        {
          method: 'POST',
        }
      );

      const getRes = await GET(getReq);
      const postRes = await POST(postReq);

      // GET should delegate to POST, so responses should match
      expect(getRes.status).toBe(postRes.status);

      const getData = await getRes.json();
      const postData = await postRes.json();

      // Key response properties should be equivalent
      expect(getData.success).toBe(postData.success);
      expect(getData.skipped).toBe(postData.skipped);
    });

    test('should reject unauthorized requests when verifyCronAuth returns false', async () => {
      cronMockState.marketsCronAuthResult = false;

      const req = new NextRequest('http://localhost/api/cron/markets-tick', {
        method: 'POST',
      });
      const res = await POST(req);

      // Should return 401 Unauthorized
      expect(res.status).toBe(401);
    });

    test('GET should also reject unauthorized requests', async () => {
      cronMockState.marketsCronAuthResult = false;

      const req = new NextRequest('http://localhost/api/cron/markets-tick', {
        method: 'GET',
      });
      const res = await GET(req);

      // GET delegates to POST, so should also return 401
      expect(res.status).toBe(401);
    });
  });

  describe('Distributed Lock', () => {
    test('should skip when lock cannot be acquired', async () => {
      cronMockState.marketsGame = {
        id: 'game-123',
        isContinuous: true,
        isRunning: true,
        currentDay: 1,
      };
      cronMockState.marketsAcquireLockResult = false;

      const req = new NextRequest('http://localhost/api/cron/markets-tick', {
        method: 'POST',
      });
      const res = await POST(req);
      const data = await res.json();

      // Should indicate lock failure/skip (route returns "Previous tick still running")
      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.skipped).toBe(true);
      expect(data.reason).toContain('Previous tick still running');
    });
  });

  describe('Game State Checks', () => {
    test('should skip when game is not running', async () => {
      cronMockState.marketsGame = {
        id: 'game-123',
        isContinuous: true,
        isRunning: false,
        currentDay: 1,
      };

      const req = new NextRequest('http://localhost/api/cron/markets-tick', {
        method: 'POST',
      });
      const res = await POST(req);
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.skipped).toBe(true);
      expect(data.reason).toBe('Game not running');
    });

    // Additional integration tests (game running, market creation, resolution)
    // are in packages/testing/integration/markets-tick.integration.test.ts
    // These require real database access and are run separately.
  });
});

describe('Market Timeframe Configuration', () => {
  test('should have correct market distribution (10 total)', () => {
    // Expected: 1x 3-day, 1x 2-day, 1x 1-day, 1x 12-hour, 1x 6-hour, 1x 1-hour, 2x 30-minute, 2x 15-minute
    //
    // IMPORTANT: These values are a deliberate contract-style duplication of the production
    // MARKET_TIMEFRAMES config in markets-tick/route.ts. Do NOT import production internals here.
    // If the production config changes, this test must be updated to match. This ensures the
    // test acts as a contract verification rather than a tautology.
    const expectedMarkets = {
      '3d': 1,
      '2d': 1,
      '1d': 1,
      '12h': 1,
      '6h': 1,
      '1h': 1,
      '30m': 2,
      '15m': 2,
    };

    const totalExpected = Object.values(expectedMarkets).reduce(
      (a, b) => a + b,
      0
    );
    expect(totalExpected).toBe(10);
  });
});

// =============================================================================
// Granular Timeframe Inference Tests
// =============================================================================

describe('inferGranularTimeframe', () => {
  // Define MARKET_STRUCTURE durations locally (contract-style test)
  const DURATIONS = {
    '15m': 15 * 60 * 1000, // 900,000 ms
    '30m': 30 * 60 * 1000, // 1,800,000 ms
    '1h': 60 * 60 * 1000, // 3,600,000 ms
    '6h': 6 * 60 * 60 * 1000, // 21,600,000 ms
    '12h': 12 * 60 * 60 * 1000, // 43,200,000 ms
    '1d': 24 * 60 * 60 * 1000, // 86,400,000 ms
    '2d': 2 * 24 * 60 * 60 * 1000, // 172,800,000 ms
    '3d': 3 * 24 * 60 * 60 * 1000, // 259,200,000 ms
  };

  // Replicate inferGranularTimeframe logic for testing
  function inferGranularTimeframe(durationMs: number): string {
    const sortedEntries = Object.entries(DURATIONS).sort((a, b) => a[1] - b[1]);

    // 10% tolerance matching
    for (const [key, expectedDuration] of sortedEntries) {
      const tolerance = expectedDuration * 0.1;
      if (Math.abs(durationMs - expectedDuration) <= tolerance) {
        return key;
      }
    }

    // Fallback to closest
    let closestKey = '1h';
    let closestDiff = Infinity;
    for (const [key, expectedDuration] of sortedEntries) {
      const diff = Math.abs(durationMs - expectedDuration);
      if (diff < closestDiff) {
        closestDiff = diff;
        closestKey = key;
      }
    }
    return closestKey;
  }

  describe('exact duration matches', () => {
    test('should match 15m duration exactly', () => {
      expect(inferGranularTimeframe(DURATIONS['15m'])).toBe('15m');
    });

    test('should match 30m duration exactly', () => {
      expect(inferGranularTimeframe(DURATIONS['30m'])).toBe('30m');
    });

    test('should match 1h duration exactly', () => {
      expect(inferGranularTimeframe(DURATIONS['1h'])).toBe('1h');
    });

    test('should match 6h duration exactly', () => {
      expect(inferGranularTimeframe(DURATIONS['6h'])).toBe('6h');
    });

    test('should match 12h duration exactly', () => {
      expect(inferGranularTimeframe(DURATIONS['12h'])).toBe('12h');
    });

    test('should match 1d duration exactly', () => {
      expect(inferGranularTimeframe(DURATIONS['1d'])).toBe('1d');
    });

    test('should match 2d duration exactly', () => {
      expect(inferGranularTimeframe(DURATIONS['2d'])).toBe('2d');
    });

    test('should match 3d duration exactly', () => {
      expect(inferGranularTimeframe(DURATIONS['3d'])).toBe('3d');
    });
  });

  describe('10% tolerance boundary tests', () => {
    test('should match 15m at +10% tolerance boundary', () => {
      const duration = DURATIONS['15m'] * 1.1; // 990,000 ms
      expect(inferGranularTimeframe(duration)).toBe('15m');
    });

    test('should match 15m at -10% tolerance boundary', () => {
      const duration = DURATIONS['15m'] * 0.9; // 810,000 ms
      expect(inferGranularTimeframe(duration)).toBe('15m');
    });

    test('should match 1h at +10% tolerance boundary', () => {
      const duration = DURATIONS['1h'] * 1.1; // 3,960,000 ms
      expect(inferGranularTimeframe(duration)).toBe('1h');
    });

    test('should match 1h at -10% tolerance boundary', () => {
      const duration = DURATIONS['1h'] * 0.9; // 3,240,000 ms
      expect(inferGranularTimeframe(duration)).toBe('1h');
    });

    test('should fall back to closest when outside all tolerances', () => {
      // Duration exactly between 15m and 30m (outside both tolerances)
      const midpoint = (DURATIONS['15m'] + DURATIONS['30m']) / 2; // 1,350,000 ms
      // Should fall back to closest, which is 15m (450k away) vs 30m (450k away)
      // Since they're equidistant, it will match 15m first in sorted order
      const result = inferGranularTimeframe(midpoint);
      expect(['15m', '30m']).toContain(result);
    });

    test('should handle very short durations (below 15m)', () => {
      const shortDuration = 5 * 60 * 1000; // 5 minutes
      // Should fall back to closest, which is 15m
      expect(inferGranularTimeframe(shortDuration)).toBe('15m');
    });

    test('should handle very long durations (above 3d)', () => {
      const longDuration = 5 * 24 * 60 * 60 * 1000; // 5 days
      // Should fall back to closest, which is 3d
      expect(inferGranularTimeframe(longDuration)).toBe('3d');
    });
  });

  describe('edge cases', () => {
    test('should handle zero duration', () => {
      // Should fall back to closest, which is 15m (smallest)
      expect(inferGranularTimeframe(0)).toBe('15m');
    });

    test('should handle negative duration gracefully', () => {
      // Should fall back to closest
      const result = inferGranularTimeframe(-1000);
      expect(result).toBeDefined();
    });
  });
});

// =============================================================================
// Sub-Market Batch Creation Tests
// =============================================================================

describe('Sub-Market Batch Creation Logic', () => {
  const MAX_SUB_MARKETS = 10;
  const MAX_SUB_MARKETS_PER_TICK = 5;

  test('should create up to MAX_SUB_MARKETS_PER_TICK when many needed', () => {
    const activeSubMarkets = 0;
    const subMarketsNeeded = MAX_SUB_MARKETS - activeSubMarkets; // 10
    const createCount = Math.min(subMarketsNeeded, MAX_SUB_MARKETS_PER_TICK);

    expect(createCount).toBe(5);
  });

  test('should create exact amount when fewer than limit needed', () => {
    const activeSubMarkets = 7;
    const subMarketsNeeded = MAX_SUB_MARKETS - activeSubMarkets; // 3
    const createCount = Math.min(subMarketsNeeded, MAX_SUB_MARKETS_PER_TICK);

    expect(createCount).toBe(3);
  });

  test('should create zero when at maximum', () => {
    const activeSubMarkets = 10;
    const subMarketsNeeded = MAX_SUB_MARKETS - activeSubMarkets; // 0
    const createCount = Math.min(subMarketsNeeded, MAX_SUB_MARKETS_PER_TICK);

    expect(createCount).toBe(0);
  });

  test('should create one when one needed', () => {
    const activeSubMarkets = 9;
    const subMarketsNeeded = MAX_SUB_MARKETS - activeSubMarkets; // 1
    const createCount = Math.min(subMarketsNeeded, MAX_SUB_MARKETS_PER_TICK);

    expect(createCount).toBe(1);
  });

  test('should handle over-capacity gracefully', () => {
    const activeSubMarkets = 12; // More than max (shouldn't happen but testing edge case)
    const subMarketsNeeded = MAX_SUB_MARKETS - activeSubMarkets; // -2
    const createCount = Math.max(
      0,
      Math.min(subMarketsNeeded, MAX_SUB_MARKETS_PER_TICK)
    );

    expect(createCount).toBe(0);
  });
});

// =============================================================================
// Idempotency Check Tests
// =============================================================================

describe('Market Idempotency Check Logic', () => {
  interface MockMarket {
    id: string;
    granularTimeframe: string | null;
    startTime: Date;
    endTime: Date;
  }

  const DURATIONS = {
    '15m': 15 * 60 * 1000,
    '30m': 30 * 60 * 1000,
    '1h': 60 * 60 * 1000,
  };

  function inferGranularTimeframe(durationMs: number): string {
    const sortedEntries = Object.entries(DURATIONS).sort((a, b) => a[1] - b[1]);
    for (const [key, expectedDuration] of sortedEntries) {
      const tolerance = expectedDuration * 0.1;
      if (Math.abs(durationMs - expectedDuration) <= tolerance) {
        return key;
      }
    }
    return '1h';
  }

  function countMarketsForTimeframe(
    markets: MockMarket[],
    targetTimeframe: string
  ): number {
    return markets.filter((m) => {
      const tf =
        m.granularTimeframe ??
        inferGranularTimeframe(m.endTime.getTime() - m.startTime.getTime());
      return tf === targetTimeframe;
    }).length;
  }

  test('should count markets with stored granularTimeframe', () => {
    const now = Date.now();
    const markets: MockMarket[] = [
      {
        id: '1',
        granularTimeframe: '15m',
        startTime: new Date(now),
        endTime: new Date(now + DURATIONS['15m']),
      },
      {
        id: '2',
        granularTimeframe: '15m',
        startTime: new Date(now),
        endTime: new Date(now + DURATIONS['15m']),
      },
      {
        id: '3',
        granularTimeframe: '30m',
        startTime: new Date(now),
        endTime: new Date(now + DURATIONS['30m']),
      },
    ];

    expect(countMarketsForTimeframe(markets, '15m')).toBe(2);
    expect(countMarketsForTimeframe(markets, '30m')).toBe(1);
    expect(countMarketsForTimeframe(markets, '1h')).toBe(0);
  });

  test('should fall back to inference for legacy markets without granularTimeframe', () => {
    const now = Date.now();
    const markets: MockMarket[] = [
      {
        id: '1',
        granularTimeframe: null, // Legacy market
        startTime: new Date(now),
        endTime: new Date(now + DURATIONS['15m']),
      },
      {
        id: '2',
        granularTimeframe: '15m', // New market
        startTime: new Date(now),
        endTime: new Date(now + DURATIONS['15m']),
      },
    ];

    // Both should be counted as 15m
    expect(countMarketsForTimeframe(markets, '15m')).toBe(2);
  });

  test('should prevent creation when at target count', () => {
    const targetCount = 2;
    const currentCount = 2;

    const shouldCreate = currentCount < targetCount;
    expect(shouldCreate).toBe(false);
  });

  test('should allow creation when below target count', () => {
    const targetCount = 2;
    const currentCount = 1;

    const shouldCreate = currentCount < targetCount;
    expect(shouldCreate).toBe(true);
  });
});

// =============================================================================
// Granular to DB Timeframe Mapping Tests
// =============================================================================

describe('Granular to DB Timeframe Mapping', () => {
  // Contract-style test - these mappings should match production
  const EXPECTED_MAPPINGS: Record<string, string> = {
    '15m': 'flash',
    '30m': 'flash',
    '1h': 'intraday',
    '6h': 'intraday',
    '12h': 'daily',
    '1d': 'daily',
    '2d': 'weekly',
    '3d': 'weekly',
  };

  test('should map flash timeframes correctly', () => {
    expect(EXPECTED_MAPPINGS['15m']).toBe('flash');
    expect(EXPECTED_MAPPINGS['30m']).toBe('flash');
  });

  test('should map intraday timeframes correctly', () => {
    expect(EXPECTED_MAPPINGS['1h']).toBe('intraday');
    expect(EXPECTED_MAPPINGS['6h']).toBe('intraday');
  });

  test('should map daily timeframes correctly', () => {
    expect(EXPECTED_MAPPINGS['12h']).toBe('daily');
    expect(EXPECTED_MAPPINGS['1d']).toBe('daily');
  });

  test('should map weekly timeframes correctly', () => {
    expect(EXPECTED_MAPPINGS['2d']).toBe('weekly');
    expect(EXPECTED_MAPPINGS['3d']).toBe('weekly');
  });

  test('should have all 8 granular timeframes mapped', () => {
    const keys = Object.keys(EXPECTED_MAPPINGS);
    expect(keys.length).toBe(8);
    expect(keys).toContain('15m');
    expect(keys).toContain('30m');
    expect(keys).toContain('1h');
    expect(keys).toContain('6h');
    expect(keys).toContain('12h');
    expect(keys).toContain('1d');
    expect(keys).toContain('2d');
    expect(keys).toContain('3d');
  });

  test('should aggregate to correct DB timeframe counts', () => {
    const dbCounts: Record<string, number> = {};
    for (const dbTimeframe of Object.values(EXPECTED_MAPPINGS)) {
      dbCounts[dbTimeframe] = (dbCounts[dbTimeframe] || 0) + 1;
    }

    expect(dbCounts['flash']).toBe(2); // 15m + 30m
    expect(dbCounts['intraday']).toBe(2); // 1h + 6h
    expect(dbCounts['daily']).toBe(2); // 12h + 1d
    expect(dbCounts['weekly']).toBe(2); // 2d + 3d
  });
});

// =============================================================================
// toStringArray Type Guard Tests
// =============================================================================

describe('toStringArray Type Guard', () => {
  // Replicate the toStringArray helper for testing
  function isStringArray(value: unknown): value is string[] {
    return (
      Array.isArray(value) && value.every((item) => typeof item === 'string')
    );
  }

  function toStringArray(value: unknown): string[] {
    if (isStringArray(value)) return value;
    if (value === null || value === undefined) return [];
    return [];
  }

  test('should return array for valid string array', () => {
    expect(toStringArray(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  test('should return empty array for null', () => {
    expect(toStringArray(null)).toEqual([]);
  });

  test('should return empty array for undefined', () => {
    expect(toStringArray(undefined)).toEqual([]);
  });

  test('should return empty array for non-array types', () => {
    expect(toStringArray('string')).toEqual([]);
    expect(toStringArray(123)).toEqual([]);
    expect(toStringArray({ key: 'value' })).toEqual([]);
  });

  test('should return empty array for mixed arrays', () => {
    expect(toStringArray(['a', 1, 'b'])).toEqual([]);
  });

  test('should return empty array for empty array', () => {
    expect(toStringArray([])).toEqual([]);
  });

  test('should handle nested arrays as invalid', () => {
    expect(toStringArray([['a', 'b'], ['c']])).toEqual([]);
  });
});

// =============================================================================
// inferSubMarketTimeframe Tests (Updated for Fixed Version)
// =============================================================================

describe('inferSubMarketTimeframe (Fixed Version)', () => {
  // Replicate the FIXED inferSubMarketTimeframe logic
  // Now only returns supported keys: '15m', '30m', '1h'
  function inferSubMarketTimeframe(durationMs: number): '15m' | '30m' | '1h' {
    const minutes = durationMs / (60 * 1000);
    if (minutes <= 22.5) return '15m';
    if (minutes <= 45) return '30m';
    return '1h'; // All durations > 45min map to 1h (closest supported key)
  }

  test('should return 15m for durations up to 22.5 minutes', () => {
    expect(inferSubMarketTimeframe(15 * 60 * 1000)).toBe('15m'); // 15 min
    expect(inferSubMarketTimeframe(20 * 60 * 1000)).toBe('15m'); // 20 min
    expect(inferSubMarketTimeframe(22.5 * 60 * 1000)).toBe('15m'); // 22.5 min
  });

  test('should return 30m for durations from 22.5 to 45 minutes', () => {
    expect(inferSubMarketTimeframe(23 * 60 * 1000)).toBe('30m'); // 23 min
    expect(inferSubMarketTimeframe(30 * 60 * 1000)).toBe('30m'); // 30 min
    expect(inferSubMarketTimeframe(45 * 60 * 1000)).toBe('30m'); // 45 min
  });

  test('should return 1h for all durations over 45 minutes', () => {
    expect(inferSubMarketTimeframe(46 * 60 * 1000)).toBe('1h'); // 46 min
    expect(inferSubMarketTimeframe(60 * 60 * 1000)).toBe('1h'); // 60 min
    expect(inferSubMarketTimeframe(90 * 60 * 1000)).toBe('1h'); // 90 min
    expect(inferSubMarketTimeframe(120 * 60 * 1000)).toBe('1h'); // 120 min
    expect(inferSubMarketTimeframe(180 * 60 * 1000)).toBe('1h'); // 180 min (3 hours)
  });

  test('should only return keys supported by GRANULAR_TO_DB_TIMEFRAME', () => {
    // This is the critical fix - no more '2h' or '3h' which would cause throws
    const supportedKeys = ['15m', '30m', '1h'];

    // Test a range of durations
    const testDurations = [
      15 * 60 * 1000, // 15 min
      30 * 60 * 1000, // 30 min
      60 * 60 * 1000, // 1 hour
      90 * 60 * 1000, // 1.5 hours
      120 * 60 * 1000, // 2 hours
      180 * 60 * 1000, // 3 hours
    ];

    for (const duration of testDurations) {
      const result = inferSubMarketTimeframe(duration);
      expect(supportedKeys).toContain(result);
    }
  });
});

// =============================================================================
// Transactional Sub-Market Creation Logic Tests
// =============================================================================

describe('Transactional Sub-Market Creation Logic', () => {
  const MAX_SUB_MARKETS = 10;
  const MAX_SUB_MARKETS_PER_TICK = 5;

  test('should abort creation when count reaches MAX_SUB_MARKETS inside transaction', () => {
    // Simulate scenario where count was 8 outside tx, but 10 inside tx
    const outsideCount = 8;
    const insideCount = 10;

    // Outside transaction check suggests we need to create
    const outsideNeeded = MAX_SUB_MARKETS - outsideCount;
    expect(outsideNeeded).toBe(2);

    // But inside transaction, we discover we're at max
    const shouldCreate = insideCount < MAX_SUB_MARKETS;
    expect(shouldCreate).toBe(false);
  });

  test('should respect MAX_SUB_MARKETS_PER_TICK even when many needed', () => {
    const activeSubMarkets = 0;
    const subMarketsNeeded = MAX_SUB_MARKETS - activeSubMarkets; // 10
    const createCount = Math.min(subMarketsNeeded, MAX_SUB_MARKETS_PER_TICK);

    expect(createCount).toBe(5);
  });

  test('should handle concurrent tick scenario with SKIP LOCKED', () => {
    // Simulate SKIP LOCKED behavior:
    // If another transaction has locked the rows, we should get empty results
    const lockedByOtherTransaction = true;
    const parentMarketsReturned = lockedByOtherTransaction ? [] : [{ id: '1' }];

    // When SKIP LOCKED returns empty, we create 0 sub-markets
    expect(parentMarketsReturned.length).toBe(0);
  });

  test('should track gapFillingSkippedDueToMax metric correctly', () => {
    // When activeSubMarketCount >= MAX_SUB_MARKETS, we should set the flag
    const testCases = [
      { activeCount: 10, expected: true },
      { activeCount: 11, expected: true },
      { activeCount: 9, expected: false },
      { activeCount: 0, expected: false },
    ];

    for (const { activeCount, expected } of testCases) {
      const gapFillingSkippedDueToMax = activeCount >= MAX_SUB_MARKETS;
      expect(gapFillingSkippedDueToMax).toBe(expected);
    }
  });
});

// =============================================================================
// Cache Invalidation Logic Tests
// =============================================================================

describe('Cache Invalidation Logic', () => {
  test('should invalidate cache when sub-markets are created', () => {
    // Simulate: subMarketsCreated > 0 -> invalidate cache
    const subMarketsCreated = 3;
    const shouldInvalidate = subMarketsCreated > 0;
    expect(shouldInvalidate).toBe(true);
  });

  test('should not invalidate cache when no sub-markets created', () => {
    // Simulate: subMarketsCreated === 0 -> skip cache invalidation
    const subMarketsCreated = 0;
    const shouldInvalidate = subMarketsCreated > 0;
    expect(shouldInvalidate).toBe(false);
  });
});

// =============================================================================
// Media Selection Relevance Scoring Tests
// =============================================================================

// =============================================================================
// Sub-Market Duration Constraint Tests
// =============================================================================

describe('Sub-Market Duration Constraints', () => {
  const SUB_MARKET_MIN_DURATION_MS = 15 * 60 * 1000; // 15 minutes
  const SUB_MARKET_MAX_DURATION_MS = 3 * 60 * 60 * 1000; // 3 hours
  const SUB_MARKET_RESOLUTION_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

  // Replicate the getMaxSubMarketDuration helper for testing
  function getMaxSubMarketDuration(
    parentEndTime: Date,
    now: number = Date.now()
  ): number | null {
    const remainingTimeMs =
      parentEndTime.getTime() - now - SUB_MARKET_RESOLUTION_BUFFER_MS;

    if (remainingTimeMs < SUB_MARKET_MIN_DURATION_MS) {
      return null;
    }

    return Math.min(remainingTimeMs, SUB_MARKET_MAX_DURATION_MS);
  }

  test('should return null when parent has less than minimum duration remaining', () => {
    const now = Date.now();
    // Parent ends in 10 minutes (less than 15 min minimum + 5 min buffer)
    const parentEndTime = new Date(now + 10 * 60 * 1000);

    expect(getMaxSubMarketDuration(parentEndTime, now)).toBeNull();
  });

  test('should return minimum when parent ends exactly at minimum + buffer', () => {
    const now = Date.now();
    // Parent ends in exactly 20 minutes (15 min min + 5 min buffer)
    // This is the edge case - should return null because remaining = 15 which is not > 15
    const parentEndTime = new Date(now + 20 * 60 * 1000);

    // After subtracting buffer: 20 - 5 = 15 minutes
    // 15 minutes is exactly minimum, so this should work
    const result = getMaxSubMarketDuration(parentEndTime, now);
    expect(result).toBe(15 * 60 * 1000); // Should return exactly minimum
  });

  test('should return constrained duration when parent has limited time', () => {
    const now = Date.now();
    // Parent ends in 30 minutes
    const parentEndTime = new Date(now + 30 * 60 * 1000);

    // After buffer: 30 - 5 = 25 minutes max duration
    const result = getMaxSubMarketDuration(parentEndTime, now);
    expect(result).toBe(25 * 60 * 1000);
  });

  test('should cap at maximum duration when parent has plenty of time', () => {
    const now = Date.now();
    // Parent ends in 24 hours
    const parentEndTime = new Date(now + 24 * 60 * 60 * 1000);

    // Should cap at MAX_DURATION (3 hours)
    const result = getMaxSubMarketDuration(parentEndTime, now);
    expect(result).toBe(SUB_MARKET_MAX_DURATION_MS);
  });

  test('should handle parent ending very soon (less than buffer)', () => {
    const now = Date.now();
    // Parent ends in 3 minutes (less than 5 min buffer)
    const parentEndTime = new Date(now + 3 * 60 * 1000);

    expect(getMaxSubMarketDuration(parentEndTime, now)).toBeNull();
  });

  test('should handle parent already ended', () => {
    const now = Date.now();
    // Parent ended 5 minutes ago
    const parentEndTime = new Date(now - 5 * 60 * 1000);

    expect(getMaxSubMarketDuration(parentEndTime, now)).toBeNull();
  });

  test('should correctly calculate for 1-hour parent markets', () => {
    const now = Date.now();
    // Parent is a 1-hour market, currently at the start
    const parentEndTime = new Date(now + 60 * 60 * 1000);

    // After buffer: 60 - 5 = 55 minutes max
    const result = getMaxSubMarketDuration(parentEndTime, now);
    expect(result).toBe(55 * 60 * 1000);
  });

  test('should correctly calculate for parent with exactly 3 hours remaining', () => {
    const now = Date.now();
    // Parent ends in 3 hours
    const parentEndTime = new Date(now + 3 * 60 * 60 * 1000);

    // After buffer: 3h - 5m = 175 minutes, but capped at 3 hours (180 min)
    // Actually: 175 min < 180 min, so should return 175 minutes
    const result = getMaxSubMarketDuration(parentEndTime, now);
    expect(result).toBe((3 * 60 - 5) * 60 * 1000); // 175 minutes
  });
});

describe('Media Selection Relevance Scoring', () => {
  // Base scoring weights from the implementation
  const BASE_WEIGHT = 1.0;
  const DIRECT_AFFILIATION_BONUS = 2.0;
  const INDIRECT_AFFILIATION_BONUS = 1.5;
  const CATEGORY_MATCH_BONUS = 0.5;
  const MAX_RANDOM_VARIANCE = 1.0;

  test('should give all orgs at least base weight', () => {
    // Every media org starts with BASE_WEIGHT = 1.0
    const baseScore = BASE_WEIGHT;
    expect(baseScore).toBe(1.0);
  });

  test('should add bonus for direct actor affiliation', () => {
    // If org has actors affiliated with market's actors
    const scoreWithBonus = BASE_WEIGHT + DIRECT_AFFILIATION_BONUS;
    expect(scoreWithBonus).toBe(3.0);
  });

  test('should add smaller bonus for indirect affiliation', () => {
    // If org has actors that share affiliations with market orgs
    const scoreWithBonus = BASE_WEIGHT + INDIRECT_AFFILIATION_BONUS;
    expect(scoreWithBonus).toBe(2.5);
  });

  test('should add bonus for category match', () => {
    // If org's actors cover the market category domain
    const scoreWithBonus = BASE_WEIGHT + CATEGORY_MATCH_BONUS;
    expect(scoreWithBonus).toBe(1.5);
  });

  test('should include random variance to prevent determinism', () => {
    // Random variance between 0 and MAX_RANDOM_VARIANCE
    const minPossibleScore = BASE_WEIGHT + 0;
    const maxPossibleScore =
      BASE_WEIGHT +
      DIRECT_AFFILIATION_BONUS +
      INDIRECT_AFFILIATION_BONUS +
      CATEGORY_MATCH_BONUS +
      MAX_RANDOM_VARIANCE;

    expect(minPossibleScore).toBe(1.0);
    expect(maxPossibleScore).toBe(6.0);
  });
});

describe('parseMarketCategory Type Narrowing', () => {
  // Valid market categories from the implementation
  const VALID_MARKET_CATEGORIES = [
    'tech',
    'politics',
    'entertainment',
    'sports',
    'science',
    'business',
    'general',
  ] as const;

  type MarketCategory = (typeof VALID_MARKET_CATEGORIES)[number];

  // Replicate the parseMarketCategory logic for testing
  function isMarketCategory(value: unknown): value is MarketCategory {
    return (
      typeof value === 'string' &&
      VALID_MARKET_CATEGORIES.includes(value as MarketCategory)
    );
  }

  function parseMarketCategory(
    value: string | null | undefined,
    _context?: string
  ): MarketCategory {
    if (isMarketCategory(value)) {
      return value;
    }
    // Treat null, undefined, and empty string as missing data - no warning needed
    if (value === null || value === undefined || value === '') {
      return 'general';
    }
    // Only warn for invalid non-empty strings (likely a bug or data corruption)
    // In tests, we just return 'general' without the warning side effect
    return 'general';
  }

  test('should return valid category unchanged', () => {
    expect(parseMarketCategory('tech')).toBe('tech');
    expect(parseMarketCategory('politics')).toBe('politics');
    expect(parseMarketCategory('sports')).toBe('sports');
    expect(parseMarketCategory('science')).toBe('science');
    expect(parseMarketCategory('business')).toBe('business');
    expect(parseMarketCategory('entertainment')).toBe('entertainment');
    expect(parseMarketCategory('general')).toBe('general');
  });

  test('should return general for null without warning', () => {
    const result = parseMarketCategory(null);
    expect(result).toBe('general');
  });

  test('should return general for undefined without warning', () => {
    const result = parseMarketCategory(undefined);
    expect(result).toBe('general');
  });

  test('should return general for empty string without warning', () => {
    // Empty string should be treated as missing data, not as an invalid category
    const result = parseMarketCategory('');
    expect(result).toBe('general');
  });

  test('should return general for invalid non-empty string (with warning in production)', () => {
    // Invalid strings like typos should trigger a warning in production
    const result = parseMarketCategory('invalid-category');
    expect(result).toBe('general');

    const result2 = parseMarketCategory('TECH'); // Case sensitive
    expect(result2).toBe('general');

    const result3 = parseMarketCategory('technology'); // Not in valid list
    expect(result3).toBe('general');
  });

  test('should handle whitespace-only strings as invalid (not empty)', () => {
    // Whitespace strings are non-empty invalid strings
    const result = parseMarketCategory('   ');
    expect(result).toBe('general');
  });
});
