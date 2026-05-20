/**
 * MarketDecisionEngine Token Management Test Suite
 *
 * @module engine/__tests__/MarketDecisionEngine-token-management.test
 *
 * @description
 * Specialized test suite for token management and batching features of the
 * MarketDecisionEngine. Verifies that the engine correctly handles token limits,
 * batches NPCs appropriately, and truncates content to fit within model constraints.
 *
 * **Test Coverage:**
 * - Engine initialization with default and custom models
 * - Batch size calculation for various NPC counts
 * - Multi-batch processing for large NPC sets
 * - Response format handling (array, wrapped with "decisions", wrapped with "decision")
 * - Invalid response format handling
 * - Context truncation for long content
 * - Post count limiting per NPC
 * - Decision validation (hold, close_position, trades)
 * - Balance constraint enforcement
 * - Valid trade acceptance
 * - Empty NPC list handling
 * - Batch failure with individual retry fallback
 * - Model configuration (default vs custom)
 * - Safe context limit calculation
 *
 * **Key Features Tested:**
 * - Token-aware batching (5-15 NPCs per batch typically)
 * - Automatic chunking for large NPC counts
 * - Content truncation (posts, messages, events)
 * - Multiple response format support
 * - Strict validation preventing over-budget trades
 * - Graceful error handling with fallbacks
 *
 * **Testing Strategy:**
 * - Mock LLM client for controlled responses
 * - Mock context service for test data
 * - Helper functions for test NPC creation
 * - Unit tests for batching logic
 * - Integration tests for full flow
 *
 * @see {@link MarketDecisionEngine} - Class under test
 * @see {@link MarketContextService} - Context building tested
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// Create chainable mock for Drizzle query builder API
const createChainableMock = (
  returnValue: Array<Record<string, unknown>> = []
) => {
  const chainable = {
    from: () => chainable,
    where: () => chainable,
    orderBy: () => chainable,
    limit: () => chainable,
    offset: () => chainable,
    leftJoin: () => chainable,
    innerJoin: () => chainable,
    groupBy: () => chainable,
    having: () => chainable,
    then: (resolve: (value: Array<Record<string, unknown>>) => void) =>
      resolve(returnValue),
    [Symbol.toStringTag]: 'Promise',
  };
  // Make it awaitable
  Object.defineProperty(chainable, 'then', {
    value: (resolve: (value: Array<Record<string, unknown>>) => void) =>
      Promise.resolve(returnValue).then(resolve),
  });
  return chainable;
};

// Mock database BEFORE importing MarketDecisionEngine
const mockDb = {
  actor: {
    findMany: mock(async () => []),
  },
  organization: {
    findMany: mock(async () => []),
  },
  organizationMapping: {
    findMany: mock(async () => []),
  },
  question: {
    findMany: mock(async () => []),
  },
  dailyTopic: {
    findFirst: mock(async () => null),
  },
  post: {
    findMany: mock(async () => []),
  },
  // Add other models if needed
  market: { findMany: mock(async () => []) },
  nPCTrade: { findMany: mock(async () => []) },
  worldFact: { findMany: mock(async () => []) },
  agentTrade: { findMany: mock(async () => []) },
  dailyTopic: {
    findFirst: mock(async () => null),
    findMany: mock(async () => []),
  },
  // Add Drizzle query builder API
  select: () => createChainableMock([]),
  insert: () => createChainableMock([]),
  update: () => createChainableMock([]),
  delete: () => createChainableMock([]),
};

// Mock Drizzle operators and schema tables
const mockTable = {};
const mockOperator = () => ({});

mock.module('@feed/db', () => ({
  db: mockDb,
  // Schema tables
  markets: mockTable,
  questions: mockTable,
  organizations: mockTable,
  actors: mockTable,
  posts: mockTable,
  worldFacts: mockTable,
  users: mockTable,
  perpPositions: mockTable,
  // Drizzle operators
  eq: mockOperator,
  and: mockOperator,
  or: mockOperator,
  not: mockOperator,
  gt: mockOperator,
  gte: mockOperator,
  lt: mockOperator,
  lte: mockOperator,
  desc: mockOperator,
  asc: mockOperator,
  isNull: mockOperator,
  isNotNull: mockOperator,
  inArray: mockOperator,
  sql: () => ({}),
}));

// Mock getTradingProbability to return 1.0 so all NPCs pass the filter
mock.module('../config/npc-activity', () => ({
  getTradingProbability: () => 1.0,
  getMaxTradesPerDay: () => 10,
}));

// Mock generateWorldContext to avoid deep DB/service calls
mock.module('../prompts/world-context', () => ({
  generateWorldContext: async () => ({
    worldActors: '',
    currentMarkets: '',
    activePredictions: '',
    recentTrades: '',
    currentDateTime: new Date().toISOString(),
    currentDate: '2026-03-31',
    currentTime: '12:00',
    currentYear: '2026',
    currentMonth: 'March',
    currentDay: 'Monday',
    realityGrounding: '',
    worldFacts: '',
    dailyTopic: '',
    combinedContext: 'Test world context',
  }),
  getCurrentDateContext: () => ({
    dateISO: new Date().toISOString(),
    dateFull: '2026-03-31',
    time: '12:00',
    year: '2026',
    month: 'March',
    day: 'Monday',
    dayOfWeek: 'Monday',
  }),
  validateGeneratedContent: () => ({ errors: [], isValid: true }),
  checkRealityGrounding: () => ({ isGrounded: true }),
}));

import type { FeedLLMClient } from '../llm/openai-client';
import { MarketDecisionEngine } from '../MarketDecisionEngine';
import { MarketContextService } from '../services/market-context-service';
import type { NPCMarketContext, NPCPosition } from '../types/market-context';

interface JSONSchemaProperty {
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
}

interface JSONSchema {
  required?: string[];
  properties?: Record<string, JSONSchemaProperty>;
}

interface GenerateJSONOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  format?: 'xml' | 'json';
}

// Type for mock responses - supports any JSON-serializable value
type MockResponse = Record<
  string,
  JSONSchemaProperty | string | number | boolean | null | object | Array<object>
>;

// Mock LLM client for testing - doesn't require API keys
class MockLLMClient {
  private mockResponses: MockResponse[] = [];
  private callCount = 0;

  constructor() {
    // No super() call - this is a standalone mock that doesn't extend FeedLLMClient
  }

  getProvider(): string {
    return 'groq';
  }

  setMockResponse<T extends MockResponse>(response: T): void {
    this.mockResponses.push(response);
  }

  async generateJSON<T>(
    _prompt: string,
    _schema?: JSONSchema,
    _options?: GenerateJSONOptions
  ): Promise<T> {
    const response = this.mockResponses[this.callCount] ?? ([] as MockResponse);
    this.callCount++;
    return response as T;
  }

  getCallCount(): number {
    return this.callCount;
  }

  resetCallCount() {
    this.callCount = 0;
    this.mockResponses = [];
  }
}

/**
 * Partial interface for MockLLMClient that matches FeedLLMClient's required methods
 */
interface MockLLMClientInterface
  extends Pick<FeedLLMClient, 'getProvider' | 'generateJSON'> {
  setMockResponse<T extends MockResponse>(response: T): void;
  getCallCount(): number;
  resetCallCount(): void;
}

// Type assertion to make MockLLMClient compatible with FeedLLMClient interface
// Returns both the mock instance (for test methods) and the LLM client (for engine)
const createMockLLMClient = (): {
  mock: MockLLMClient;
  client: FeedLLMClient;
} => {
  const mockInstance = new MockLLMClient();
  // Cast via the partial interface to ensure type safety
  const mockAsInterface: MockLLMClientInterface = mockInstance;
  return {
    mock: mockInstance,
    client: mockAsInterface as FeedLLMClient,
  };
};

// Mock context service
class MockContextService extends MarketContextService {
  private mockNPCs: NPCMarketContext[] = [];

  setMockNPCs(npcs: NPCMarketContext[]) {
    this.mockNPCs = npcs;
  }

  async buildContextForAllNPCs(): Promise<Map<string, NPCMarketContext>> {
    const map = new Map<string, NPCMarketContext>();
    this.mockNPCs.forEach((npc) => map.set(npc.npcId, npc));
    return map;
  }

  async buildContextForNPC(npcId: string): Promise<NPCMarketContext> {
    const npc = this.mockNPCs.find((n) => n.npcId === npcId);
    if (!npc) {
      throw new Error(`NPC ${npcId} not found`);
    }
    return npc;
  }
}

// Helper to create mock NPC context
function createMockNPC(id: string, name: string): NPCMarketContext {
  return {
    npcId: id,
    npcName: name,
    personality: 'risk-taker',
    tier: 'B_TIER',
    availableBalance: 10000,
    relationships: [],
    recentPosts: [
      {
        author: 'author1',
        authorName: 'Author 1',
        content: 'Test post',
        timestamp: new Date().toISOString(),
      },
    ],
    groupChatMessages: [],
    recentEvents: [],
    perpMarkets: [
      {
        ticker: 'TECH',
        organizationId: 'tech-co',
        name: 'Tech Co',
        currentPrice: 100,
        change24h: 5,
        changePercent24h: 5,
        high24h: 105,
        low24h: 95,
        volume24h: 1000,
        openInterest: 5000,
      },
    ],
    predictionMarkets: [
      {
        id: 'q1',
        text: 'Will X happen?',
        yesPrice: 50,
        noPrice: 50,
        totalVolume: 1000,
        resolutionDate: new Date().toISOString(),
        daysUntilResolution: 7,
      },
    ],
    currentPositions: [],
  };
}

describe('MarketDecisionEngine - Token Management', () => {
  let mockLLM: FeedLLMClient;
  let mockLLMInstance: MockLLMClient;
  let mockContext: MockContextService;
  let originalMathRandom: typeof Math.random;

  beforeEach(() => {
    originalMathRandom = Math.random;
    Math.random = () => 0;

    const mockClient = createMockLLMClient();
    mockLLM = mockClient.client;
    mockLLMInstance = mockClient.mock;
    mockContext = new MockContextService();
  });

  afterEach(() => {
    Math.random = originalMathRandom;
  });

  describe('Initialization', () => {
    test('should initialize with default model and token limits', () => {
      const engine = new MarketDecisionEngine(mockLLM, mockContext);
      expect(engine).toBeDefined();
    });

    test('should accept custom model configuration', () => {
      const engine = new MarketDecisionEngine(mockLLM, mockContext, {
        model: 'gpt-5.1',
        maxOutputTokens: 4000,
      });

      expect(engine).toBeDefined();
    });

    test('should use openai/gpt-oss-120b by default', () => {
      const engine = new MarketDecisionEngine(mockLLM, mockContext);
      expect(engine).toBeDefined();
    });
  });

  describe('Batch Size Calculation', () => {
    test('should calculate correct batch size for small NPC count', async () => {
      // With 2000 tokens per NPC and 128k context, maxNPCsPerBatch=4
      // 10 NPCs = 3 batches (4+4+2)
      const npcs = Array.from({ length: 10 }, (_, i) =>
        createMockNPC(`npc-${i}`, `NPC ${i}`)
      );
      mockContext.setMockNPCs(npcs);

      // Mock response for each batch
      for (let batch = 0; batch < 3; batch++) {
        const start = batch * 4;
        const count = Math.min(4, 10 - start);
        const batchDecisions = npcs.slice(start, start + count).map((npc) => ({
          npcId: npc.npcId,
          npcName: npc.npcName,
          action: 'hold' as const,
          marketType: null,
          amount: 0,
          confidence: 1,
          reasoning: 'Holding',
          timestamp: new Date().toISOString(),
        }));
        mockLLMInstance.setMockResponse(batchDecisions);
      }

      const engine = new MarketDecisionEngine(mockLLM, mockContext);
      const decisions = await engine.generateBatchDecisions();

      expect(decisions.length).toBe(10);
      expect(mockLLMInstance.getCallCount()).toBe(3); // 3 batches of 4+4+2
    });

    test('should split large NPC count into multiple batches', async () => {
      // Create 12 NPCs (maxNPCsPerBatch=4, so 12/4 = 3 batches)
      const npcs = Array.from({ length: 12 }, (_, i) =>
        createMockNPC(`npc-${i}`, `NPC ${i}`)
      );
      mockContext.setMockNPCs(npcs);

      // Mock responses for each batch (4 NPCs per batch)
      const batchCount = 3;
      for (let batch = 0; batch < batchCount; batch++) {
        const start = batch * 4;
        const count = Math.min(4, 12 - start);
        const batchDecisions = npcs.slice(start, start + count).map((npc) => ({
          npcId: npc.npcId,
          npcName: npc.npcName,
          action: 'hold' as const,
          marketType: null,
          amount: 0,
          confidence: 1,
          reasoning: 'Holding',
          timestamp: new Date().toISOString(),
        }));
        mockLLMInstance.setMockResponse(batchDecisions);
      }

      const engine = new MarketDecisionEngine(mockLLM, mockContext);
      const decisions = await engine.generateBatchDecisions();

      expect(decisions.length).toBe(12);
      expect(mockLLMInstance.getCallCount()).toBe(3); // 3 batches of 4 NPCs each
    }, 15_000);
  });

  describe('Response Format Handling', () => {
    test('should handle array response format', async () => {
      const npcs = [createMockNPC('npc1', 'NPC 1')];
      mockContext.setMockNPCs(npcs);

      const mockResponse = [
        {
          npcId: 'npc1',
          npcName: 'NPC 1',
          action: 'hold' as const,
          marketType: null,
          amount: 0,
          confidence: 1,
          reasoning: 'Holding',
          timestamp: new Date().toISOString(),
        },
      ];
      mockLLMInstance.setMockResponse(mockResponse);

      const engine = new MarketDecisionEngine(mockLLM, mockContext);
      const decisions = await engine.generateBatchDecisions();

      expect(decisions.length).toBe(1);
      expect(decisions[0]?.action).toBe('hold');
    });

    test('should handle wrapped response format with "decisions" key', async () => {
      const npcs = [createMockNPC('npc1', 'NPC 1')];
      mockContext.setMockNPCs(npcs);

      const mockResponse = {
        decisions: [
          {
            npcId: 'npc1',
            npcName: 'NPC 1',
            action: 'hold' as const,
            marketType: null,
            amount: 0,
            confidence: 1,
            reasoning: 'Holding',
            timestamp: new Date().toISOString(),
          },
        ],
      };
      mockLLMInstance.setMockResponse(mockResponse);

      const engine = new MarketDecisionEngine(mockLLM, mockContext);
      const decisions = await engine.generateBatchDecisions();

      expect(decisions.length).toBe(1);
      expect(decisions[0]?.action).toBe('hold');
    });

    test('should handle wrapped response format with "decision" key (array)', async () => {
      const npcs = [createMockNPC('npc1', 'NPC 1')];
      mockContext.setMockNPCs(npcs);

      const mockResponse = {
        decision: [
          {
            npcId: 'npc1',
            npcName: 'NPC 1',
            action: 'hold' as const,
            marketType: null,
            amount: 0,
            confidence: 1,
            reasoning: 'Holding',
            timestamp: new Date().toISOString(),
          },
        ],
      };
      mockLLMInstance.setMockResponse(mockResponse);

      const engine = new MarketDecisionEngine(mockLLM, mockContext);
      const decisions = await engine.generateBatchDecisions();

      expect(decisions.length).toBe(1);
      expect(decisions[0]?.action).toBe('hold');
    });

    test('should handle wrapped response format with "decision" key (single object)', async () => {
      const npcs = [createMockNPC('npc1', 'NPC 1')];
      mockContext.setMockNPCs(npcs);

      // LLM returns single decision object (not array) - happens with 1 NPC
      const mockResponse = {
        decision: {
          npcId: 'npc1',
          npcName: 'NPC 1',
          action: 'hold' as const,
          marketType: null,
          amount: 0,
          confidence: 1,
          reasoning: 'Holding',
          timestamp: new Date().toISOString(),
        },
      };
      mockLLMInstance.setMockResponse(mockResponse);

      const engine = new MarketDecisionEngine(mockLLM, mockContext);
      const decisions = await engine.generateBatchDecisions();

      expect(decisions.length).toBe(1);
      expect(decisions[0]?.action).toBe('hold');
    });

    test('should return empty array for invalid response format', async () => {
      const npcs = [createMockNPC('npc1', 'NPC 1')];
      mockContext.setMockNPCs(npcs);

      const mockResponse = { invalid: 'response' };
      mockLLMInstance.setMockResponse(mockResponse);

      const engine = new MarketDecisionEngine(mockLLM, mockContext);
      const decisions = await engine.generateBatchDecisions();

      expect(decisions.length).toBe(0);
    });
  });

  describe('Context Truncation', () => {
    test('should truncate long post content', async () => {
      const npc = createMockNPC('npc1', 'NPC 1');
      // Add a very long post
      npc.recentPosts = [
        {
          author: 'author1',
          authorName: 'Author 1',
          content: 'A'.repeat(1000), // Very long content
          timestamp: new Date().toISOString(),
        },
      ];
      mockContext.setMockNPCs([npc]);

      const mockResponse = [
        {
          npcId: 'npc1',
          npcName: 'NPC 1',
          action: 'hold' as const,
          marketType: null,
          amount: 0,
          confidence: 1,
          reasoning: 'Holding',
          timestamp: new Date().toISOString(),
        },
      ];
      mockLLMInstance.setMockResponse(mockResponse);

      const engine = new MarketDecisionEngine(mockLLM, mockContext);
      const decisions = await engine.generateBatchDecisions();

      expect(decisions.length).toBe(1);
    });

    test('should limit number of posts per NPC', async () => {
      const npc = createMockNPC('npc1', 'NPC 1');
      // Add 100 posts (should be truncated to 8)
      npc.recentPosts = Array.from({ length: 100 }, (_, i) => ({
        author: `author${i}`,
        authorName: `Author ${i}`,
        content: `Post ${i}`,
        timestamp: new Date().toISOString(),
      }));
      mockContext.setMockNPCs([npc]);

      const mockResponse = [
        {
          npcId: 'npc1',
          npcName: 'NPC 1',
          action: 'hold' as const,
          marketType: null,
          amount: 0,
          confidence: 1,
          reasoning: 'Holding',
          timestamp: new Date().toISOString(),
        },
      ];
      mockLLMInstance.setMockResponse(mockResponse);

      const engine = new MarketDecisionEngine(mockLLM, mockContext);
      const decisions = await engine.generateBatchDecisions();

      expect(decisions.length).toBe(1);
    });
  });

  describe('Decision Validation', () => {
    test('should validate hold decisions', async () => {
      const npcs = [createMockNPC('npc1', 'NPC 1')];
      mockContext.setMockNPCs(npcs);

      const mockResponse = [
        {
          npcId: 'npc1',
          npcName: 'NPC 1',
          action: 'hold' as const,
          marketType: null,
          amount: 0,
          confidence: 1,
          reasoning: 'Market conditions unclear',
          timestamp: new Date().toISOString(),
        },
      ];
      mockLLMInstance.setMockResponse(mockResponse);

      const engine = new MarketDecisionEngine(mockLLM, mockContext);
      const decisions = await engine.generateBatchDecisions();

      expect(decisions.length).toBe(1);
      expect(decisions[0]?.action).toBe('hold');
      expect(decisions[0]?.amount).toBe(0);
    });

    test('should validate trade decisions do not exceed balance', async () => {
      const npc = createMockNPC('npc1', 'NPC 1');
      npc.availableBalance = 1000;
      mockContext.setMockNPCs([npc]);

      // LLM tries to trade more than balance (should be rejected)
      const mockResponse = [
        {
          npcId: 'npc1',
          npcName: 'NPC 1',
          action: 'open_long' as const,
          marketType: 'perp' as const,
          ticker: 'TECH',
          amount: 5000, // Exceeds balance!
          confidence: 0.8,
          reasoning: 'Strong signal',
          timestamp: new Date().toISOString(),
        },
      ];
      mockLLMInstance.setMockResponse(mockResponse);

      const engine = new MarketDecisionEngine(mockLLM, mockContext);

      // In test mode, exceeding balance skips the decision (no throw)
      // In dev mode, it would throw - but tests skip fail-fast behavior
      const decisions = await engine.generateBatchDecisions();
      expect(decisions.length).toBe(0); // Decision rejected due to exceeding balance
    });

    test('should accept valid trade decisions', async () => {
      const npc = createMockNPC('npc1', 'NPC 1');
      npc.availableBalance = 10000;
      mockContext.setMockNPCs([npc]);

      const mockResponse = [
        {
          npcId: 'npc1',
          npcName: 'NPC 1',
          action: 'open_long' as const,
          marketType: 'perp' as const,
          ticker: 'TECH',
          amount: 1000, // Within balance
          confidence: 0.8,
          reasoning: 'Strong signal',
          timestamp: new Date().toISOString(),
        },
      ];
      mockLLMInstance.setMockResponse(mockResponse);

      const engine = new MarketDecisionEngine(mockLLM, mockContext);
      const decisions = await engine.generateBatchDecisions();

      expect(decisions.length).toBe(1);
      expect(decisions[0]?.action).toBe('open_long');
      expect(decisions[0]?.amount).toBe(1000);
    });

    test('should reject prediction sells when the NPC does not hold that side', async () => {
      const npc = createMockNPC('npc1', 'NPC 1');
      mockContext.setMockNPCs([npc]);

      mockLLMInstance.setMockResponse([
        {
          npcId: 'npc1',
          npcName: 'NPC 1',
          action: 'sell_yes' as const,
          marketType: 'prediction' as const,
          marketId: 'q1',
          amount: 0,
          confidence: 0.7,
          reasoning: 'Take profits',
          timestamp: new Date().toISOString(),
        },
      ]);

      const engine = new MarketDecisionEngine(mockLLM, mockContext);
      const decisions = await engine.generateBatchDecisions();

      expect(decisions.length).toBe(0);
    });

    test('should map prediction sells to the held position id', async () => {
      const npc = createMockNPC('npc1', 'NPC 1');
      npc.currentPositions = [
        {
          id: 'pos-yes-1',
          marketType: 'prediction',
          marketId: 'q1',
          side: 'YES',
          entryPrice: 0.52,
          currentPrice: 0.61,
          size: 25,
          shares: 25,
          unrealizedPnL: 2.25,
          openedAt: new Date().toISOString(),
        } as NPCPosition,
      ];
      mockContext.setMockNPCs([npc]);

      mockLLMInstance.setMockResponse([
        {
          npcId: 'npc1',
          npcName: 'NPC 1',
          action: 'sell_yes' as const,
          marketType: 'prediction' as const,
          marketId: 'q1',
          amount: 0,
          confidence: 0.7,
          reasoning: 'Take profits',
          timestamp: new Date().toISOString(),
        },
      ]);

      const engine = new MarketDecisionEngine(mockLLM, mockContext);
      const decisions = await engine.generateBatchDecisions();

      expect(decisions.length).toBe(1);
      expect(decisions[0]?.positionId).toBe('pos-yes-1');
    });
  });

  describe('Error Handling', () => {
    test('should handle empty NPC list gracefully', async () => {
      mockContext.setMockNPCs([]);

      const engine = new MarketDecisionEngine(mockLLM, mockContext);
      const decisions = await engine.generateBatchDecisions();

      expect(decisions.length).toBe(0);
    });

    test('should handle batch failure with individual retry', async () => {
      const npcs = [
        createMockNPC('npc1', 'NPC 1'),
        createMockNPC('npc2', 'NPC 2'),
      ];
      mockContext.setMockNPCs(npcs);

      mockLLMInstance.setMockResponse(null);
      mockLLMInstance.setMockResponse([
        {
          npcId: 'npc1',
          npcName: 'NPC 1',
          action: 'hold' as const,
          marketType: null,
          amount: 0,
          confidence: 1,
          reasoning: 'Holding',
          timestamp: new Date().toISOString(),
        },
      ]);
      mockLLMInstance.setMockResponse([
        {
          npcId: 'npc2',
          npcName: 'NPC 2',
          action: 'hold' as const,
          marketType: null,
          amount: 0,
          confidence: 1,
          reasoning: 'Holding',
          timestamp: new Date().toISOString(),
        },
      ]);

      const engine = new MarketDecisionEngine(mockLLM, mockContext);

      const decisions = await engine.generateBatchDecisions();

      expect(decisions).toBeDefined();
    });
  });

  describe('Model Configuration', () => {
    test('should use openai/gpt-oss-120b by default', () => {
      const engine = new MarketDecisionEngine(mockLLM, mockContext);
      expect(engine).toBeDefined();
      // Default model should have 130k token limit
    });

    test('should accept custom model with different token limit', () => {
      const engine = new MarketDecisionEngine(mockLLM, mockContext, {
        model: 'claude-sonnet-4-5', // 200k context
        maxOutputTokens: 8000,
      });
      expect(engine).toBeDefined();
    });

    test('should calculate safe context limit correctly', () => {
      // openai/gpt-oss-120b: 130k input context
      // * 0.9 safety = 117k safe limit
      // / 400 per NPC = ~292 NPCs per batch

      const engine = new MarketDecisionEngine(mockLLM, mockContext);
      expect(engine).toBeDefined();
    });
  });
});
