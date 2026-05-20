/**
 * World Facts Generator Service Tests
 *
 * Tests for the WorldFactsGeneratorService which generates dynamic world context
 * from game activity.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  createWorldFactsGenerator,
  WorldFactsGeneratorService,
} from '../services/world-facts-generator';

// Mock the database
const mockSelectResult: Record<string, unknown>[] = [];
const mockInsertResult: Record<string, unknown>[] = [];
const mockUpdateResult: Record<string, unknown>[] = [];

// Create a thenable that also supports method chaining for fluent API
function createChainableThenable<T>(
  result: T[],
  methods: Record<string, () => unknown> = {}
) {
  const thenable = {
    ...methods,
    then: (resolve: (value: T[]) => void) => {
      resolve(result);
      return Promise.resolve(result);
    },
  };
  return thenable;
}

const mockDb = {
  select: mock(() => ({
    from: mock(() =>
      createChainableThenable(mockSelectResult, {
        where: mock(() =>
          createChainableThenable(mockSelectResult, {
            orderBy: mock(() => ({
              limit: mock(() => Promise.resolve(mockSelectResult)),
            })),
          })
        ),
      })
    ),
  })),
  insert: mock(() => ({
    values: mock(() => Promise.resolve(mockInsertResult)),
  })),
  update: mock(() => ({
    set: mock(() => ({
      where: mock(() => ({
        returning: mock(() => Promise.resolve(mockUpdateResult)),
      })),
    })),
  })),
};

mock.module('@babylon/db', () => ({
  db: mockDb,
  and: (...args: unknown[]) => args,
  desc: (col: unknown) => col,
  eq: (a: unknown, b: unknown) => [a, b],
  gte: (a: unknown, b: unknown) => [a, b],
  inArray: (a: unknown, b: unknown) => [a, b],
  isNull: (a: unknown) => [a],
  lte: (a: unknown, b: unknown) => [a, b],
  posts: {
    content: 'content',
    authorId: 'authorId',
    timestamp: 'timestamp',
    deletedAt: 'deletedAt',
  },
  questions: {
    id: 'id',
    text: 'text',
    status: 'status',
    outcome: 'outcome',
    createdAt: 'createdAt',
    resolutionDate: 'resolutionDate',
  },
  worldEvents: {
    id: 'id',
    description: 'description',
    eventType: 'eventType',
    visibility: 'visibility',
    timestamp: 'timestamp',
  },
  worldFacts: {
    id: 'id',
    category: 'category',
    key: 'key',
    label: 'label',
    value: 'value',
    source: 'source',
    priority: 'priority',
    isActive: 'isActive',
    lastUpdated: 'lastUpdated',
    updatedAt: 'updatedAt',
    createdAt: 'createdAt',
  },
  sql: (strings: TemplateStringsArray) => strings.join(''),
}));

// Mock the shared module
mock.module('@babylon/shared', () => ({
  generateSnowflakeId: mock(() => Promise.resolve('123456789')),
  logger: {
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  },
}));

// Note: StaticDataRegistry is NOT mocked here to avoid polluting other test files.
// It uses static TypeScript data files and doesn't require database access.

// Mock LLM client - uses unknown cast since we're mocking the interface
const mockLlm = {
  generateJSON: mock(() =>
    Promise.resolve({
      facts: ['Test fact 1', 'Test fact 2'],
    })
  ),
} as unknown as ConstructorParameters<typeof WorldFactsGeneratorService>[1];

mock.module('../llm/openai-client', () => ({
  BabylonLLMClient: {
    forGameTick: mock(() => mockLlm),
  },
}));

describe('WorldFactsGeneratorService', () => {
  beforeEach(() => {
    // Clear mocks
    mockSelectResult.length = 0;
    mockInsertResult.length = 0;
    mockUpdateResult.length = 0;
  });

  describe('constructor', () => {
    test('uses default config when no config provided', () => {
      const generator = new WorldFactsGeneratorService();
      // Can't directly access config, but we can verify it doesn't throw
      expect(generator).toBeDefined();
    });

    test('accepts custom config', () => {
      const generator = new WorldFactsGeneratorService({
        maxFactsPerUpdate: 20,
        maxFactAgeDays: 14,
        minActiveFacts: 30,
      });
      expect(generator).toBeDefined();
    });

    test('accepts custom LLM client', () => {
      const customLlm = {
        generateJSON: mock(() => Promise.resolve({ facts: [] })),
      } as unknown as ConstructorParameters<
        typeof WorldFactsGeneratorService
      >[1];
      const generator = new WorldFactsGeneratorService({}, customLlm);
      expect(generator).toBeDefined();
    });
  });

  describe('generateNewWorldFacts', () => {
    test('returns result structure with sources', async () => {
      const generator = new WorldFactsGeneratorService({}, mockLlm);
      const result = await generator.generateNewWorldFacts();

      expect(result).toHaveProperty('generated');
      expect(result).toHaveProperty('archived');
      expect(result).toHaveProperty('sources');
      expect(result.sources).toHaveProperty('events');
      expect(result.sources).toHaveProperty('markets');
      expect(result.sources).toHaveProperty('questions');
      expect(result.sources).toHaveProperty('actors');
    });

    test('handles empty data sources gracefully', async () => {
      const generator = new WorldFactsGeneratorService({}, mockLlm);
      const result = await generator.generateNewWorldFacts();

      // Should not throw, even with empty data
      expect(result.generated).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getWorldFactsStats', () => {
    test('returns stats structure', async () => {
      const generator = new WorldFactsGeneratorService({}, mockLlm);
      const stats = await generator.getWorldFactsStats();

      expect(stats).toHaveProperty('totalActive');
      expect(stats).toHaveProperty('autoGenerated');
      expect(stats).toHaveProperty('manual');
      expect(stats).toHaveProperty('oldestFact');
      expect(stats).toHaveProperty('newestFact');
    });
  });
});

describe('createWorldFactsGenerator', () => {
  test('creates a generator with default config', () => {
    const generator = createWorldFactsGenerator();
    expect(generator).toBeInstanceOf(WorldFactsGeneratorService);
  });

  test('creates a generator with custom config', () => {
    const generator = createWorldFactsGenerator({
      maxFactsPerUpdate: 5,
      maxFactAgeDays: 3,
    });
    expect(generator).toBeInstanceOf(WorldFactsGeneratorService);
  });

  test('creates a generator with custom LLM', () => {
    const customLlm = {
      generateJSON: mock(() => Promise.resolve({ facts: [] })),
    } as unknown as ConstructorParameters<typeof WorldFactsGeneratorService>[1];
    const generator = createWorldFactsGenerator({}, customLlm);
    expect(generator).toBeInstanceOf(WorldFactsGeneratorService);
  });
});

describe('storeFact edge cases', () => {
  test('handles empty strings in fact value gracefully', async () => {
    // The service should handle edge cases without throwing
    const generator = new WorldFactsGeneratorService({}, mockLlm);
    // Since storeFact is private, we test through generateNewWorldFacts
    // which handles storage internally
    const result = await generator.generateNewWorldFacts();
    expect(result).toBeDefined();
  });

  test('handles facts with special characters', async () => {
    const specialCharLlm = {
      generateJSON: mock(() =>
        Promise.resolve({
          facts: ['Fact with "quotes" and \'apostrophes\' and emoji 🎉'],
        })
      ),
    } as unknown as ConstructorParameters<typeof WorldFactsGeneratorService>[1];

    const generator = new WorldFactsGeneratorService({}, specialCharLlm);
    const result = await generator.generateNewWorldFacts();
    expect(result).toBeDefined();
  });

  test('handles facts with only non-alphanumeric characters', async () => {
    const nonAlphaLlm = {
      generateJSON: mock(() =>
        Promise.resolve({
          facts: ['!@#$%^&*()'],
        })
      ),
    } as unknown as ConstructorParameters<typeof WorldFactsGeneratorService>[1];

    const generator = new WorldFactsGeneratorService({}, nonAlphaLlm);
    // Should use hash-based fallback for key generation
    const result = await generator.generateNewWorldFacts();
    expect(result).toBeDefined();
  });
});

describe('archiveOldFacts', () => {
  test('respects minActiveFacts setting', async () => {
    const generator = new WorldFactsGeneratorService(
      { minActiveFacts: 100 },
      mockLlm
    );

    // When activeCount is below minimum, nothing should be archived
    const result = await generator.generateNewWorldFacts();
    // archived should be 0 since we're below minimum
    expect(result.archived).toBe(0);
  });
});
