/**
 * Parody Headline Generator Integration Tests
 *
 * Tests the ParodyHeadlineGenerator service with real database operations.
 * Uses the Drizzle-based Prisma-like API (db.rssHeadline.create(), etc.)
 *
 * Requires PostgreSQL to be running.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test';
import { db, rssFeedSources } from '@babylon/db';
import type { BabylonLLMClient } from '@babylon/engine';
import { ParodyHeadlineGenerator } from '@babylon/engine';
import { generateSnowflakeId } from '@babylon/shared';

// Skip tests if DATABASE_URL is not set
const shouldSkip = !process.env.DATABASE_URL;
const describeTests = shouldSkip ? describe.skip : describe;

describeTests('ParodyHeadlineGenerator', () => {
  let dbAvailable = true;

  beforeAll(async () => {
    // Verify database connectivity
    try {
      await db.select().from(rssFeedSources).limit(1);
    } catch (error) {
      const msg = (error as Error).message ?? '';
      if (msg.includes('ECONNREFUSED') || msg.includes('connect')) {
        console.error('❌ Database not available - tests will be skipped');
        dbAvailable = false;
        return;
      }
      throw error;
    }
  });
  const testFeedId = 'test-feed-parody-' + Date.now();
  const testHeadlineId = 'test-headline-parody-' + Date.now();

  // Mock LLM client that doesn't require API keys
  // Returns XML-parsed format (nested response structure)
  // Uses type assertion to satisfy BabylonLLMClient interface while allowing mock functions
  function createMockLLMClient(): BabylonLLMClient {
    // Define mock without type checking, then cast at return
    // This is necessary because bun:test mock() has incompatible types with the actual interface
    const generateJSONMock = mock(async () => ({
      response: {
        parodyTitle:
          'AIlon Musk announces revolutionary new Tesla AI product that will change everything',
        parodyContent:
          'In a stunning move that shocked absolutely no one, AIlon Musk unveiled yet another "revolutionary" product that promises to solve all of humanity\'s problems while simultaneously creating new ones.',
      },
    }));
    const getProviderMock = () => 'test';

    // Build the mock object with explicit unknown cast per property
    return {
      generateJSON: generateJSONMock as BabylonLLMClient['generateJSON'],
      getProvider: getProviderMock as BabylonLLMClient['getProvider'],
    } as BabylonLLMClient;
  }

  beforeEach(async () => {
    if (!dbAvailable) return;
    // Create test feed source
    await db.rssFeedSource.create({
      data: {
        id: testFeedId,
        name: 'Test Parody Feed',
        feedUrl: 'https://example.com/test-parody.xml',
        category: 'test',
        isActive: false,
        updatedAt: new Date(),
      },
    });

    // Create test headline
    await db.rssHeadline.create({
      data: {
        id: testHeadlineId,
        sourceId: testFeedId,
        title: 'Elon Musk announces new Tesla product',
        summary: 'Tesla CEO Elon Musk unveiled a new electric vehicle today.',
        publishedAt: new Date(),
        fetchedAt: new Date(),
      },
    });
  });

  afterEach(async () => {
    if (!dbAvailable) return;
    // Cleanup parodies first (foreign key constraint)
    await db.parodyHeadline.deleteMany({
      where: {
        originalHeadlineId: testHeadlineId,
      },
    });

    // Then cleanup headlines
    await db.rssHeadline.deleteMany({
      where: {
        id: testHeadlineId,
      },
    });

    // Finally cleanup feed sources
    await db.rssFeedSource.deleteMany({
      where: {
        id: testFeedId,
      },
    });
  });

  test('should generate parody from headline', async () => {
    if (!dbAvailable) {
      console.log('⏭️  Skipping - database not available');
      return;
    }
    const mockLLM = createMockLLMClient();
    const generator = new ParodyHeadlineGenerator(mockLLM);

    const parody = await generator.generateParody(
      'Elon Musk announces new Tesla product',
      'Tesla CEO Elon Musk unveiled a new electric vehicle today.',
      'Test News'
    );

    expect(parody).toBeDefined();
    expect(parody.parodyTitle).toBeDefined();
    expect(typeof parody.parodyTitle).toBe('string');
    expect(parody.parodyTitle.length).toBeGreaterThan(0);

    // Should replace Elon Musk with parody name if character mapping exists
    expect(parody.characterMappings).toBeDefined();
    expect(typeof parody.characterMappings).toBe('object');

    expect(parody.organizationMappings).toBeDefined();
    expect(typeof parody.organizationMappings).toBe('object');
  });

  test('should process headlines into parodies', async () => {
    if (!dbAvailable) {
      console.log('⏭️  Skipping - database not available');
      return;
    }
    const mockLLM = createMockLLMClient();
    const generator = new ParodyHeadlineGenerator(mockLLM);

    const headlines = await db.rssHeadline.findMany({
      where: { id: testHeadlineId },
      include: { source: true },
    });

    expect(headlines).toHaveLength(1);

    const parodies = await generator.processHeadlines(headlines);

    expect(parodies).toBeDefined();
    expect(Array.isArray(parodies)).toBe(true);
    expect(parodies.length).toBeGreaterThan(0);

    const parody = parodies[0];
    expect(parody?.parodyTitle).toBeDefined();
    expect(parody?.originalTitle).toBe('Elon Musk announces new Tesla product');
  });

  test('should get recent parodies', async () => {
    if (!dbAvailable) {
      console.log('⏭️  Skipping - database not available');
      return;
    }
    const mockLLM = createMockLLMClient();
    const generator = new ParodyHeadlineGenerator(mockLLM);

    // First create a parody
    await db.parodyHeadline.create({
      data: {
        id: await generateSnowflakeId(),
        originalHeadlineId: testHeadlineId,
        originalTitle: 'Test Headline',
        originalSource: 'Test Source',
        parodyTitle: 'Test Parody',
        characterMappings: {},
        organizationMappings: {},
        generatedAt: new Date(),
        isUsed: false,
      },
    });

    const parodies = await generator.getRecentParodies(10);

    expect(parodies).toBeDefined();
    expect(Array.isArray(parodies)).toBe(true);
    expect(parodies.some((p) => p.parodyTitle === 'Test Parody')).toBe(true);
  });

  test('should mark parodies as used', async () => {
    if (!dbAvailable) {
      console.log('⏭️  Skipping - database not available');
      return;
    }
    const mockLLM = createMockLLMClient();
    const generator = new ParodyHeadlineGenerator(mockLLM);

    // Create a parody
    const parodyId = await generateSnowflakeId();
    await db.parodyHeadline.create({
      data: {
        id: parodyId,
        originalHeadlineId: testHeadlineId,
        originalTitle: 'Test Headline',
        originalSource: 'Test Source',
        parodyTitle: 'Test Parody To Mark',
        characterMappings: {},
        organizationMappings: {},
        generatedAt: new Date(),
        isUsed: false,
      },
    });

    // Mark as used
    await generator.markAsUsed([parodyId]);

    // Verify it's marked
    const updated = await db.parodyHeadline.findUnique({
      where: { id: parodyId },
    });

    expect(updated?.isUsed).toBe(true);
    expect(updated?.usedAt).toBeDefined();
  });

  test('should generate daily summary', async () => {
    if (!dbAvailable) {
      console.log('⏭️  Skipping - database not available');
      return;
    }
    const mockLLM = createMockLLMClient();
    const generator = new ParodyHeadlineGenerator(mockLLM);

    // Create multiple test headlines and parodies (each needs unique originalHeadlineId)
    const headlineIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const hId = await generateSnowflakeId();
      headlineIds.push(hId);

      // Create unique headline
      await db.rssHeadline.create({
        data: {
          id: hId,
          sourceId: testFeedId,
          title: `Test Headline ${i}`,
          publishedAt: new Date(),
          fetchedAt: new Date(),
        },
      });

      // Create parody for it
      await db.parodyHeadline.create({
        data: {
          id: await generateSnowflakeId(),
          originalHeadlineId: hId,
          originalTitle: `Test Headline ${i}`,
          originalSource: 'Test Source',
          parodyTitle: `Test Parody ${i}`,
          characterMappings: {},
          organizationMappings: {},
          generatedAt: new Date(),
          isUsed: false,
        },
      });
    }

    const summary = await generator.generateDailySummary();

    expect(summary).toBeDefined();
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).toContain('NEWS FROM THE LAST 7 DAYS');

    // Cleanup additional test data
    await db.parodyHeadline.deleteMany({
      where: { originalHeadlineId: { in: headlineIds } },
    });
    await db.rssHeadline.deleteMany({
      where: { id: { in: headlineIds } },
    });
  });

  test('should handle empty headlines gracefully', async () => {
    if (!dbAvailable) {
      console.log('⏭️  Skipping - database not available');
      return;
    }
    const mockLLM = createMockLLMClient();
    const generator = new ParodyHeadlineGenerator(mockLLM);

    const parodies = await generator.processHeadlines([]);

    expect(parodies).toBeDefined();
    expect(Array.isArray(parodies)).toBe(true);
    expect(parodies).toHaveLength(0);
  });
});
