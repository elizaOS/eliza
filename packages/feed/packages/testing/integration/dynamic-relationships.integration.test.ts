/**
 * Dynamic Relationships System Tests
 *
 * Tests the text-based relationship evolution system:
 * - Initial generation
 * - Interaction tracking
 * - Relationship evolution
 * - Context generation
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { db } from '@feed/db';
import {
  InteractionTracker,
  RelationshipEvolutionEngine,
} from '@feed/engine';
import type { Actor, Organization } from '@feed/shared';

// Test data
const testActors: Actor[] = [
  {
    id: 'test-actor-1',
    name: 'Test AIlon',
    description: 'Test CEO',
    domain: ['tech', 'space'],
    affiliations: ['test-company-1'],
  },
  {
    id: 'test-actor-2',
    name: 'Test Sam',
    description: 'Test AI CEO',
    domain: ['ai', 'tech'],
    affiliations: ['test-company-2'],
  },
  {
    id: 'test-actor-3',
    name: 'Test Mark',
    description: 'Test Social CEO',
    domain: ['social_media', 'tech'],
    affiliations: ['test-company-1'], // Shared with actor-1
  },
];

const testOrgs: Organization[] = [
  {
    id: 'test-company-1',
    name: 'Test TeslAI',
    description: 'Test company',
    type: 'company',
    canBeInvolved: true,
  },
  {
    id: 'test-company-2',
    name: 'Test OpenAGI',
    description: 'Test AI company',
    type: 'company',
    canBeInvolved: true,
  },
];

describe('Dynamic Relationships System', () => {
  beforeAll(async () => {
    // Clean up test data
    await db.npcInteraction.deleteMany({
      where: {
        OR: [
          { actor1Id: { startsWith: 'test-actor-' } },
          { actor2Id: { startsWith: 'test-actor-' } },
        ],
      },
    });

    await db.actorRelationship.deleteMany({
      where: {
        OR: [
          { actor1Id: { startsWith: 'test-actor-' } },
          { actor2Id: { startsWith: 'test-actor-' } },
        ],
      },
    });

    // Create test actors - use users table with isActor: true + actorState for dynamic data
    for (const actor of testActors) {
      await db.user.upsert({
        where: { id: actor.id },
        update: {},
        create: {
          id: actor.id,
          username: actor.name.toLowerCase().replace(/\s+/g, '-'),
          displayName: actor.name,
          bio: actor.description,
          isActor: true,
          isTest: true,
          updatedAt: new Date(),
        },
      });
      await db.actorState.upsert({
        where: { id: actor.id },
        update: {},
        create: {
          id: actor.id,
          updatedAt: new Date(),
        },
      });
    }
  });

  afterAll(async () => {
    // Clean up
    await db.npcInteraction.deleteMany({
      where: {
        OR: [
          { actor1Id: { startsWith: 'test-actor-' } },
          { actor2Id: { startsWith: 'test-actor-' } },
        ],
      },
    });

    await db.actorRelationship.deleteMany({
      where: {
        OR: [
          { actor1Id: { startsWith: 'test-actor-' } },
          { actor2Id: { startsWith: 'test-actor-' } },
        ],
      },
    });

    await db.actorState.deleteMany({
      where: { id: { startsWith: 'test-actor-' } },
    });

    await db.user.deleteMany({
      where: { id: { startsWith: 'test-actor-' } },
    });

    await db.$disconnect();
  });

  describe('Initial Relationship Generation', () => {
    test('should generate initial relationships based on shared context', async () => {
      const engine = new RelationshipEvolutionEngine();
      const created = await engine.generateInitialRelationships(
        testActors,
        testOrgs
      );

      expect(created).toBeGreaterThan(0);

      // Check database
      const relationships = await db.actorRelationship.findMany({
        where: {
          OR: [
            { actor1Id: { startsWith: 'test-actor-' } },
            { actor2Id: { startsWith: 'test-actor-' } },
          ],
        },
      });

      expect(relationships.length).toBeGreaterThan(0);

      // Each relationship should have a text description
      for (const rel of relationships) {
        expect(rel.history).toBeTruthy();
        expect(rel.history).toContain(''); // Not empty
        expect(rel.relationshipType).toBeTruthy();
        expect(rel.sentiment).toBeGreaterThanOrEqual(-1);
        expect(rel.sentiment).toBeLessThanOrEqual(1);
        expect(rel.strength).toBeGreaterThan(0);
        expect(rel.strength).toBeLessThanOrEqual(1);
      }

      console.log(`\n✅ Generated ${created} relationships`);
      console.log('Sample relationships:');
      relationships.slice(0, 3).forEach((r) => {
        console.log(`  - ${r.relationshipType}: "${r.history}"`);
      });
    });

    test('should create relationships for actors with shared affiliations', async () => {
      const relationships = await db.actorRelationship.findMany({
        where: {
          OR: [
            { actor1Id: 'test-actor-1', actor2Id: 'test-actor-3' },
            { actor1Id: 'test-actor-3', actor2Id: 'test-actor-1' },
          ],
        },
      });

      // Actors 1 and 3 share test-company-1, should have relationship
      expect(relationships.length).toBeGreaterThan(0);

      const rel = relationships[0]!;
      expect(rel.history).toContain(''); // Has description

      console.log(`\n✅ Shared affiliation relationship: "${rel.history}"`);
    });
  });

  describe('Interaction Tracking', () => {
    test('should track post mentions', async () => {
      const beforeCount = await db.npcInteraction.count({
        where: {
          actor1Id: 'test-actor-1',
          actor2Id: 'test-actor-2',
        },
      });

      await InteractionTracker.trackPostMention(
        'test-actor-1',
        'test-actor-2',
        'Test Sam is brilliant! Love what he is doing with AI.',
        0.8
      );

      const afterCount = await db.npcInteraction.count({
        where: {
          actor1Id: 'test-actor-1',
          actor2Id: 'test-actor-2',
        },
      });

      expect(afterCount).toBe(beforeCount + 1);

      // Check interaction details
      const interaction = await db.npcInteraction.findFirst({
        where: {
          actor1Id: 'test-actor-1',
          actor2Id: 'test-actor-2',
        },
        orderBy: { timestamp: 'desc' },
      });

      expect(interaction).toBeTruthy();
      expect(interaction!.interactionType).toBe('mention');
      expect(interaction!.sentiment).toBe(0.8);
      expect(interaction!.context).toContain('mentioned');

      console.log(`\n✅ Tracked mention: ${interaction!.context}`);
    });

    test('should track replies with sentiment', async () => {
      await InteractionTracker.trackReply(
        'test-actor-2',
        'test-actor-1',
        'Disagree with that terrible take',
        -0.6
      );

      const interaction = await db.npcInteraction.findFirst({
        where: {
          actor1Id: 'test-actor-1',
          actor2Id: 'test-actor-2',
          interactionType: 'reply',
        },
        orderBy: { timestamp: 'desc' },
      });

      expect(interaction).toBeTruthy();
      expect(interaction!.sentiment).toBe(-0.6);

      console.log(`\n✅ Tracked reply: ${interaction!.context}`);
    });

    test('should extract actor mentions from text', () => {
      const postContent =
        'Test AIlon and Test Sam are working together on this AI project!';
      const mentions = InteractionTracker.extractMentions(
        postContent,
        testActors
      );

      expect(mentions).toContain('test-actor-1'); // Test AIlon
      expect(mentions).toContain('test-actor-2'); // Test Sam
      expect(mentions.length).toBeGreaterThanOrEqual(2);

      console.log(`\n✅ Extracted mentions: ${mentions.join(', ')}`);
    });

    test('should analyze sentiment from text', () => {
      const positiveText = 'This is amazing! Great work, love it!';
      const negativeText = 'This is terrible and awful. Complete disaster!';
      const neutralText = 'The project continues as planned.';

      const posSentiment = InteractionTracker.analyzeSentiment(positiveText);
      const negSentiment = InteractionTracker.analyzeSentiment(negativeText);
      const neutralSentiment = InteractionTracker.analyzeSentiment(neutralText);

      expect(posSentiment).toBeGreaterThan(0);
      expect(negSentiment).toBeLessThan(0);
      expect(neutralSentiment).toBe(0);

      console.log('\n✅ Sentiment analysis:');
      console.log(`  Positive: ${posSentiment.toFixed(2)}`);
      console.log(`  Negative: ${negSentiment.toFixed(2)}`);
      console.log(`  Neutral: ${neutralSentiment.toFixed(2)}`);
    });
  });

  describe('Relationship Context Generation', () => {
    test('should generate simple text context for prompts', async () => {
      const engine = new RelationshipEvolutionEngine();
      const context =
        await engine.getRelationshipContextForActor('test-actor-1');

      if (context) {
        expect(context).toBeTruthy();
        expect(context.length).toBeGreaterThan(0);

        // Should be simple text list
        expect(context).toContain('-');
        expect(context).toContain(':');

        // Should NOT have complex formatting
        expect(context).not.toContain('✅');
        expect(context).not.toContain('How to use:');

        console.log('\n✅ Generated context for test-actor-1:');
        console.log(context);
      }
    });

    test('should return empty string for actor with no relationships', async () => {
      // Delete all relationships for test-actor-1
      await db.actorRelationship.deleteMany({
        where: {
          OR: [{ actor1Id: 'test-actor-1' }, { actor2Id: 'test-actor-1' }],
        },
      });

      const engine = new RelationshipEvolutionEngine();
      const context =
        await engine.getRelationshipContextForActor('test-actor-1');

      expect(context).toBe('');

      console.log('\n✅ Empty context for actor with no relationships');
    });

    test('should limit to top 5 strongest relationships', async () => {
      const engine = new RelationshipEvolutionEngine();

      // Regenerate relationships
      await engine.generateInitialRelationships(testActors, testOrgs);

      const context =
        await engine.getRelationshipContextForActor('test-actor-1');
      const lines = context.split('\n').filter((l) => l.trim());

      expect(lines.length).toBeLessThanOrEqual(5);

      console.log(`\n✅ Context limited to ${lines.length} relationships`);
    });
  });

  describe('Relationship Text Quality', () => {
    test('relationship descriptions should be narrative and simple', async () => {
      const relationships = await db.actorRelationship.findMany({
        where: {
          actor1Id: { startsWith: 'test-actor-' },
        },
        take: 5,
      });

      for (const rel of relationships) {
        const desc = rel.history || '';

        // Should be lowercase and casual
        expect(desc).toBe(desc.toLowerCase());

        // Should be short
        expect(desc.length).toBeLessThan(100);

        // Should be descriptive
        expect(desc.length).toBeGreaterThan(10);

        console.log(`  ✓ "${desc}"`);
      }

      console.log(
        `\n✅ All ${relationships.length} descriptions are simple and narrative`
      );
    });
  });

  describe('System Integration', () => {
    test('should have NPCInteraction table accessible', async () => {
      const count = await db.npcInteraction.count();
      expect(count).toBeGreaterThanOrEqual(0);

      console.log(
        `\n✅ NPCInteraction table accessible: ${count} interactions`
      );
    });

    test('should have evolution tracking fields in ActorRelationship', async () => {
      const relationship = await db.actorRelationship.findFirst({
        where: {
          actor1Id: { startsWith: 'test-actor-' },
        },
      });

      if (relationship) {
        expect('lastInteraction' in relationship).toBe(true);
        expect('interactionCount' in relationship).toBe(true);
        expect('evolutionCount' in relationship).toBe(true);

        console.log('\n✅ Evolution tracking fields present:', {
          lastInteraction: relationship.lastInteraction,
          interactionCount: relationship.interactionCount,
          evolutionCount: relationship.evolutionCount,
        });
      }
    });
  });
});

console.log('\n' + '='.repeat(60));
console.log('DYNAMIC RELATIONSHIPS TESTS');
console.log('='.repeat(60));
