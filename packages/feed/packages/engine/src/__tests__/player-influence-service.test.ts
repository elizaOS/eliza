/**
 * Player Influence Service Test Suite
 *
 * Tests for player → NPC influence mechanics:
 * - Player mentions boost NPC response probability
 * - Player trades add to NPC memory
 */

import { describe, expect, test } from 'bun:test';
import {
  extractMentions,
  playerInfluenceService,
  recordMention,
  wasMentionedRecentlySync,
} from '../services/player-influence-service';

describe('Player Influence Service - Mention Extraction', () => {
  test('extracts single mention', () => {
    const content = 'Hey @alice, what do you think?';
    const mentions = extractMentions(content);
    expect(mentions).toEqual(['alice']);
  });

  test('extracts multiple mentions', () => {
    const content = 'Both @alice and @bob should see this!';
    const mentions = extractMentions(content);
    expect(mentions).toEqual(['alice', 'bob']);
  });

  test('handles mentions with underscores and hyphens', () => {
    const content = 'Calling @john_doe and @jane-smith';
    const mentions = extractMentions(content);
    expect(mentions).toEqual(['john_doe', 'jane-smith']);
  });

  test('returns empty array for no mentions', () => {
    const content = 'This is a regular post without mentions';
    const mentions = extractMentions(content);
    expect(mentions).toEqual([]);
  });

  test('handles mentions at start and end', () => {
    const content = '@start mentions and ends with @end';
    const mentions = extractMentions(content);
    expect(mentions).toEqual(['start', 'end']);
  });

  test('ignores email-like patterns', () => {
    // Email addresses should not produce mentions - we require whitespace before @
    const content = 'Contact user@example.com for more';
    const mentions = extractMentions(content);
    expect(mentions).toEqual([]);
  });

  test('handles mixed content with emails and real mentions', () => {
    const content = 'Hey @alice, send to bob@example.com, also cc @charlie';
    const mentions = extractMentions(content);
    expect(mentions).toEqual(['alice', 'charlie']);
  });

  test('handles empty content', () => {
    const mentions = extractMentions('');
    expect(mentions).toEqual([]);
  });
});

describe('Player Influence Service - Synchronous Mention Check', () => {
  test('wasMentionedRecentlySync returns false for unknown actor', () => {
    const result = wasMentionedRecentlySync('non-existent-actor-12345');
    expect(result).toBe(false);
  });

  test('wasMentionedRecentlySync returns true after recording a mention', async () => {
    // Use a unique actor ID to avoid interference with other tests
    const testActorId = `test-actor-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Verify actor is not mentioned initially
    expect(wasMentionedRecentlySync(testActorId)).toBe(false);

    // Record a mention for this actor
    await recordMention(testActorId, new Date());

    // Now the actor should be detected as recently mentioned
    expect(wasMentionedRecentlySync(testActorId)).toBe(true);
  });

  test('wasMentionedRecentlySync works via service singleton', async () => {
    // Use a unique actor ID to avoid interference with other tests
    const testActorId = `singleton-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Verify actor is not mentioned initially via singleton
    expect(playerInfluenceService.wasMentionedRecentlySync(testActorId)).toBe(
      false
    );

    // Record a mention via singleton
    await playerInfluenceService.recordMention(testActorId, new Date());

    // Now the actor should be detected as recently mentioned
    expect(playerInfluenceService.wasMentionedRecentlySync(testActorId)).toBe(
      true
    );
  });
});

describe('Player Influence Service - Service Singleton', () => {
  test('singleton returns same instance on multiple imports', async () => {
    // Verify singleton identity - multiple references should be the same object
    const { playerInfluenceService: secondRef } = await import(
      '../services/player-influence-service'
    );
    expect(playerInfluenceService).toBe(secondRef);
  });

  test('singleton methods work correctly', () => {
    // Exercise real methods via the singleton
    const mentions = playerInfluenceService.extractMentions('Hello @testuser!');
    expect(mentions).toEqual(['testuser']);

    // wasMentionedRecentlySync should return false for unknown actor
    const wasmentioned =
      playerInfluenceService.wasMentionedRecentlySync('unknown-actor-xyz');
    expect(wasmentioned).toBe(false);
  });
});
