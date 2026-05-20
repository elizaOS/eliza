/**
 * Trending Topics Engine - Dynamic Trend Detection and Description
 *
 * @module engine/TrendingTopicsEngine
 *
 * @description
 * Tracks popular topics across the feed and generates LLM-powered trend descriptions.
 * Updates every 4 ticks (4 hours, 6x per day) to reflect evolving narratives while
 * avoiding redundant LLM calls. Only regenerates when topic composition changes significantly.
 *
 * **Key Features:**
 * - Aggregates tags from recent posts (last 100 posts)
 * - Ranks topics by frequency and recency
 * - Generates micro-summaries of each trend using LLM
 * - Updates every 4 ticks (every 4 hours, 6x per day)
 * - Skips regeneration if top topics haven't changed
 * - Provides trend context for agent posting
 *
 * **Trend Lifecycle:**
 * 1. **Detection** - Aggregate tags from recent posts
 * 2. **Change Detection** - Check if topics have shifted significantly
 * 3. **Ranking** - Sort by frequency + recency score
 * 4. **Description** - LLM generates trend name and summary (only if changed)
 * 5. **Distribution** - Make trends available to agents
 * 6. **Refresh** - Update every 4 ticks (6x per day)
 *
 * @example
 * ```typescript
 * const trends = new TrendingTopicsEngine(llm);
 *
 * // Update trends - internally checks interval and content changes
 * await trends.updateTrends(recentPosts, currentTick);
 *
 * // Get current trends for agent context
 * const trendContext = trends.getTrendContext();
 * // => "Trending: 'Elon's Latest Meltdown' (23 posts), 'AI Regulation Battle' (18 posts)"
 * ```
 */

import { logger } from '@feed/shared';
import type { FeedLLMClient } from './llm/openai-client';
import { getPromptParams, renderPrompt, trendingTopics } from './prompts';
import type { FeedPost } from './types/shared';

/**
 * A trending topic with LLM-generated description
 */
export interface TrendingTopic {
  /** Primary tag/keyword */
  tag: string;
  /** Number of posts mentioning this topic */
  count: number;
  /** Recency score (0-1, higher = more recent) */
  recency: number;
  /** Combined score (count * recency weight) */
  score: number;
  /** LLM-generated trend name (catchy, descriptive) */
  trendName: string;
  /** LLM-generated micro-summary (1-2 sentences) */
  description: string;
  /** Related question IDs */
  relatedQuestions: number[];
  /** Sample post IDs */
  samplePosts: string[];
}

/**
 * Trending Topics Engine
 *
 * @class TrendingTopicsEngine
 *
 * @description
 * Manages trending topic detection, ranking, and description generation.
 * Updates periodically to reflect evolving narratives while avoiding
 * redundant LLM calls when topics haven't changed.
 */
export class TrendingTopicsEngine {
  private llm: FeedLLMClient;
  private currentTrends: TrendingTopic[] = [];
  private lastUpdateTick = 0;
  private updateInterval = 4; // Update every 4 ticks (4 hours, 6x per day)
  /** Hash of the last top topics to detect changes */
  private lastTopicsHash = '';
  /** Minimum score change ratio required to trigger regeneration (30%) */
  private static readonly MIN_CHANGE_THRESHOLD = 0.3;

  /**
   * Create a new TrendingTopicsEngine
   *
   * @param llm - Feed LLM client for trend description generation
   */
  constructor(llm: FeedLLMClient) {
    this.llm = llm;
  }

  /**
   * Update trends based on recent posts (call every tick, updates every 100)
   *
   * @param recentPosts - Last 100-200 posts from the feed
   * @param currentTick - Current game tick number
   * @param forceUpdate - Force update even if interval hasn't passed (default: false)
   */
  async updateTrends(
    recentPosts: FeedPost[],
    currentTick: number,
    forceUpdate = false
  ): Promise<void> {
    // Validation
    if (!recentPosts || recentPosts.length === 0) {
      logger.warn(
        'No recent posts available for trend detection',
        undefined,
        'TrendingTopicsEngine'
      );
      return;
    }

    // Only update every N ticks (unless forced or first update)
    const isFirstUpdate =
      this.lastUpdateTick === 0 && this.currentTrends.length === 0;
    if (
      !forceUpdate &&
      !isFirstUpdate &&
      currentTick - this.lastUpdateTick < this.updateInterval
    ) {
      return;
    }

    // 1. Aggregate tags from recent posts
    const tagFrequency = this.aggregateTags(recentPosts);

    if (tagFrequency.size === 0) {
      logger.warn(
        'No tags found in recent posts - cannot generate trends',
        undefined,
        'TrendingTopicsEngine'
      );
      return;
    }

    // 2. Rank by frequency and recency
    const rankedTopics = this.rankTopics(tagFrequency, currentTick);

    if (rankedTopics.length === 0) {
      logger.warn(
        'No topics to rank - cannot generate trends',
        undefined,
        'TrendingTopicsEngine'
      );
      return;
    }

    // 3. Take top 5 topics
    const topTopics = rankedTopics.slice(0, 5);

    // 4. Check if topics have changed significantly - skip LLM if not
    const newTopicsHash = this.computeTopicsHash(topTopics);
    const hasSignificantChange = this.hasTopicsChanged(topTopics);

    if (
      !forceUpdate &&
      !hasSignificantChange &&
      this.currentTrends.length > 0
    ) {
      logger.debug(
        `Skipping trend regeneration - topics unchanged (hash: ${newTopicsHash})`,
        { topTopics: topTopics.map((t) => t.tag) },
        'TrendingTopicsEngine'
      );
      // Update the tick but reuse existing trends with updated counts
      this.lastUpdateTick = currentTick;
      this.updateTrendCounts(topTopics);
      return;
    }

    logger.info(
      `Updating trending topics at tick ${currentTick}`,
      {
        postCount: recentPosts.length,
        topicsHash: newTopicsHash,
        previousHash: this.lastTopicsHash,
        hasSignificantChange,
      },
      'TrendingTopicsEngine'
    );

    this.lastUpdateTick = currentTick;
    this.lastTopicsHash = newTopicsHash;

    // 5. Generate LLM descriptions for each trend
    this.currentTrends = await this.generateTrendDescriptions(
      topTopics,
      recentPosts
    );

    logger.info(
      `Generated ${this.currentTrends.length} trending topics`,
      {
        trends: this.currentTrends.map((t) => t.trendName),
      },
      'TrendingTopicsEngine'
    );
  }

  /**
   * Compute a hash of the top topics for change detection
   */
  private computeTopicsHash(
    topics: Array<{ tag: string; count: number; score: number }>
  ): string {
    // Hash based on tag names and relative ordering
    return topics.map((t) => `${t.tag}:${Math.round(t.score)}`).join('|');
  }

  /**
   * Check if topics have changed significantly from previous update
   */
  private hasTopicsChanged(
    newTopics: Array<{ tag: string; count: number; score: number }>
  ): boolean {
    // If no previous trends, definitely changed
    if (this.currentTrends.length === 0 || !this.lastTopicsHash) {
      return true;
    }

    const newHash = this.computeTopicsHash(newTopics);

    // Quick check: if hash is identical, no change
    if (newHash === this.lastTopicsHash) {
      return false;
    }

    // Check if the top tags are the same (order might differ)
    const currentTags = new Set(this.currentTrends.map((t) => t.tag));
    const newTags = new Set(newTopics.map((t) => t.tag));

    // Count how many tags are different
    let differentTags = 0;
    for (const tag of newTags) {
      if (!currentTags.has(tag)) {
        differentTags++;
      }
    }

    // If more than 40% of tags are different, it's a significant change
    const changeRatio = differentTags / newTags.size;

    // Also check if scores have changed significantly
    const scoreChange = this.computeScoreChange(newTopics);

    return (
      changeRatio >= TrendingTopicsEngine.MIN_CHANGE_THRESHOLD ||
      scoreChange >= 0.5
    );
  }

  /**
   * Compute how much the scores have changed relative to current trends
   */
  private computeScoreChange(
    newTopics: Array<{ tag: string; score: number }>
  ): number {
    if (this.currentTrends.length === 0) return 1;

    const currentScoreMap = new Map(
      this.currentTrends.map((t) => [t.tag, t.score])
    );

    let totalChange = 0;
    let compared = 0;

    for (const topic of newTopics) {
      const currentScore = currentScoreMap.get(topic.tag);
      if (currentScore !== undefined && currentScore > 0) {
        const change = Math.abs(topic.score - currentScore) / currentScore;
        totalChange += change;
        compared++;
      }
    }

    return compared > 0 ? totalChange / compared : 1;
  }

  /**
   * Update counts on existing trends without regenerating descriptions
   */
  private updateTrendCounts(
    newTopics: Array<{
      tag: string;
      count: number;
      recency: number;
      score: number;
      relatedQuestions: number[];
      samplePosts: string[];
    }>
  ): void {
    const newTopicMap = new Map(newTopics.map((t) => [t.tag, t]));

    for (const trend of this.currentTrends) {
      const newData = newTopicMap.get(trend.tag);
      if (newData) {
        trend.count = newData.count;
        trend.recency = newData.recency;
        trend.score = newData.score;
        trend.relatedQuestions = newData.relatedQuestions;
        trend.samplePosts = newData.samplePosts;
      }
    }
  }

  /**
   * Get current trending topics
   */
  getTrends(): TrendingTopic[] {
    return this.currentTrends;
  }

  /**
   * Get trend context string for agent prompts
   *
   * @returns Formatted string describing current trends
   *
   * @example
   * "Trending: 'Elon's Latest Meltdown' (23 posts), 'AI Regulation Battle' (18 posts), ..."
   */
  getTrendContext(): string {
    if (this.currentTrends.length === 0) {
      return 'No trending topics yet.';
    }

    const trendList = this.currentTrends
      .slice(0, 3) // Top 3 trends
      .map((t) => `"${t.trendName}" (${t.count} posts)`)
      .join(', ');

    return `🔥 Trending: ${trendList}`;
  }

  /**
   * Get detailed trend context for agent prompts
   *
   * @returns Formatted trend context - NEVER empty string
   * @throws Error if called before first trend update
   */
  getDetailedTrendContext(): string {
    if (this.currentTrends.length === 0) {
      return 'TRENDING TOPICS: (none yet)';
    }

    const trendList = this.currentTrends
      .map((t, i) => {
        if (!t.trendName || !t.description) {
          throw new Error(
            `Invalid trend at index ${i}: missing trendName or description`
          );
        }
        const desc =
          t.description.length > 60
            ? t.description.substring(0, 60) + '...'
            : t.description;
        return `${i + 1}."${t.trendName}"(${t.count}): ${desc}`;
      })
      .join('\n');

    return `TRENDING TOPICS:\n${trendList}`;
  }

  /**
   * Aggregate tags from recent posts
   */
  private aggregateTags(posts: FeedPost[]): Map<
    string,
    {
      count: number;
      posts: FeedPost[];
      relatedQuestions: Set<number>;
    }
  > {
    const tagMap = new Map<
      string,
      {
        count: number;
        posts: FeedPost[];
        relatedQuestions: Set<number>;
      }
    >();

    for (const post of posts) {
      if (!post.tags || post.tags.length === 0) continue;

      for (const tag of post.tags) {
        const normalized = tag.toLowerCase().trim();
        if (!normalized) continue;

        if (!tagMap.has(normalized)) {
          tagMap.set(normalized, {
            count: 0,
            posts: [],
            relatedQuestions: new Set(),
          });
        }

        const entry = tagMap.get(normalized)!;
        entry.count++;
        entry.posts.push(post);

        if (post.relatedQuestion) {
          entry.relatedQuestions.add(post.relatedQuestion);
        }
      }
    }

    return tagMap;
  }

  /**
   * Rank topics by frequency and recency
   */
  private rankTopics(
    tagFrequency: Map<
      string,
      {
        count: number;
        posts: FeedPost[];
        relatedQuestions: Set<number>;
      }
    >,
    currentTick: number
  ): Array<{
    tag: string;
    count: number;
    recency: number;
    score: number;
    relatedQuestions: number[];
    samplePosts: string[];
  }> {
    const topics: Array<{
      tag: string;
      count: number;
      recency: number;
      score: number;
      relatedQuestions: number[];
      samplePosts: string[];
    }> = [];

    for (const [tag, data] of tagFrequency.entries()) {
      // Calculate recency score (recent posts weighted higher)
      const mostRecentPost = data.posts.reduce((latest, post) => {
        const postTime = new Date(post.timestamp).getTime();
        const latestTime = new Date(latest.timestamp).getTime();
        return postTime > latestTime ? post : latest;
      });

      // Recency score: 1.0 for current tick, decaying to 0.5 for older posts
      const ticksAgo = currentTick - (mostRecentPost.day || 0);
      const recency = Math.max(0.5, 1.0 - ticksAgo * 0.05);

      // Combined score: count * recency (favors frequent + recent)
      const score = data.count * recency;

      topics.push({
        tag,
        count: data.count,
        recency,
        score,
        relatedQuestions: Array.from(data.relatedQuestions),
        samplePosts: data.posts.slice(0, 5).map((p) => p.id),
      });
    }

    // Sort by score (highest first)
    return topics.sort((a, b) => b.score - a.score);
  }

  /**
   * Generate LLM descriptions for trends
   */
  private async generateTrendDescriptions(
    topics: Array<{
      tag: string;
      count: number;
      recency: number;
      score: number;
      relatedQuestions: number[];
      samplePosts: string[];
    }>,
    allPosts: FeedPost[]
  ): Promise<TrendingTopic[]> {
    // Build prompt with sample posts for each topic
    const topicsList = topics
      .map((topic, i) => {
        const samplePosts = allPosts
          .filter((p) => topic.samplePosts.includes(p.id))
          .slice(0, 3);

        const posts = samplePosts
          .map((p) => {
            const content =
              p.content.length > 80
                ? p.content.substring(0, 80) + '...'
                : p.content;
            return `@${p.authorName}:"${content}"`;
          })
          .join(' | ');

        return `${i + 1}. "${topic.tag}" (${topic.count}): ${posts}`;
      })
      .join('\n');

    const prompt = renderPrompt(trendingTopics, {
      topicsList,
      previousTrends: '',
    });
    const params = getPromptParams(trendingTopics);

    const rawResponse = await this.llm.generateJSON<Record<string, unknown>>(
      prompt,
      undefined,
      {
        ...params,
        format: 'xml',
        promptType: 'trending_topics_generate',
      }
    );

    // Extract trend descriptions from XML response structure
    const trendDescriptions = this.extractTrendDescriptions(rawResponse);

    // Combine topic data with LLM descriptions
    return topics.map((topic, i) => {
      const desc = trendDescriptions[i];
      const trendName = desc?.trendName?.trim();
      const description = desc?.description?.trim();
      return {
        tag: topic.tag,
        count: topic.count,
        recency: topic.recency,
        score: topic.score,
        trendName: trendName || topic.tag,
        description:
          description || `${topic.count} posts discussing ${topic.tag}`,
        relatedQuestions: topic.relatedQuestions,
        samplePosts: topic.samplePosts,
      };
    });
  }

  /**
   * Extract trend descriptions from LLM response (handles XML structure variations)
   */
  private extractTrendDescriptions(
    rawResponse: Record<string, unknown>
  ): Array<{ trendName: string; description: string }> {
    // Direct trends array
    if ('trends' in rawResponse && Array.isArray(rawResponse.trends)) {
      return rawResponse.trends as Array<{
        trendName: string;
        description: string;
      }>;
    }

    // Wrapped in response object
    if ('response' in rawResponse && rawResponse.response) {
      const response = rawResponse.response as Record<string, unknown>;
      if ('trends' in response && Array.isArray(response.trends)) {
        return response.trends as Array<{
          trendName: string;
          description: string;
        }>;
      }
      // Single trend wrapped in object
      if (
        'trends' in response &&
        response.trends &&
        typeof response.trends === 'object'
      ) {
        const trendsObj = response.trends as Record<string, unknown>;
        if ('trend' in trendsObj) {
          const trendData = trendsObj.trend;
          return Array.isArray(trendData)
            ? trendData
            : [trendData as { trendName: string; description: string }];
        }
      }
    }

    return [];
  }

  /**
   * Set update interval (default: 4 ticks = every 4 hours, 6x per day)
   *
   * @param ticks - Number of ticks between updates (minimum: 1)
   */
  setUpdateInterval(ticks: number): void {
    // Enforce minimum of 1 tick to prevent continuous updates
    this.updateInterval = Math.max(1, ticks);
    if (ticks < 1) {
      logger.warn(
        `Update interval ${ticks} is too low, using minimum of 1`,
        undefined,
        'TrendingTopicsEngine'
      );
    }
  }

  /**
   * Get current update interval
   */
  getUpdateInterval(): number {
    return this.updateInterval;
  }

  /**
   * Force a trend update regardless of interval or change detection
   *
   * @param recentPosts - Last 100-200 posts from the feed
   * @param currentTick - Current game tick number
   */
  async forceTrendUpdate(
    recentPosts: FeedPost[],
    currentTick: number
  ): Promise<void> {
    await this.updateTrends(recentPosts, currentTick, true);
  }

  /**
   * Check if trends need updating (for external callers)
   *
   * @param currentTick - Current game tick number
   * @returns true if update is due based on interval
   */
  needsUpdate(currentTick: number): boolean {
    return currentTick - this.lastUpdateTick >= this.updateInterval;
  }

  /**
   * Get the last update tick
   */
  getLastUpdateTick(): number {
    return this.lastUpdateTick;
  }
}
