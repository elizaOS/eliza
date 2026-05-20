/**
 * Unit Test Setup
 *
 * Provides mocked database client and other dependencies for unit tests.
 * Unit tests should not require a real database connection.
 */

import { beforeAll, mock } from 'bun:test';
import type {
  MockDatabaseClient,
  MockTransactionFn,
} from '../types/test-types';

// Mock database client for all unit tests
beforeAll(() => {
  // Set test environment variables
  void Reflect.set(process.env, 'NODE_ENV', 'test');
  void Reflect.set(
    process.env,
    'DATABASE_URL',
    'postgresql://mock:mock@localhost:5432/mock_test'
  );
  void Reflect.set(process.env, 'REDIS_URL', 'redis://localhost:6379');

  // Mock the database module entirely
  mock.module('@babylon/db', () => {
    const mockDatabase = createMockDatabase();
    return {
      db: mockDatabase,
      dbBase: mockDatabase,
    };
  });

  // Mock Redis as well
  mock.module('ioredis', () => {
    return {
      default: class MockRedis {
        constructor() {}
        on() {
          return this;
        }
        connect() {
          return Promise.resolve();
        }
        disconnect() {
          return Promise.resolve();
        }
        get() {
          return Promise.resolve(null);
        }
        set() {
          return Promise.resolve('OK');
        }
        del() {
          return Promise.resolve(1);
        }
        expire() {
          return Promise.resolve(1);
        }
        ttl() {
          return Promise.resolve(-1);
        }
        keys() {
          return Promise.resolve([]);
        }
        flushall() {
          return Promise.resolve('OK');
        }
        pipeline() {
          return {
            exec: () => Promise.resolve([]),
          };
        }
      },
    };
  });
});

/**
 * Create a mock database client with all necessary models
 */
function createMockDatabase() {
  const mockModels = [
    'user',
    'actor',
    'pool',
    'market',
    'position',
    'trade',
    'post',
    'comment',
    'worldFact',
    'parodyHeadline',
    'waitlistEntry',
    'points',
    'marketOutcome',
    'vote',
    'marketSpotlight',
    'group',
    'groupMember',
    'groupInvite',
    'actorFollow',
    'userActorFollow',
    'actorRelationship',
    'nPCTrade',
    'marketPool',
    'liquidityPosition',
    'swap',
    'userStats',
    'aiPrompt',
    'threadMessage',
    'article',
    'rSSFeedItem',
    'rSSFeedSource',
    'rSSHeadline',
    'conversation',
    'notification',
    'fact',
    'factCategoryBlacklist',
    'factResponse',
    'topicCategory',
    'stickerPackCollectionInfo',
    'leaderboardResults',
    'onChainUserMapping',
    'automationTask',
    'automationLog',
    'automationCampaign',
    'feedback',
    'reputationLog',
    'achievements',
    // Agent-related models
    'agentGoal',
    'agentGoalAction',
    'agentMessage',
    'agentLog',
    'agentPointsTransaction',
    'agentPerformanceMetrics',
    // Trajectory and training models
    'trajectory',
    'trainingBatch',
    'trainedModel',
    'llmCallLog',
    'rewardJudgment',
  ];

  // Initialize base mock client - model methods are added dynamically below
  const mockClient = {
    $connect: mock(() => Promise.resolve()),
    $disconnect: mock(() => Promise.resolve()),
    $queryRaw: mock(() => Promise.resolve([])),
    $executeRaw: mock(() => Promise.resolve(0)),
    $transaction: mock(async (fn: MockTransactionFn) => {
      // Execute the transaction function with the mock client
      return await fn(mockClient as MockDatabaseClient);
    }),
  } as MockDatabaseClient;

  // Add mock methods for each database model
  for (const modelName of mockModels) {
    mockClient[modelName] = {
      findUnique: mock(() => Promise.resolve(null)),
      findMany: mock(() => Promise.resolve([])),
      findFirst: mock(() => Promise.resolve(null)),
      count: mock(() => Promise.resolve(0)),
      create: mock(() => Promise.resolve({ id: 'mock-id' })),
      createMany: mock(() => Promise.resolve({ count: 0 })),
      update: mock(() => Promise.resolve({ id: 'mock-id' })),
      updateMany: mock(() => Promise.resolve({ count: 0 })),
      upsert: mock(() => Promise.resolve({ id: 'mock-id' })),
      delete: mock(() => Promise.resolve({ id: 'mock-id' })),
      deleteMany: mock(() => Promise.resolve({ count: 0 })),
      aggregate: mock(() =>
        Promise.resolve({
          _count: 0,
          _sum: null,
          _avg: null,
          _min: null,
          _max: null,
        })
      ),
      groupBy: mock(() => Promise.resolve([])),
    };
  }

  return mockClient;
}

export { createMockDatabase };
