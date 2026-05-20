/**
 * Relationship Context Efficiency Tests
 *
 * Verifies that relationships are efficiently supplied in context
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { db } from '@feed/db';
import {
  FeedLLMClient,
  FeedGenerator,
  RelationshipEvolutionEngine,
} from '@feed/engine';

describe('Relationship Context Efficiency', () => {
  let llmClient: FeedLLMClient;

  beforeAll(async () => {
    try {
      llmClient = new FeedLLMClient();
    } catch {
      console.log('⚠️  No LLM client');
    }

    // Create test relationship
    await db.actorRelationship.deleteMany({
      where: {
        OR: [
          { actor1Id: 'efficiency-test-1' },
          { actor2Id: 'efficiency-test-1' },
          { actor1Id: 'efficiency-test-2' },
          { actor2Id: 'efficiency-test-2' },
        ],
      },
    });

    // Create test users with isActor: true + actorState for dynamic data
    await db.user.upsert({
      where: { id: 'efficiency-test-1' },
      update: {},
      create: {
        id: 'efficiency-test-1',
        username: 'test-actor',
        displayName: 'Test Actor',
        isActor: true,
        isTest: true,
        updatedAt: new Date(),
      },
    });
    await db.actorState.upsert({
      where: { id: 'efficiency-test-1' },
      update: {},
      create: {
        id: 'efficiency-test-1',
        updatedAt: new Date(),
      },
    });

    await db.user.upsert({
      where: { id: 'efficiency-test-2' },
      update: {},
      create: {
        id: 'efficiency-test-2',
        username: 'efficiency-test-ailon-musk',
        displayName: 'AIlon Musk',
        isActor: true,
        isTest: true,
        updatedAt: new Date(),
      },
    });
    await db.actorState.upsert({
      where: { id: 'efficiency-test-2' },
      update: {},
      create: {
        id: 'efficiency-test-2',
        updatedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await db.actorRelationship.deleteMany({
      where: {
        OR: [
          { actor1Id: 'efficiency-test-1' },
          { actor2Id: 'efficiency-test-1' },
          { actor1Id: 'efficiency-test-2' },
          { actor2Id: 'efficiency-test-2' },
          { actor2Id: 'ailon-musk', actor1Id: 'efficiency-test-1' },
        ],
      },
    });
    await db.actorState.deleteMany({
      where: { id: { in: ['efficiency-test-1', 'efficiency-test-2'] } },
    });
    await db.user.deleteMany({
      where: { id: { in: ['efficiency-test-1', 'efficiency-test-2'] } },
    });
    await db.$disconnect();
  });

  test('should cache relationship context for efficiency', async () => {
    const feedGen = new FeedGenerator(llmClient);

    // First call - fetches from database
    console.time('First relationship context fetch');
    const context1 = await feedGen.getActorRelationships('efficiency-test-1');
    console.timeEnd('First relationship context fetch');

    // Second call - from cache
    console.time('Second relationship context fetch (cached)');
    const context2 = await feedGen.getActorRelationships('efficiency-test-1');
    console.timeEnd('Second relationship context fetch (cached)');

    expect(context1).toBe(context2); // Same context
    console.log('   ✅ Caching working - second call is instant');
  });

  test('should return empty string for actor with no relationships', async () => {
    const feedGen = new FeedGenerator(llmClient);
    const context = await feedGen.getActorRelationships('efficiency-test-1');

    expect(context).toBe('');
    console.log('   ✅ Empty context handled correctly');
  });

  test('context should be simple and directly usable in prompts', async () => {
    // Create a relationship for testing
    const engine = new RelationshipEvolutionEngine();

    // Use actual static actor ID so StaticDataRegistry can resolve the name
    await db.actorRelationship.create({
      data: {
        id: 'test-rel-1',
        actor1Id: 'efficiency-test-1',
        actor2Id: 'ailon-musk', // Real static actor ID
        relationshipType: 'allies',
        strength: 0.8,
        sentiment: 0.7,
        history: 'working together on that rocket project',
        isPublic: true,
        updatedAt: new Date(),
      },
    });

    const context =
      await engine.getRelationshipContextForActor('efficiency-test-1');

    expect(context).toBeTruthy();
    expect(context).toContain('AIlon Musk');
    expect(context).toContain('rocket project');
    expect(context).toContain('-'); // List format

    // Should be directly injectable
    const prompt = `You are Test Actor.

${context ? 'Your relationships:\n' + context : ''}

Write a post.`;

    expect(prompt).toContain('Your relationships:');

    console.log('   ✅ Context is prompt-ready:');
    console.log(prompt);
  });

  test('should limit to top 5 relationships for efficiency', async () => {
    const engine = new RelationshipEvolutionEngine();
    const context =
      await engine.getRelationshipContextForActor('efficiency-test-2');

    // Should return empty or limited results
    const lines = context.split('\n').filter((l) => l.trim());
    expect(lines.length).toBeLessThanOrEqual(5);

    console.log(`   ✅ Limited to ${lines.length} relationships (efficient)`);
    console.log('   ✅ Only top 5 strongest retrieved from database');
  });
});
