/**
 * Topic Diversity Service
 *
 * @module engine/services/topic-diversity-service
 *
 * @description
 * Breaks the "trending flywheel" by tracking topic saturation and enforcing
 * diversity quotas. Prevents news outlets from converging on singular topics.
 *
 * **Problem Solved:**
 * Without diversity controls, content generation creates a reinforcing loop:
 * Questions → Content about Questions → Engagement → More Content about same Questions
 *
 * **Diversity Mechanisms:**
 * 1. **Topic Saturation Tracking** - Tracks recent coverage per topic
 * 2. **Saturation Penalties** - Topics covered >30% get generation penalties
 * 3. **Cool-down Periods** - Topics need breathing room between articles
 * 4. **Diversity Quotas** - Forces percentage of content to be "off-trend"
 *
 * @example
 * ```typescript
 * const diversityService = new TopicDiversityService();
 *
 * // Check if topic is oversaturated
 * const penalty = await diversityService.getTopicPenalty('ai-regulation');
 * if (penalty > 0.5) {
 *   // Skip or reduce probability of covering this topic
 * }
 *
 * // Get diverse topic suggestions
 * const suggestions = await diversityService.suggestDiverseTopics(5);
 * ```
 */

import { and, db, desc, eq, gte, isNull, posts } from "@feed/db";
import { logger } from "@feed/shared";

/**
 * Editorial beat categories that news outlets can specialize in
 */
export type EditorialBeat =
  | "tech"
  | "finance"
  | "politics"
  | "crypto"
  | "ai"
  | "culture"
  | "business"
  | "science"
  | "regulation"
  | "markets"
  | "startups"
  | "media";

/**
 * Topic coverage record for saturation tracking
 */
interface TopicCoverage {
  topic: string;
  articleCount: number;
  lastCoveredAt: Date;
  beat: EditorialBeat;
}

/**
 * Diverse topic suggestion with metadata
 */
export interface DiverseTopicSuggestion {
  topic: string;
  beat: EditorialBeat;
  reason: string;
  priority: number; // 0-1, higher = more needed
  cooldownRemaining: number; // hours until fully available
}

/**
 * Event coverage record for event-level deduplication
 */
interface EventCoverage {
  /** Unique identifier for the event (e.g., "bitcoin-$94000-breakout") */
  eventId: string;
  /** Number of posts/articles about this specific event */
  postCount: number;
  /** When the first post about this event was made */
  firstCoveredAt: Date;
  /** When the most recent post was made */
  lastCoveredAt: Date;
  /** Keywords associated with this event */
  keywords: string[];
}

/**
 * Configuration for diversity quotas
 */
interface DiversityConfig {
  /** Max percentage of articles about any single topic in window */
  maxTopicSaturation: number;
  /** Hours before same topic can be heavily covered again */
  cooldownHours: number;
  /** Minimum percentage of articles that must be "off-trend" */
  diversityQuota: number;
  /** Hours to look back for saturation calculation */
  windowHours: number;
  /** Maximum posts allowed per specific event to prevent duplicates */
  maxPostsPerEvent: number;
  /** Hours until an event is considered "old" and removed from tracking */
  eventExpiryHours: number;
}

/**
 * Time window (in minutes) to limit burst posts about the same event.
 * If an event received more than BURST_LIMIT_POST_COUNT posts within this window,
 * skip further posts to prevent content flooding.
 */
const RECENT_COVERAGE_WINDOW_MINUTES = 30;

/**
 * Maximum posts allowed within the recent coverage window (burst protection).
 * This is separate from maxPostsPerEvent - it prevents rapid-fire posts.
 */
const BURST_LIMIT_POST_COUNT = 2;

const DEFAULT_CONFIG: DiversityConfig = {
  maxTopicSaturation: 0.3, // No topic should be >30% of recent coverage
  cooldownHours: 4, // 4 hours between heavy coverage of same topic
  diversityQuota: 0.25, // 25% of articles must be diverse/off-trend
  windowHours: 6, // Look at last 6 hours
  maxPostsPerEvent: 2, // Max 2 posts per specific event (1 breaking + 1 follow-up)
  eventExpiryHours: 12, // Events expire after 12 hours
};

/**
 * Editorial beat assignments based on organization descriptions
 * Maps organization IDs to their primary beats
 */
export const ORGANIZATION_BEATS: Record<string, EditorialBeat[]> = {
  // Tech-focused
  techcrainch: ["startups", "tech", "ai"],
  waired: ["tech", "culture", "science"],
  "the-vairge": ["tech", "culture", "media"],
  "the-informaition": ["tech", "business", "startups"],

  // Finance-focused
  bloombairg: ["finance", "markets", "business"],
  "wall-street-journai": ["finance", "business", "politics"],
  "financial-taimes": ["finance", "markets", "regulation"],
  forbesai: ["business", "finance", "startups"],

  // Politics-focused
  politaico: ["politics", "regulation", "media"],
  "the-atlaintic": ["politics", "culture", "media"],
  "new-republic": ["politics", "culture"],
  "the-intaircept": ["politics", "regulation", "tech"],

  // Opinion/Commentary
  "the-daily-wire": ["politics", "culture", "media"],
  braitbart: ["politics", "culture"],
  ainfowars: ["politics", "media"],
  "piraite-wires": ["tech", "politics", "culture"],

  // General news
  aixios: ["politics", "tech", "business"],
  ainbc: ["politics", "media", "culture"],
  "faix-news": ["politics", "media"],
  "aimerica-first": ["politics", "culture"],

  // Crypto/Finance specialty
  "the-economaist": ["finance", "politics", "regulation"],
};

/**
 * Story seeds for diverse topic generation
 * These are topic templates that aren't tied to prediction market questions
 */
export const STORY_SEEDS: Array<{
  template: string;
  beat: EditorialBeat;
  variables: string[];
}> = [
  // Tech stories
  {
    template:
      "New developments in {technology} raise questions about {concern}",
    beat: "tech",
    variables: ["quantum computing", "privacy", "data security", "AI ethics"],
  },
  {
    template: "{company} announces major restructuring amid {trend}",
    beat: "business",
    variables: [
      "layoffs",
      "AI pivot",
      "market pressure",
      "regulatory scrutiny",
    ],
  },
  {
    template: "Industry insiders debate the future of {sector}",
    beat: "tech",
    variables: [
      "social media",
      "streaming",
      "cloud computing",
      "autonomous vehicles",
    ],
  },

  // Finance stories
  {
    template: "{market} shows signs of {trend} as investors {action}",
    beat: "markets",
    variables: ["volatility", "recovery", "caution", "optimism"],
  },
  {
    template: "Analysis: What {indicator} means for {asset_class}",
    beat: "finance",
    variables: ["Fed policy", "inflation data", "employment numbers", "GDP"],
  },
  {
    template: "Institutional investors {sentiment} on {sector} outlook",
    beat: "finance",
    variables: ["bullish", "bearish", "cautious", "divided"],
  },

  // Politics stories
  {
    template: "{official} faces scrutiny over {issue}",
    beat: "politics",
    variables: [
      "policy stance",
      "past statements",
      "campaign donors",
      "voting record",
    ],
  },
  {
    template: "New {regulation_type} proposals could reshape {industry}",
    beat: "regulation",
    variables: ["antitrust", "privacy", "AI", "crypto"],
  },
  {
    template: "Inside the battle over {policy_area} reform",
    beat: "politics",
    variables: [
      "tech regulation",
      "financial oversight",
      "immigration",
      "healthcare",
    ],
  },

  // AI stories
  {
    template: "{ai_development} raises new questions about {concern}",
    beat: "ai",
    variables: ["job displacement", "copyright", "safety", "regulation"],
  },
  {
    template: "Researchers {finding} about {ai_capability}",
    beat: "ai",
    variables: ["warn", "celebrate", "debate"],
  },

  // Culture/Media stories
  {
    template: "The rise of {trend} is reshaping {industry}",
    beat: "culture",
    variables: ["creator economy", "streaming", "podcasts", "newsletters"],
  },
  {
    template: "Why {phenomenon} matters for the future of {domain}",
    beat: "media",
    variables: [
      "news consumption",
      "social media",
      "advertising",
      "content creation",
    ],
  },
];

/**
 * Topic Diversity Service
 *
 * Tracks topic saturation and enforces diversity quotas to prevent
 * the content generation flywheel from converging on singular topics.
 */
export class TopicDiversityService {
  private config: DiversityConfig;
  private topicCache: Map<string, TopicCoverage> = new Map();
  private lastCacheRefresh: Date = new Date(0);
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  // Event-level deduplication tracking
  private eventCache: Map<string, EventCoverage> = new Map();
  private lastEventCleanup: Date = new Date(0);
  private readonly EVENT_CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

  constructor(config: Partial<DiversityConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Generate a normalized event ID from content keywords
   * Used for deduplication across similar stories
   */
  private generateEventId(keywords: string[]): string {
    const normalized = [...new Set(keywords.map((k) => k.toLowerCase().trim()))]
      .filter((k) => k.length > 2)
      .sort()
      .join("-");
    return normalized || "generic-event";
  }

  /**
   * Clean up expired events from the cache
   */
  private cleanupExpiredEvents(): void {
    const nowMs = Date.now();
    if (
      nowMs - this.lastEventCleanup.getTime() <
      this.EVENT_CLEANUP_INTERVAL_MS
    ) {
      return;
    }

    const expiryTimeMs = nowMs - this.config.eventExpiryHours * 60 * 60 * 1000;

    let removed = 0;
    for (const [eventId, coverage] of this.eventCache.entries()) {
      if (coverage.lastCoveredAt.getTime() < expiryTimeMs) {
        this.eventCache.delete(eventId);
        removed++;
      }
    }

    if (removed > 0) {
      logger.debug(
        `Cleaned up ${removed} expired events`,
        { remaining: this.eventCache.size },
        "TopicDiversityService",
      );
    }

    this.lastEventCleanup = new Date(nowMs);
  }

  /**
   * Track that an event has been covered
   *
   * @param eventKeywords - Keywords that identify this specific event
   * @returns The event ID that was tracked
   */
  trackEventCoverage(eventKeywords: string[]): string {
    this.cleanupExpiredEvents();

    const eventId = this.generateEventId(eventKeywords);
    const nowMs = Date.now();
    const now = new Date(nowMs);

    const existing = this.eventCache.get(eventId);
    if (existing) {
      existing.postCount++;
      existing.lastCoveredAt = now;
      // Merge keywords
      eventKeywords.forEach((k) => {
        const normalized = k.toLowerCase().trim();
        if (!existing.keywords.includes(normalized)) {
          existing.keywords.push(normalized);
        }
      });
    } else {
      this.eventCache.set(eventId, {
        eventId,
        postCount: 1,
        firstCoveredAt: now,
        lastCoveredAt: now,
        keywords: eventKeywords.map((k) => k.toLowerCase().trim()),
      });
    }

    logger.debug(
      `Event tracked: ${eventId}`,
      {
        postCount: this.eventCache.get(eventId)?.postCount,
        keywords: eventKeywords.slice(0, 5),
      },
      "TopicDiversityService",
    );

    return eventId;
  }

  /**
   * Rollback event coverage tracking when post generation fails.
   * Decrements the post count for the event to prevent artificial saturation.
   *
   * @param eventKeywords - Keywords that identify this specific event
   */
  rollbackEventCoverage(eventKeywords: string[]): void {
    const eventId = this.generateEventId(eventKeywords);
    const existing = this.eventCache.get(eventId);

    if (existing && existing.postCount > 0) {
      existing.postCount--;
      logger.debug(
        `Event coverage rolled back: ${eventId}`,
        { newPostCount: existing.postCount },
        "TopicDiversityService",
      );

      // Remove entry entirely if no posts remain
      if (existing.postCount === 0) {
        this.eventCache.delete(eventId);
      }
    }
  }

  /**
   * Check if an event has reached its coverage limit
   *
   * @param eventKeywords - Keywords that identify this specific event
   * @returns True if the event should be skipped (too many posts already)
   */
  shouldSkipEvent(eventKeywords: string[]): boolean {
    this.cleanupExpiredEvents();

    const eventId = this.generateEventId(eventKeywords);
    const coverage = this.eventCache.get(eventId);

    if (!coverage) {
      return false; // New event, allow coverage
    }

    if (coverage.postCount >= this.config.maxPostsPerEvent) {
      logger.debug(
        `Event saturated, skipping: ${eventId}`,
        { postCount: coverage.postCount, max: this.config.maxPostsPerEvent },
        "TopicDiversityService",
      );
      return true;
    }

    // Also check if there's been very recent coverage (within the recency window)
    // This is burst protection: even if under maxPostsPerEvent, prevent rapid-fire posts
    const recentCoverageThresholdMs =
      Date.now() - RECENT_COVERAGE_WINDOW_MINUTES * 60 * 1000;
    if (
      coverage.lastCoveredAt.getTime() > recentCoverageThresholdMs &&
      coverage.postCount >= BURST_LIMIT_POST_COUNT
    ) {
      // Burst protection: too many posts in short time window
      logger.debug(
        `Event recently covered, skipping: ${eventId}`,
        { lastCovered: coverage.lastCoveredAt.toISOString() },
        "TopicDiversityService",
      );
      return true;
    }

    return false;
  }

  /**
   * Get the current coverage count for an event
   *
   * @param eventKeywords - Keywords that identify this specific event
   * @returns Coverage info or null if not tracked
   */
  getEventCoverage(eventKeywords: string[]): EventCoverage | null {
    const eventId = this.generateEventId(eventKeywords);
    return this.eventCache.get(eventId) ?? null;
  }

  /**
   * Get event coverage stats for monitoring
   */
  getEventStats(): {
    totalEvents: number;
    saturatedEvents: number;
    recentEvents: number;
  } {
    this.cleanupExpiredEvents();

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    let saturated = 0;
    let recent = 0;

    for (const coverage of this.eventCache.values()) {
      if (coverage.postCount >= this.config.maxPostsPerEvent) saturated++;
      if (coverage.lastCoveredAt > oneHourAgo) recent++;
    }

    return {
      totalEvents: this.eventCache.size,
      saturatedEvents: saturated,
      recentEvents: recent,
    };
  }

  /**
   * Refresh topic coverage cache from database
   */
  private async refreshCache(): Promise<void> {
    const now = new Date();
    if (now.getTime() - this.lastCacheRefresh.getTime() < this.CACHE_TTL_MS) {
      return; // Cache still fresh
    }

    const windowStart = new Date(
      now.getTime() - this.config.windowHours * 60 * 60 * 1000,
    );

    // Get recent articles and extract topics from titles/content
    const recentArticles = await db
      .select({
        articleTitle: posts.articleTitle,
        content: posts.content,
        timestamp: posts.timestamp,
      })
      .from(posts)
      .where(
        and(
          eq(posts.type, "article"),
          gte(posts.timestamp, windowStart),
          isNull(posts.deletedAt),
        ),
      )
      .orderBy(desc(posts.timestamp));

    // Extract and count topics
    this.topicCache.clear();
    for (const article of recentArticles) {
      const topics = this.extractTopics(
        `${article.articleTitle || ""} ${article.content || ""}`,
      );
      for (const topic of topics) {
        const existing = this.topicCache.get(topic.toLowerCase());
        if (existing) {
          existing.articleCount++;
          if (article.timestamp && article.timestamp > existing.lastCoveredAt) {
            existing.lastCoveredAt = article.timestamp;
          }
        } else {
          this.topicCache.set(topic.toLowerCase(), {
            topic,
            articleCount: 1,
            lastCoveredAt: article.timestamp || new Date(),
            beat: this.inferBeat(topic),
          });
        }
      }
    }

    this.lastCacheRefresh = now;
    logger.debug(
      "Topic diversity cache refreshed",
      { topicCount: this.topicCache.size, articleCount: recentArticles.length },
      "TopicDiversityService",
    );
  }

  /**
   * Extract topic keywords from text
   */
  private extractTopics(text: string): string[] {
    const topics: string[] = [];
    const lowercaseText = text.toLowerCase();

    // Key topic indicators
    const topicPatterns = [
      // Tech/AI
      { pattern: /\b(ai|artificial intelligence)\b/i, topic: "ai" },
      { pattern: /\b(machine learning|ml)\b/i, topic: "machine-learning" },
      { pattern: /\b(gpt|chatgpt|llm)\b/i, topic: "llms" },
      { pattern: /\b(openai|anthropic|google ai)\b/i, topic: "ai-companies" },

      // Crypto
      { pattern: /\b(bitcoin|btc)\b/i, topic: "bitcoin" },
      { pattern: /\b(ethereum|eth)\b/i, topic: "ethereum" },
      { pattern: /\b(crypto|cryptocurrency)\b/i, topic: "crypto" },
      { pattern: /\b(defi|decentralized finance)\b/i, topic: "defi" },
      { pattern: /\b(nft|nfts)\b/i, topic: "nfts" },
      { pattern: /\b(stablecoin)\b/i, topic: "stablecoins" },

      // Finance
      { pattern: /\b(fed|federal reserve)\b/i, topic: "federal-reserve" },
      { pattern: /\b(interest rate)\b/i, topic: "interest-rates" },
      { pattern: /\b(inflation)\b/i, topic: "inflation" },
      { pattern: /\b(stock market|s&p|nasdaq)\b/i, topic: "stock-market" },
      { pattern: /\b(recession)\b/i, topic: "recession" },

      // Politics
      { pattern: /\b(election|vote|voting)\b/i, topic: "elections" },
      { pattern: /\b(congress|senate|house)\b/i, topic: "congress" },
      { pattern: /\b(regulation|regulatory)\b/i, topic: "regulation" },
      { pattern: /\b(antitrust)\b/i, topic: "antitrust" },

      // Tech companies
      { pattern: /\b(tesla|spacex)\b/i, topic: "tesla-spacex" },
      { pattern: /\b(apple)\b/i, topic: "apple" },
      { pattern: /\b(meta|facebook)\b/i, topic: "meta" },
      { pattern: /\b(google|alphabet)\b/i, topic: "google" },
      { pattern: /\b(microsoft)\b/i, topic: "microsoft" },
      { pattern: /\b(amazon)\b/i, topic: "amazon" },
    ];

    for (const { pattern, topic } of topicPatterns) {
      if (pattern.test(lowercaseText)) {
        topics.push(topic);
      }
    }

    return [...new Set(topics)]; // Dedupe
  }

  /**
   * Infer editorial beat from topic
   */
  private inferBeat(topic: string): EditorialBeat {
    const topicLower = topic.toLowerCase();

    if (
      ["ai", "machine-learning", "llms", "ai-companies"].includes(topicLower)
    ) {
      return "ai";
    }
    if (
      ["bitcoin", "ethereum", "crypto", "defi", "nfts", "stablecoins"].includes(
        topicLower,
      )
    ) {
      return "crypto";
    }
    if (
      [
        "federal-reserve",
        "interest-rates",
        "inflation",
        "stock-market",
        "recession",
      ].includes(topicLower)
    ) {
      return "finance";
    }
    if (
      ["elections", "congress", "regulation", "antitrust"].includes(topicLower)
    ) {
      return "politics";
    }
    if (
      [
        "tesla-spacex",
        "apple",
        "meta",
        "google",
        "microsoft",
        "amazon",
      ].includes(topicLower)
    ) {
      return "tech";
    }

    return "tech"; // Default
  }

  /**
   * Get saturation penalty for a topic (0-1, higher = more saturated)
   *
   * @param topicOrKeywords - Topic name or keywords to check
   * @returns Penalty score 0-1 (0 = not saturated, 1 = heavily saturated)
   */
  async getTopicPenalty(topicOrKeywords: string): Promise<number> {
    await this.refreshCache();

    const topics = this.extractTopics(topicOrKeywords);
    if (topics.length === 0) {
      return 0; // Unknown topic, no penalty
    }

    let maxPenalty = 0;
    const totalArticles = Array.from(this.topicCache.values()).reduce(
      (sum, t) => sum + t.articleCount,
      0,
    );

    for (const topic of topics) {
      const coverage = this.topicCache.get(topic.toLowerCase());
      if (!coverage) continue;

      // Calculate saturation ratio
      const saturationRatio =
        totalArticles > 0 ? coverage.articleCount / totalArticles : 0;

      // Calculate cooldown penalty
      const hoursSinceLastCoverage =
        (Date.now() - coverage.lastCoveredAt.getTime()) / (1000 * 60 * 60);
      const cooldownPenalty =
        hoursSinceLastCoverage < this.config.cooldownHours
          ? 1 - hoursSinceLastCoverage / this.config.cooldownHours
          : 0;

      // Combined penalty
      const saturationPenalty =
        saturationRatio > this.config.maxTopicSaturation
          ? (saturationRatio - this.config.maxTopicSaturation) /
            (1 - this.config.maxTopicSaturation)
          : 0;

      const penalty = Math.max(saturationPenalty, cooldownPenalty * 0.5);
      maxPenalty = Math.max(maxPenalty, penalty);
    }

    return Math.min(1, maxPenalty);
  }

  /**
   * Check if a topic should be skipped due to saturation
   */
  async shouldSkipTopic(topicOrKeywords: string): Promise<boolean> {
    const penalty = await this.getTopicPenalty(topicOrKeywords);
    // Skip if penalty > 0.7, or use random chance based on penalty
    if (penalty > 0.7) return true;
    if (penalty > 0.3 && Math.random() < penalty) return true;
    return false;
  }

  /**
   * Get diverse topic suggestions that are underrepresented
   *
   * @param count - Number of suggestions to return
   * @param excludeBeats - Beats to exclude from suggestions
   * @returns Array of diverse topic suggestions
   */
  async suggestDiverseTopics(
    count: number,
    excludeBeats: EditorialBeat[] = [],
  ): Promise<DiverseTopicSuggestion[]> {
    await this.refreshCache();

    const suggestions: DiverseTopicSuggestion[] = [];
    const coveredBeats = new Set<EditorialBeat>();

    // Identify which beats are oversaturated
    for (const coverage of this.topicCache.values()) {
      coveredBeats.add(coverage.beat);
    }

    // Generate suggestions from story seeds (filtering excluded beats)
    for (const seed of STORY_SEEDS) {
      if (excludeBeats.includes(seed.beat)) continue;
      if (suggestions.length >= count) break;

      // Check if this beat is underrepresented
      const beatCoverage = Array.from(this.topicCache.values()).filter(
        (t) => t.beat === seed.beat,
      );
      const beatArticleCount = beatCoverage.reduce(
        (sum, t) => sum + t.articleCount,
        0,
      );
      const totalArticles = Array.from(this.topicCache.values()).reduce(
        (sum, t) => sum + t.articleCount,
        0,
      );

      const beatRatio =
        totalArticles > 0 ? beatArticleCount / totalArticles : 0;
      const priority = 1 - beatRatio; // Higher priority for less covered beats

      // Generate a concrete topic from the template
      const variable =
        seed.variables[Math.floor(Math.random() * seed.variables.length)];
      const topic = seed.template
        .replace(/{[^}]+}/g, variable || "developments")
        .trim();

      suggestions.push({
        topic,
        beat: seed.beat,
        reason:
          beatRatio < 0.1
            ? `${seed.beat} is underrepresented (${(beatRatio * 100).toFixed(0)}% of coverage)`
            : `Diversify coverage beyond trending topics`,
        priority,
        cooldownRemaining: 0,
      });
    }

    // Sort by priority and return top N
    return suggestions.sort((a, b) => b.priority - a.priority).slice(0, count);
  }

  /**
   * Get topics that are in cooldown
   */
  async getTopicsInCooldown(): Promise<
    Array<{ topic: string; hoursRemaining: number }>
  > {
    await this.refreshCache();

    const now = Date.now();
    const cooldownTopics: Array<{ topic: string; hoursRemaining: number }> = [];

    for (const coverage of this.topicCache.values()) {
      const hoursSinceLastCoverage =
        (now - coverage.lastCoveredAt.getTime()) / (1000 * 60 * 60);
      if (hoursSinceLastCoverage < this.config.cooldownHours) {
        cooldownTopics.push({
          topic: coverage.topic,
          hoursRemaining: this.config.cooldownHours - hoursSinceLastCoverage,
        });
      }
    }

    return cooldownTopics.sort((a, b) => b.hoursRemaining - a.hoursRemaining);
  }

  /**
   * Get editorial beats for an organization
   */
  getOrganizationBeats(orgId: string): EditorialBeat[] {
    return ORGANIZATION_BEATS[orgId] || ["tech", "business"]; // Default beats
  }

  /**
   * Check if an organization should cover a topic based on their beats
   */
  isTopicOnBeat(orgId: string, topicOrKeywords: string): boolean {
    const orgBeats = this.getOrganizationBeats(orgId);
    const topicBeat = this.inferBeat(topicOrKeywords);
    return orgBeats.includes(topicBeat);
  }

  /**
   * Get coverage statistics
   */
  async getCoverageStats(): Promise<{
    topicCount: number;
    totalArticles: number;
    topTopics: Array<{ topic: string; count: number; percentage: number }>;
    beatDistribution: Record<EditorialBeat, number>;
  }> {
    await this.refreshCache();

    const totalArticles = Array.from(this.topicCache.values()).reduce(
      (sum, t) => sum + t.articleCount,
      0,
    );

    const topTopics = Array.from(this.topicCache.values())
      .sort((a, b) => b.articleCount - a.articleCount)
      .slice(0, 10)
      .map((t) => ({
        topic: t.topic,
        count: t.articleCount,
        percentage:
          totalArticles > 0 ? (t.articleCount / totalArticles) * 100 : 0,
      }));

    const beatDistribution: Record<EditorialBeat, number> = {
      tech: 0,
      finance: 0,
      politics: 0,
      crypto: 0,
      ai: 0,
      culture: 0,
      business: 0,
      science: 0,
      regulation: 0,
      markets: 0,
      startups: 0,
      media: 0,
    };

    for (const coverage of this.topicCache.values()) {
      beatDistribution[coverage.beat] += coverage.articleCount;
    }

    return {
      topicCount: this.topicCache.size,
      totalArticles,
      topTopics,
      beatDistribution,
    };
  }
}

// Singleton instance
let diversityServiceInstance: TopicDiversityService | null = null;

/**
 * Get the singleton TopicDiversityService instance
 */
export function getTopicDiversityService(): TopicDiversityService {
  if (!diversityServiceInstance) {
    diversityServiceInstance = new TopicDiversityService();
  }
  return diversityServiceInstance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetTopicDiversityService(): void {
  diversityServiceInstance = null;
}
