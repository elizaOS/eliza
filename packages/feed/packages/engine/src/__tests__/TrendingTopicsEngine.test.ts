/**
 * Tests for TrendingTopicsEngine
 *
 * The engine updates every 4 ticks by default (every 4 hours, 6x per day)
 * and skips LLM regeneration when topics haven't changed significantly.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { FeedLLMClient } from '../llm/openai-client';
import { TrendingTopicsEngine } from '../TrendingTopicsEngine';
import type { FeedPost } from '../types/shared';

/**
 * Mock LLM client interface for testing
 */
interface MockLLMClient extends Pick<FeedLLMClient, 'generateJSON'> {}

describe('TrendingTopicsEngine', () => {
  let engine: TrendingTopicsEngine;
  let mockLLM: FeedLLMClient;

  beforeEach(() => {
    // Mock LLM client - implements only generateJSON method
    const mockImpl: MockLLMClient = {
      generateJSON: mock(async () => ({
        trends: [
          {
            trendName: 'AI Revolution',
            description:
              'Major breakthroughs in AI technology reshaping the industry.',
          },
          {
            trendName: 'Tech Regulation',
            description: 'Government proposes new tech oversight framework.',
          },
          {
            trendName: 'Crypto Comeback',
            description: 'Digital assets rally amid positive sentiment.',
          },
        ],
      })),
    };
    mockLLM = mockImpl as FeedLLMClient;

    engine = new TrendingTopicsEngine(mockLLM);
    // Use default interval of 4 ticks (every 4 hours)
  });

  describe('Validation', () => {
    it('should not fail on empty posts array', async () => {
      await engine.updateTrends([], 10);
      const trends = engine.getTrends();
      expect(trends).toEqual([]);
    });

    it('should not fail when posts have no tags', async () => {
      const posts: FeedPost[] = [
        {
          id: 'post-1',
          content: 'Test post',
          author: 'user-1',
          authorName: 'User',
          timestamp: '2025-11-15T10:00:00Z',
          day: 1,
        },
      ];

      await engine.updateTrends(posts, 10);
      const trends = engine.getTrends();
      expect(trends).toEqual([]);
    });

    it('should use tag as trendName when LLM returns empty trends array', async () => {
      mockLLM.generateJSON = mock(async () => ({ trends: [] }));

      const posts: FeedPost[] = [
        {
          id: 'post-1',
          content: 'AI is amazing',
          author: 'user-1',
          authorName: 'User',
          timestamp: '2025-11-15T10:00:00Z',
          day: 1,
          tags: ['ai', 'tech'],
        },
      ];

      await engine.updateTrends(posts, 10);

      // When LLM returns empty trends, trendName defaults to the tag
      const trends = engine.getTrends();
      expect(trends.length).toBeGreaterThan(0);
      // Each trend should have the tag as trendName
      for (const trend of trends) {
        expect(trend.trendName).toBe(trend.tag);
      }
    });

    it('should use tag when LLM returns empty trendName', async () => {
      mockLLM.generateJSON = mock(async () => ({
        trends: [
          { trendName: '', description: '' }, // Empty strings
        ],
      }));

      const posts: FeedPost[] = [
        {
          id: 'post-1',
          content: 'AI is amazing',
          author: 'user-1',
          authorName: 'User',
          timestamp: '2025-11-15T10:00:00Z',
          day: 1,
          tags: ['ai'],
        },
      ];

      await engine.updateTrends(posts, 10);
      const trends = engine.getTrends();

      // Empty trendName/description defaults to tag-based values
      expect(trends[0]?.trendName).toBe('ai');
      expect(trends[0]?.description).toContain('posts discussing');
    });
  });

  describe('Trend Detection', () => {
    it('should aggregate tags from posts correctly', async () => {
      const posts: FeedPost[] = [
        {
          id: 'post-1',
          content: 'AI breakthrough',
          author: 'user-1',
          authorName: 'User',
          timestamp: '2025-11-15T10:00:00Z',
          day: 1,
          tags: ['ai', 'tech'],
          relatedQuestion: 5,
        },
        {
          id: 'post-2',
          content: 'More AI news',
          author: 'user-2',
          authorName: 'User2',
          timestamp: '2025-11-15T10:30:00Z',
          day: 1,
          tags: ['ai', 'breakthrough'],
          relatedQuestion: 5,
        },
      ];

      await engine.updateTrends(posts, 10);
      const trends = engine.getTrends();

      expect(trends.length).toBeGreaterThan(0);
      expect(trends[0]?.tag).toBe('ai'); // Most frequent
      expect(trends[0]?.count).toBe(2);
      expect(trends[0]?.relatedQuestions).toContain(5);
    });

    it('should rank topics by frequency and recency', async () => {
      const posts: FeedPost[] = [
        {
          id: 'post-1',
          content: 'Old AI post',
          author: 'user-1',
          authorName: 'User',
          timestamp: '2025-11-15T08:00:00Z',
          day: 1,
          tags: ['ai'],
        },
        {
          id: 'post-2',
          content: 'Recent crypto post',
          author: 'user-2',
          authorName: 'User2',
          timestamp: '2025-11-15T10:00:00Z',
          day: 10, // More recent
          tags: ['crypto'],
        },
      ];

      await engine.updateTrends(posts, 10);
      const trends = engine.getTrends();

      const cryptoTrend = trends.find((t) => t.tag === 'crypto');
      expect(cryptoTrend).toBeDefined();
      expect(cryptoTrend!.recency).toBeGreaterThan(0.9);
    });

    it('should limit to top 5 trends', async () => {
      const posts: FeedPost[] = [];
      const tags = [
        'ai',
        'crypto',
        'tech',
        'web3',
        'gaming',
        'social',
        'finance',
      ];

      tags.forEach((tag, i) => {
        posts.push({
          id: `post-${i}`,
          content: `Post about ${tag}`,
          author: `user-${i}`,
          authorName: `User${i}`,
          timestamp: '2025-11-15T10:00:00Z',
          day: 1,
          tags: [tag],
        });
      });

      await engine.updateTrends(posts, 10);
      const trends = engine.getTrends();

      expect(trends.length).toBeLessThanOrEqual(5);
    });
  });

  describe('Context Generation', () => {
    it('should generate non-empty trend context', () => {
      const context = engine.getTrendContext();
      expect(context).toBeDefined();
      expect(context.length).toBeGreaterThan(0);
    });

    it('should generate detailed context with trend descriptions', () => {
      const detailed = engine.getDetailedTrendContext();
      expect(detailed).toBeDefined();
      expect(detailed.length).toBeGreaterThan(0);
      expect(detailed).toContain('TRENDING TOPICS');
    });

    it('should never return empty string from getTrendContext', () => {
      const context = engine.getTrendContext();
      expect(context.trim()).not.toBe('');
    });

    it('should never return empty string from getDetailedTrendContext', () => {
      const detailed = engine.getDetailedTrendContext();
      expect(detailed.trim()).not.toBe('');
    });
  });

  describe('Update Frequency', () => {
    it('should only update on interval', async () => {
      const posts: FeedPost[] = [
        {
          id: 'post-1',
          content: 'Test',
          author: 'user-1',
          authorName: 'User',
          timestamp: '2025-11-15T10:00:00Z',
          day: 1,
          tags: ['test'],
        },
      ];

      await engine.updateTrends(posts, 5);
      const callCount1 = (mockLLM.generateJSON as ReturnType<typeof mock>).mock
        .calls.length;

      await engine.updateTrends(posts, 8); // Not yet time (< 10 ticks)
      const callCount2 = (mockLLM.generateJSON as ReturnType<typeof mock>).mock
        .calls.length;

      expect(callCount1).toBe(callCount2); // No new LLM call
    });

    it('should update after interval when topics change', async () => {
      const posts1: FeedPost[] = [
        {
          id: 'post-1',
          content: 'Test',
          author: 'user-1',
          authorName: 'User',
          timestamp: '2025-11-15T10:00:00Z',
          day: 1,
          tags: ['test'],
        },
      ];

      await engine.updateTrends(posts1, 10);
      const callCount1 = (mockLLM.generateJSON as ReturnType<typeof mock>).mock
        .calls.length;

      // Different posts with different tags (significant change)
      const posts2: FeedPost[] = [
        {
          id: 'post-2',
          content: 'Crypto news',
          author: 'user-2',
          authorName: 'User2',
          timestamp: '2025-11-15T11:00:00Z',
          day: 2,
          tags: ['crypto', 'bitcoin'],
        },
      ];

      await engine.updateTrends(posts2, 20); // 10 ticks later
      const callCount2 = (mockLLM.generateJSON as ReturnType<typeof mock>).mock
        .calls.length;

      expect(callCount2).toBeGreaterThan(callCount1); // New LLM call
    });

    it('should allow configuring update interval with minimum enforcement', async () => {
      engine.setUpdateInterval(0); // Try to set below minimum
      // Minimum is enforced at 1
      expect(engine.getUpdateInterval()).toBe(1);

      engine.setUpdateInterval(8); // Valid interval (every 8 hours)
      expect(engine.getUpdateInterval()).toBe(8);
    });

    it('should have default interval of 4 ticks (6x per day)', () => {
      const freshEngine = new TrendingTopicsEngine(mockLLM);
      expect(freshEngine.getUpdateInterval()).toBe(4);
    });
  });

  describe('Change Detection', () => {
    it('should skip LLM call when topics are unchanged', async () => {
      const posts: FeedPost[] = [
        {
          id: 'post-1',
          content: 'AI news',
          author: 'user-1',
          authorName: 'User',
          timestamp: '2025-11-15T10:00:00Z',
          day: 1,
          tags: ['ai', 'tech'],
        },
        {
          id: 'post-2',
          content: 'More AI',
          author: 'user-2',
          authorName: 'User2',
          timestamp: '2025-11-15T10:30:00Z',
          day: 1,
          tags: ['ai'],
        },
      ];

      // First update - generates trends
      await engine.updateTrends(posts, 10);
      const callCount1 = (mockLLM.generateJSON as ReturnType<typeof mock>).mock
        .calls.length;
      expect(callCount1).toBe(1);

      // Same posts, interval passed - should skip LLM due to no change
      await engine.updateTrends(posts, 20);
      const callCount2 = (mockLLM.generateJSON as ReturnType<typeof mock>).mock
        .calls.length;
      expect(callCount2).toBe(1); // Still 1, no new call
    });

    it('should regenerate when new topics appear', async () => {
      const posts1: FeedPost[] = [
        {
          id: 'post-1',
          content: 'AI news',
          author: 'user-1',
          authorName: 'User',
          timestamp: '2025-11-15T10:00:00Z',
          day: 1,
          tags: ['ai'],
        },
      ];

      await engine.updateTrends(posts1, 10);
      const callCount1 = (mockLLM.generateJSON as ReturnType<typeof mock>).mock
        .calls.length;

      // Completely new topics
      const posts2: FeedPost[] = [
        {
          id: 'post-2',
          content: 'Crypto crash',
          author: 'user-2',
          authorName: 'User2',
          timestamp: '2025-11-15T11:00:00Z',
          day: 2,
          tags: ['crypto', 'crash'],
        },
        {
          id: 'post-3',
          content: 'Bitcoin drops',
          author: 'user-3',
          authorName: 'User3',
          timestamp: '2025-11-15T11:30:00Z',
          day: 2,
          tags: ['bitcoin'],
        },
      ];

      await engine.updateTrends(posts2, 20);
      const callCount2 = (mockLLM.generateJSON as ReturnType<typeof mock>).mock
        .calls.length;

      expect(callCount2).toBeGreaterThan(callCount1);
    });

    it('should force update when requested', async () => {
      const posts: FeedPost[] = [
        {
          id: 'post-1',
          content: 'AI news',
          author: 'user-1',
          authorName: 'User',
          timestamp: '2025-11-15T10:00:00Z',
          day: 1,
          tags: ['ai'],
        },
      ];

      await engine.updateTrends(posts, 10);
      const callCount1 = (mockLLM.generateJSON as ReturnType<typeof mock>).mock
        .calls.length;

      // Force update even with same posts
      await engine.forceTrendUpdate(posts, 20);
      const callCount2 = (mockLLM.generateJSON as ReturnType<typeof mock>).mock
        .calls.length;

      expect(callCount2).toBeGreaterThan(callCount1);
    });

    it('should update trend counts without regenerating descriptions', async () => {
      const posts1: FeedPost[] = [
        {
          id: 'post-1',
          content: 'AI news',
          author: 'user-1',
          authorName: 'User',
          timestamp: '2025-11-15T10:00:00Z',
          day: 1,
          tags: ['ai'],
        },
      ];

      await engine.updateTrends(posts1, 10);
      const trends1 = engine.getTrends();
      const aiTrend1 = trends1.find((t) => t.tag === 'ai');
      expect(aiTrend1?.count).toBe(1);

      // Add more posts with same tag
      const posts2: FeedPost[] = [
        ...posts1,
        {
          id: 'post-2',
          content: 'More AI',
          author: 'user-2',
          authorName: 'User2',
          timestamp: '2025-11-15T10:30:00Z',
          day: 1,
          tags: ['ai'],
        },
      ];

      // Update - should update counts without LLM call
      await engine.updateTrends(posts2, 20);
      const trends2 = engine.getTrends();
      const aiTrend2 = trends2.find((t) => t.tag === 'ai');
      expect(aiTrend2?.count).toBe(2);
    });

    it('should report needsUpdate correctly', async () => {
      expect(engine.needsUpdate(2)).toBe(false); // Not enough ticks passed (need 4)
      expect(engine.needsUpdate(5)).toBe(true); // Interval reached (4 ticks)

      const posts: FeedPost[] = [
        {
          id: 'post-1',
          content: 'Test',
          author: 'user-1',
          authorName: 'User',
          timestamp: '2025-11-15T10:00:00Z',
          day: 1,
          tags: ['test'],
        },
      ];

      await engine.updateTrends(posts, 10);
      expect(engine.getLastUpdateTick()).toBe(10);
      expect(engine.needsUpdate(12)).toBe(false); // Only 2 ticks since last update
      expect(engine.needsUpdate(15)).toBe(true); // 5 ticks since last update (> 4)
    });
  });
});
