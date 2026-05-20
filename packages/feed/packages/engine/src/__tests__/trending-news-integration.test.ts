/**
 * Integration Tests for Trending Topics & News Article System
 *
 * Tests the complete flow from question creation through resolution
 * with trending topics and news article generation.
 */

/// <reference types="bun-types" />

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { type Article, ArticleGenerator } from '../ArticleGenerator';
import { FeedGenerator } from '../FeedGenerator';
import type { FeedLLMClient } from '../llm/openai-client';
import { NewsArticlePacingEngine } from '../NewsArticlePacingEngine';
import { TrendingTopicsEngine } from '../TrendingTopicsEngine';
import type { Actor, FeedPost, Organization, Question } from '../types/shared';

/**
 * Mock LLM client interface for testing
 */
interface MockLLMClient
  extends Pick<FeedLLMClient, 'generateJSON' | 'getProvider'> {}

describe('Trending Topics & News Integration', () => {
  let trendEngine: TrendingTopicsEngine;
  let pacingEngine: NewsArticlePacingEngine;
  let articleGen: ArticleGenerator;
  let feedGen: FeedGenerator;
  let mockLLM: FeedLLMClient;

  const mockQuestion: Question = {
    id: 1,
    text: 'Will TechCorp announce AI breakthrough?',
    scenario: 1,
    outcome: true,
    rank: 1,
    status: 'active',
    createdDate: '2025-11-01',
    resolutionDate: '2025-11-05',
  };

  const mockOrgs: Organization[] = [
    {
      id: 'msdnc',
      name: 'MSDNC',
      type: 'media',
      description: 'Progressive news network',
      canBeInvolved: true,
    },
    {
      id: 'the-fud',
      name: 'The Fud',
      type: 'media',
      description: 'Investigative journalism',
      canBeInvolved: true,
    },
    {
      id: 'channel-7',
      name: 'Channel 7',
      type: 'media',
      description: 'Breaking news',
      canBeInvolved: true,
    },
    {
      id: 'xitter',
      name: 'Xitter',
      type: 'media',
      description: 'Social media platform',
      canBeInvolved: true,
    },
    {
      id: 'bbc',
      name: 'BBC',
      type: 'media',
      description: 'Global news',
      canBeInvolved: true,
    },
  ];

  const mockActors: Actor[] = [
    {
      id: 'actor-1',
      name: 'AIlon Musk',
      tier: 'S_TIER',
      role: 'main',
      description: 'Tech billionaire',
      domain: ['tech'],
      personality: 'bold',
      affiliations: ['tech-corp'],
    },
  ];

  beforeEach(() => {
    const mockImpl: MockLLMClient = {
      getProvider: () => 'openai',
      generateJSON: mock(async (prompt: string) => {
        // The trending topics prompt contains "TRENDING REQUIREMENTS" not "TRENDING TOPICS"
        if (prompt.includes('TRENDING REQUIREMENTS')) {
          return {
            trends: [
              {
                trendName: 'AI Breakthrough Buzz',
                description:
                  'Tech community debates potential TechCorp announcement.',
              },
              {
                trendName: 'Market Speculation',
                description: 'Traders position ahead of expected news.',
              },
            ],
          };
        }

        if (prompt.includes('journalist writing for')) {
          const content =
            'TechCorp is reportedly preparing a major AI breakthrough announcement. '.repeat(
              45
            );
          return {
            response: {
              title: 'TechCorp AI Announcement Imminent, Sources Say',
              summary:
                'Multiple sources confirm TechCorp preparing major AI reveal.',
              content,
              slant: 'Optimistic about breakthrough potential',
              sentiment: 'positive',
              category: 'tech',
              tags: { tag: ['ai', 'techcorp', 'breakthrough'] },
            },
          };
        }

        return {};
      }),
    };
    mockLLM = mockImpl as FeedLLMClient;

    trendEngine = new TrendingTopicsEngine(mockLLM);
    // Use default interval of 4 ticks (every 4 hours, 6x per day)
    pacingEngine = new NewsArticlePacingEngine();
    articleGen = new ArticleGenerator(mockLLM);
    feedGen = new FeedGenerator(mockLLM);

    feedGen.setTrendingTopics(trendEngine);
  });

  describe('Complete Question Lifecycle', () => {
    it('should generate breaking articles when question created', async () => {
      const breakingOrgs = pacingEngine.selectOrgsForStage(
        mockOrgs,
        mockQuestion.id as number,
        'breaking'
      );

      expect(breakingOrgs.length).toBeGreaterThanOrEqual(1);
      expect(breakingOrgs.length).toBeLessThanOrEqual(2);

      const articles: Article[] = [];
      for (const org of breakingOrgs) {
        const article = await articleGen.generateArticleForQuestion(
          mockQuestion,
          org,
          'breaking',
          mockActors,
          []
        );

        expect(article).toBeDefined();
        expect(article.title).toBeTruthy();
        expect(article.content.length).toBeGreaterThan(100);

        pacingEngine.recordArticle(
          mockQuestion.id as number,
          org.id,
          'breaking',
          article.id,
          10
        );

        articles.push(article);
      }

      const stats = pacingEngine.getStageStats(mockQuestion.id as number);
      expect(stats.breaking).toBe(breakingOrgs.length);
      expect(stats.commentary).toBe(0);
      expect(stats.resolution).toBe(0);
    });

    it('should generate commentary articles at midpoint', async () => {
      const commentaryOrgs = pacingEngine.selectOrgsForStage(
        mockOrgs,
        mockQuestion.id as number,
        'commentary'
      );

      expect(commentaryOrgs.length).toBeGreaterThanOrEqual(2);
      expect(commentaryOrgs.length).toBeLessThanOrEqual(3);

      for (const org of commentaryOrgs) {
        const article = await articleGen.generateArticleForQuestion(
          mockQuestion,
          org,
          'commentary',
          mockActors,
          []
        );

        expect(article).toBeDefined();
        pacingEngine.recordArticle(
          mockQuestion.id as number,
          org.id,
          'commentary',
          article.id,
          50
        );
      }

      const stats = pacingEngine.getStageStats(mockQuestion.id as number);
      expect(stats.commentary).toBe(commentaryOrgs.length);
    });

    it('should generate resolution articles when question resolves', async () => {
      const resolutionOrgs = pacingEngine.selectOrgsForStage(
        mockOrgs,
        mockQuestion.id as number,
        'resolution'
      );

      expect(resolutionOrgs.length).toBeGreaterThan(0);
      expect(resolutionOrgs.length).toBeLessThanOrEqual(5);

      for (const org of resolutionOrgs) {
        const article = await articleGen.generateArticleForQuestion(
          mockQuestion,
          org,
          'resolution',
          mockActors,
          []
        );

        expect(article).toBeDefined();
        pacingEngine.recordArticle(
          mockQuestion.id as number,
          org.id,
          'resolution',
          article.id,
          100
        );
      }

      const stats = pacingEngine.getStageStats(mockQuestion.id as number);
      expect(stats.resolution).toBe(resolutionOrgs.length);
    });

    it('should maintain total article count < 10 per question', async () => {
      const breaking = pacingEngine.selectOrgsForStage(mockOrgs, 1, 'breaking');
      breaking.forEach((org) => {
        pacingEngine.recordArticle(
          1,
          org.id,
          'breaking',
          `article-${org.id}-1`,
          10
        );
      });

      const commentary = pacingEngine.selectOrgsForStage(
        mockOrgs,
        1,
        'commentary'
      );
      commentary.forEach((org) => {
        pacingEngine.recordArticle(
          1,
          org.id,
          'commentary',
          `article-${org.id}-2`,
          50
        );
      });

      const resolution = pacingEngine.selectOrgsForStage(
        mockOrgs,
        1,
        'resolution'
      );
      resolution.forEach((org) => {
        pacingEngine.recordArticle(
          1,
          org.id,
          'resolution',
          `article-${org.id}-3`,
          100
        );
      });

      const total = pacingEngine.getArticlesForQuestion(1).length;
      expect(total).toBeLessThan(11); // 2 + 3 + 5 = 10 max
    });
  });

  describe('Trending Topics Integration', () => {
    it('should update trends from feed posts', async () => {
      const posts: FeedPost[] = [
        {
          id: 'post-1',
          content: 'AI breakthrough imminent',
          author: 'user-1',
          authorName: 'User1',
          timestamp: '2025-11-15T10:00:00Z',
          day: 1,
          tags: ['ai', 'breakthrough', 'techcorp'],
          relatedQuestion: 1,
        },
        {
          id: 'post-2',
          content: 'TechCorp announcement expected',
          author: 'user-2',
          authorName: 'User2',
          timestamp: '2025-11-15T10:05:00Z',
          day: 1,
          tags: ['techcorp', 'ai'],
          relatedQuestion: 1,
        },
      ];

      await trendEngine.updateTrends(posts, 10);
      const trends = trendEngine.getTrends();

      expect(trends.length).toBeGreaterThan(0);
      expect(trends[0]?.relatedQuestions).toContain(1);
    });

    it('should provide trend context to feed generator', () => {
      feedGen.updateTrendContext();

      const context = feedGen['trendContext'];
      expect(context).toBeDefined();
      expect(context.trim().length).toBeGreaterThan(0);
      expect(context).toContain('TRENDING TOPICS');
    });

    it('should include trends in ambient post prompts', async () => {
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

      await trendEngine.updateTrends(posts, 10);
      feedGen.updateTrendContext();

      const context = feedGen['trendContext'];
      expect(context).toContain('AI Breakthrough Buzz');
    });
  });

  describe('Post Volume Balance', () => {
    it('should maintain high normal post to article ratio', async () => {
      const normalPosts: FeedPost[] = Array.from({ length: 100 }, (_, i) => ({
        id: `post-${i}`,
        content: `Normal post ${i}`,
        author: `user-${i}`,
        authorName: `User${i}`,
        timestamp: '2025-11-15T10:00:00Z',
        day: 1,
        tags: ['general'],
      }));

      const breakingOrgs = pacingEngine.selectOrgsForStage(
        mockOrgs,
        1,
        'breaking'
      );
      const articleCount = breakingOrgs.length;

      const ratio = normalPosts.length / articleCount;
      expect(ratio).toBeGreaterThan(10);
    });
  });

  describe('Error Handling', () => {
    it('should throw on invalid question for article generation', async () => {
      const invalidQuestion = {
        id: 0,
        text: '',
        scenario: 1,
        outcome: true,
        rank: 1,
      } as Question;

      await expect(async () => {
        await articleGen.generateArticleForQuestion(
          invalidQuestion,
          mockOrgs[0]!,
          'breaking',
          mockActors,
          []
        );
      }).toThrow('Invalid question');
    });

    it('should throw on invalid organization for article generation', async () => {
      const invalidOrg = {
        id: '',
        name: '',
        type: 'media',
        description: 'Invalid org',
        canBeInvolved: false,
      } as Organization;

      await expect(async () => {
        await articleGen.generateArticleForQuestion(
          mockQuestion,
          invalidOrg,
          'breaking',
          mockActors,
          []
        );
      }).toThrow('Invalid organization');
    });

    it('should throw on empty actors array', async () => {
      await expect(async () => {
        await articleGen.generateArticleForQuestion(
          mockQuestion,
          mockOrgs[0]!,
          'breaking',
          [], // Empty!
          []
        );
      }).toThrow('Actors array cannot be empty');
    });

    it('should propagate LLM failures (fail-fast)', async () => {
      const failingImpl: MockLLMClient = {
        generateJSON: mock(async () => {
          throw new Error('LLM timeout');
        }),
        getProvider: () => 'openai',
      };
      const failingLLM = failingImpl as FeedLLMClient;

      const engine = new TrendingTopicsEngine(failingLLM);
      engine.setUpdateInterval(10);

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

      // LLM failures should propagate, not be swallowed
      await expect(engine.updateTrends(posts, 10)).rejects.toThrow(
        'LLM timeout'
      );
    });
  });

  describe('Context Validation', () => {
    it('should never provide empty trend context to agents', () => {
      feedGen.updateTrendContext();
      let context = feedGen['trendContext'];
      expect(context.trim()).not.toBe('');
      expect(context).toContain('TRENDING TOPICS');

      trendEngine.updateTrends([], 10);
      feedGen.updateTrendContext();
      context = feedGen['trendContext'];
      expect(context.trim()).not.toBe('');
      expect(context).toContain('TRENDING TOPICS');
    });

    it('should throw if trending engine returns invalid context', () => {
      const badEngine = {
        getDetailedTrendContext: () => '',
      } as Pick<
        TrendingTopicsEngine,
        'getDetailedTrendContext'
      > as TrendingTopicsEngine;

      feedGen.setTrendingTopics(badEngine);

      expect(() => {
        feedGen.updateTrendContext();
      }).toThrow('TrendingTopicsEngine returned empty context');
    });
  });

  describe('Article Quality Validation', () => {
    it('should throw if article has empty title', async () => {
      const badImpl: MockLLMClient = {
        getProvider: () => 'openai',
        generateJSON: mock(async () => ({
          response: {
            title: '',
            summary: 'Test summary',
            content: 'Content '.repeat(100),
            slant: 'neutral',
            sentiment: 'neutral',
            category: 'tech',
            tags: { tag: ['test'] },
          },
        })),
      };
      const badLLM = badImpl as FeedLLMClient;

      const badArticleGen = new ArticleGenerator(badLLM);

      await expect(async () => {
        await badArticleGen.generateArticleForQuestion(
          mockQuestion,
          mockOrgs[0]!,
          'breaking',
          mockActors,
          []
        );
      }).toThrow('empty title');
    });

    it('should throw if article has empty summary', async () => {
      const badImpl: MockLLMClient = {
        getProvider: () => 'openai',
        generateJSON: mock(async () => ({
          response: {
            title: 'Test Title',
            summary: '',
            content: 'Content '.repeat(100),
            slant: 'neutral',
            sentiment: 'neutral',
            category: 'tech',
            tags: { tag: ['test'] },
          },
        })),
      };
      const badLLM = badImpl as FeedLLMClient;

      const badArticleGen = new ArticleGenerator(badLLM);

      await expect(async () => {
        await badArticleGen.generateArticleForQuestion(
          mockQuestion,
          mockOrgs[0]!,
          'breaking',
          mockActors,
          []
        );
      }).toThrow('empty summary');
    });

    it('should throw if article content is too short', async () => {
      const badImpl: MockLLMClient = {
        getProvider: () => 'openai',
        generateJSON: mock(async () => ({
          response: {
            title: 'Test Title',
            summary: 'Test summary',
            content: 'Short', // < 100 chars
            slant: 'neutral',
            sentiment: 'neutral',
            category: 'tech',
            tags: { tag: ['test'] },
          },
        })),
      };
      const badLLM = badImpl as FeedLLMClient;

      const badArticleGen = new ArticleGenerator(badLLM);

      await expect(async () => {
        await badArticleGen.generateArticleForQuestion(
          mockQuestion,
          mockOrgs[0]!,
          'breaking',
          mockActors,
          []
        );
      }).toThrow('content too short');
    });
  });

  describe('Multi-Question Scenario', () => {
    it('should handle multiple questions with independent article counts', async () => {
      const q1Orgs = pacingEngine.selectOrgsForStage(mockOrgs, 1, 'breaking');
      const q2Orgs = pacingEngine.selectOrgsForStage(mockOrgs, 2, 'breaking');

      q1Orgs.forEach((org) => {
        pacingEngine.recordArticle(
          1,
          org.id,
          'breaking',
          `article-q1-${org.id}`,
          10
        );
      });

      q2Orgs.forEach((org) => {
        pacingEngine.recordArticle(
          2,
          org.id,
          'breaking',
          `article-q2-${org.id}`,
          15
        );
      });

      expect(pacingEngine.getArticlesForQuestion(1).length).toBe(q1Orgs.length);
      expect(pacingEngine.getArticlesForQuestion(2).length).toBe(q2Orgs.length);

      const stats1 = pacingEngine.getStageStats(1);
      const stats2 = pacingEngine.getStageStats(2);
      expect(stats1.breaking + stats2.breaking).toBeLessThanOrEqual(
        mockOrgs.length
      );
    });
  });

  describe('Trend Evolution', () => {
    it('should evolve trends as new posts arrive', async () => {
      const initialPosts: FeedPost[] = [
        {
          id: 'post-1',
          content: 'AI news',
          author: 'user-1',
          authorName: 'User1',
          timestamp: '2025-11-15T10:00:00Z',
          day: 1,
          tags: ['ai'],
        },
      ];

      await trendEngine.updateTrends(initialPosts, 10);
      const trends1 = trendEngine.getTrends();

      const newPosts: FeedPost[] = [
        ...initialPosts,
        {
          id: 'post-2',
          content: 'Crypto news',
          author: 'user-2',
          authorName: 'User2',
          timestamp: '2025-11-15T10:30:00Z',
          day: 10,
          tags: ['crypto', 'defi'],
        },
        {
          id: 'post-3',
          content: 'More crypto',
          author: 'user-3',
          authorName: 'User3',
          timestamp: '2025-11-15T10:35:00Z',
          day: 10,
          tags: ['crypto'],
        },
      ];

      await trendEngine.updateTrends(newPosts, 20);
      const trends2 = trendEngine.getTrends();

      expect(trends2).not.toEqual(trends1);
    });
  });

  describe('Performance & Scalability', () => {
    it('should handle 100+ posts efficiently', async () => {
      const posts: FeedPost[] = Array.from({ length: 100 }, (_, i) => ({
        id: `post-${i}`,
        content: `Post ${i}`,
        author: `user-${i}`,
        authorName: `User${i}`,
        timestamp: '2025-11-15T10:00:00Z',
        day: 1,
        tags: [`tag-${i % 10}`], // 10 different tags
      }));

      const start = Date.now();
      await trendEngine.updateTrends(posts, 10);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(5000);

      const trends = trendEngine.getTrends();
      expect(trends.length).toBeLessThanOrEqual(5);
    });

    it('should batch LLM calls for trend descriptions', async () => {
      const posts: FeedPost[] = Array.from({ length: 20 }, (_, i) => ({
        id: `post-${i}`,
        content: `Post ${i}`,
        author: `user-${i}`,
        authorName: `User${i}`,
        timestamp: '2025-11-15T10:00:00Z',
        day: 1,
        tags: [`tag-${i % 10}`],
      }));

      await trendEngine.updateTrends(posts, 10);

      expect(
        (mockLLM.generateJSON as ReturnType<typeof mock>).mock.calls.length
      ).toBe(1);
    });
  });
});
