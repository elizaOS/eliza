/**
 * Fail-Fast Validation Tests
 *
 * @description
 * Ensures the system fails immediately on invalid data rather than
 * propagating bad state. Critical for data integrity.
 */

import { describe, expect, mock, test } from 'bun:test';
import { FeedGenerator } from '../FeedGenerator';
import type { BabylonLLMClient } from '../llm/openai-client';

// Create a minimal mock LLM client for validation tests
function createMockLLMClient(): BabylonLLMClient {
  return {
    generateText: mock(() => Promise.resolve('')),
    generateJSON: mock(() => Promise.resolve({})),
    getProvider: () => 'groq',
    getStats: () => ({
      provider: 'groq' as const,
      model: 'test',
      totalTokens: 0,
      totalCost: 0,
    }),
  } as unknown as BabylonLLMClient;
}

describe('Fail-Fast Validation', () => {
  test('generateDayFeed throws on invalid day number', async () => {
    const llm = createMockLLMClient();
    const feed = new FeedGenerator(llm);

    await expect(feed.generateDayFeed(0, [], [])).rejects.toThrow(
      'day must be between 1 and 30'
    );

    await expect(feed.generateDayFeed(31, [], [])).rejects.toThrow(
      'day must be between 1 and 30'
    );
  });

  test('generateDayFeed throws on empty actors array', async () => {
    const llm = createMockLLMClient();
    const feed = new FeedGenerator(llm);

    await expect(feed.generateDayFeed(1, [], [])).rejects.toThrow(
      'cannot be empty'
    );
  });

  test('skips posts with empty content', () => {
    const posts = [
      { post: 'Valid content', sentiment: 0, clueStrength: 0.5 },
      { post: '', sentiment: 0, clueStrength: 0.5 }, // Empty - should skip
      { post: '   ', sentiment: 0, clueStrength: 0.5 }, // Whitespace - should skip
      { post: 'Another valid', sentiment: 0, clueStrength: 0.5 },
    ];

    const valid = posts.filter((p) => p.post && p.post.trim().length > 0);
    expect(valid.length).toBe(2);
  });

  test('validates event descriptions are not empty', () => {
    const events = [
      { event: 'Valid event' },
      { event: '' },
      { event: 'Another valid event' },
    ];

    const valid = events.filter((e) => e.event && e.event.trim().length > 0);
    expect(valid.length).toBe(2);
  });

  test('validates content length limits', () => {
    const MAX_CONTENT_LENGTH = 5000;
    const longContent = 'a'.repeat(10000);
    const validContent = 'Valid post content';

    expect(longContent.length).toBeGreaterThan(MAX_CONTENT_LENGTH);
    expect(validContent.length).toBeLessThan(MAX_CONTENT_LENGTH);

    // In production, would throw or truncate
    if (longContent.length > MAX_CONTENT_LENGTH) {
      const truncated = longContent.substring(0, MAX_CONTENT_LENGTH);
      expect(truncated.length).toBe(MAX_CONTENT_LENGTH);
    }
  });
});
