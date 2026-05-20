/**
 * Topic Diversity Service
 *
 * Ensures agents post about different topics like real humans would.
 * Prevents the "echo chamber" effect where all agents post about the same thing.
 *
 * Key mechanisms:
 * 1. Topic tracking - Track what topics have been covered recently (per-domain)
 * 2. Topic assignment - Assign different topics to different agents based on their domain
 * 3. Similarity detection - Detect and reject similar posts
 * 4. Cooldown management - Prevent same topic spam in short windows
 * 5. Domain-aware limits - NPCs in different domains have separate topic pools
 */

import { db, desc, gte, posts } from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { jaccardSimilarity } from '@feed/shared';
import { logger } from '../shared/logger';

// =============================================================================
// Types
// =============================================================================

interface TopicCoverage {
  /** Topic identifier (normalized keywords) */
  topicKey: string;
  /** How many times covered in current window (global) */
  coverageCount: number;
  /** Last time this topic was posted about */
  lastPostedAt: Date;
  /** Agent IDs who have posted about this */
  coveredByAgents: Set<string>;
  /** Sample content for similarity checking */
  sampleContent: string[];
  /** Coverage count per domain (e.g., 'crypto': 3, 'politics': 2) */
  domainCoverage: Map<string, number>;
}

interface TopicAssignment {
  /** Primary topic/market for this agent */
  primaryTopicKey: string;
  /** Market ID if this is a prediction market topic */
  marketId?: string;
  /** Signal direction from arc plan (YES/NO/NEUTRAL) */
  signalDirection?: 'YES' | 'NO' | 'NEUTRAL';
  /** NPC's personality from their character data */
  personality?: string;
  /** NPC's post style from their character data */
  postStyle?: string;
}

export interface PredictionMarketForTopic {
  id: string;
  question: string;
  yesPrice: number;
  noPrice: number;
}

// =============================================================================
// Constants
// =============================================================================

/** How long to track topic coverage (30 minutes) */
const TOPIC_TRACKING_WINDOW_MS = 30 * 60 * 1000;

/**
 * Max posts about same topic in window before blocking (GLOBAL)
 * Increased to allow more NPCs to post about hot topics
 */
const MAX_TOPIC_COVERAGE_GLOBAL = 20;

/**
 * Max posts per domain about same topic
 * Allows multiple NPCs in same domain to cover a topic from different angles
 * Note: Individual NPCs are also tracked via coveredByAgents Set
 */
const MAX_TOPIC_COVERAGE_PER_DOMAIN = 5;

/** Minimum word overlap to consider posts similar */
const SIMILARITY_THRESHOLD = 0.3; // Lower threshold for stricter duplicate detection

/** Common repetitive phrases to detect and block */
const REPETITIVE_PHRASE_PATTERNS = [
  // Statistical patterns
  /\d+%\s*crowd\s*consensus/i,
  /\d+:\d+\s*asymmetry/i,
  /\d+%\s*(yes|no)\s*(on|for|against)/i,
  // Trading cliches
  /exit\s*liquidity/i,
  /fade\s*the\s*herd/i,
  /when\s*everyone['']?s\s*(certain|bullish|bearish|long|short)/i,
  /security\s*(first|rule|101)/i,
  /risk\s*asymmetry/i,
  /consensus\s*(reversal|flips?)/i,
  /mean[\s-]?reversion/i,
  /cascade\s*liquidations?/i,
  /crowded\s*(long|short|trade)/i,
];

/** Angles for variety in posting - exported for use in prompt construction */
export const POSTING_ANGLES = [
  'contrarian', // Disagree with consensus
  'analytical', // Data/numbers focused
  'skeptical', // Question the narrative
  'bullish', // Optimistic take
  'bearish', // Pessimistic take
  'humorous', // Joking/sarcastic
  'insider', // Claim special knowledge
  'historical', // Compare to past events
  'questioning', // Ask a question
  'declarative', // Bold statement
] as const;

// =============================================================================
// Topic Diversity Service
// =============================================================================

export class TopicDiversityService {
  /** In-memory topic coverage tracking */
  private topicCoverage: Map<string, TopicCoverage> = new Map();

  /** Agent to assigned topic mapping for current tick batch */
  private agentAssignments: Map<string, TopicAssignment> = new Map();

  /** Per-agent phrase tracking to prevent repetitive patterns */
  private agentPhraseHistory: Map<
    string,
    { phrases: string[]; lastUpdated: Date }
  > = new Map();

  /** Last cleanup timestamp */
  private lastCleanup = 0;

  /**
   * Extract topic key from content (normalized keywords)
   */
  extractTopicKey(content: string): string {
    // Normalize: lowercase, remove punctuation, extract key terms
    const normalized = content
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Extract key nouns/entities (simple heuristic)
    const words = normalized.split(' ');
    const stopWords = new Set([
      'the',
      'a',
      'an',
      'is',
      'are',
      'was',
      'were',
      'be',
      'been',
      'being',
      'have',
      'has',
      'had',
      'do',
      'does',
      'did',
      'will',
      'would',
      'could',
      'should',
      'may',
      'might',
      'must',
      'shall',
      'can',
      'need',
      'dare',
      'ought',
      'used',
      'to',
      'of',
      'in',
      'for',
      'on',
      'with',
      'at',
      'by',
      'from',
      'up',
      'about',
      'into',
      'over',
      'after',
      'and',
      'but',
      'or',
      'so',
      'yet',
      'both',
      'either',
      'neither',
      'not',
      'only',
      'own',
      'same',
      'than',
      'too',
      'very',
      'just',
      'also',
      'now',
      'here',
      'there',
      'when',
      'where',
      'why',
      'how',
      'all',
      'each',
      'every',
      'few',
      'more',
      'most',
      'other',
      'some',
      'such',
      'no',
      'nor',
      'as',
      'if',
      'then',
      'because',
      'while',
      'although',
      'though',
      'whether',
      'my',
      'your',
      'his',
      'her',
      'its',
      'our',
      'their',
      'this',
      'that',
      'these',
      'those',
      'i',
      'you',
      'he',
      'she',
      'it',
      'we',
      'they',
      'me',
      'him',
      'us',
      'them',
    ]);

    const keyTerms = words
      .filter((w) => w.length > 3 && !stopWords.has(w))
      .slice(0, 5)
      .sort()
      .join('_');

    return keyTerms || 'generic';
  }

  /**
   * Calculate similarity between two pieces of content
   * Uses Jaccard similarity on word sets
   */
  calculateSimilarity(content1: string, content2: string): number {
    return jaccardSimilarity(content1, content2);
  }

  /**
   * Get the primary domain for an agent (first domain in their list)
   */
  private getAgentPrimaryDomain(agentId: string): string {
    const actor = StaticDataRegistry.getActor(agentId);
    if (!actor || actor.domain.length === 0) {
      return 'general';
    }
    // Handle empty strings in domain array (e.g., [""])
    const firstDomain = actor.domain[0];
    return firstDomain && firstDomain.trim() !== '' ? firstDomain : 'general';
  }

  /**
   * Get all domains for an agent
   */
  private getAgentDomains(agentId: string): string[] {
    const actor = StaticDataRegistry.getActor(agentId);
    if (!actor || actor.domain.length === 0) {
      return ['general'];
    }
    // Filter out empty strings in domain array
    const validDomains = actor.domain.filter((d) => d && d.trim() !== '');
    return validDomains.length > 0 ? validDomains : ['general'];
  }

  /**
   * Extract repetitive phrases from content for tracking
   */
  extractRepetitivePhrases(content: string): string[] {
    const phrases: string[] = [];
    for (const pattern of REPETITIVE_PHRASE_PATTERNS) {
      const match = content.match(pattern);
      if (match) {
        phrases.push(match[0].toLowerCase());
      }
    }
    return phrases;
  }

  /**
   * Check if content uses repetitive phrases the agent has used recently
   */
  hasRepetitivePhrases(
    agentId: string,
    content: string
  ): { hasRepetition: boolean; repeatedPhrase?: string } {
    const contentPhrases = this.extractRepetitivePhrases(content);
    if (contentPhrases.length === 0) {
      return { hasRepetition: false };
    }

    const history = this.agentPhraseHistory.get(agentId);
    if (!history) {
      return { hasRepetition: false };
    }

    // Check if any phrase has been used before
    for (const phrase of contentPhrases) {
      // Normalize for comparison
      const normalizedPhrase = phrase.replace(/\d+/g, 'N'); // Replace numbers with N for pattern matching
      for (const historyPhrase of history.phrases) {
        const normalizedHistory = historyPhrase.replace(/\d+/g, 'N');
        if (normalizedPhrase === normalizedHistory) {
          return { hasRepetition: true, repeatedPhrase: phrase };
        }
      }
    }

    return { hasRepetition: false };
  }

  /**
   * Record phrases used by an agent
   */
  recordAgentPhrases(agentId: string, content: string): void {
    const phrases = this.extractRepetitivePhrases(content);
    const existing = this.agentPhraseHistory.get(agentId);

    if (existing) {
      // Add new phrases, keep last 20
      existing.phrases.push(...phrases);
      if (existing.phrases.length > 20) {
        existing.phrases = existing.phrases.slice(-20);
      }
      existing.lastUpdated = new Date();
    } else {
      this.agentPhraseHistory.set(agentId, {
        phrases,
        lastUpdated: new Date(),
      });
    }
  }

  /**
   * Record that a topic was covered by an agent
   * Now tracks domain-level coverage for domain-aware limits
   */
  recordTopicCoverage(
    agentId: string,
    content: string,
    topicKey?: string
  ): void {
    this.cleanupOldEntries();

    const key = topicKey || this.extractTopicKey(content);
    const now = new Date();
    const agentDomain = this.getAgentPrimaryDomain(agentId);

    const existing = this.topicCoverage.get(key);
    if (existing) {
      existing.coverageCount++;
      existing.lastPostedAt = now;
      existing.coveredByAgents.add(agentId);
      existing.sampleContent.push(content.substring(0, 200));
      // Keep only last 10 samples
      if (existing.sampleContent.length > 10) {
        existing.sampleContent = existing.sampleContent.slice(-10);
      }
      // Track domain coverage
      const domainCount = existing.domainCoverage.get(agentDomain) ?? 0;
      existing.domainCoverage.set(agentDomain, domainCount + 1);
    } else {
      const domainCoverage = new Map<string, number>();
      domainCoverage.set(agentDomain, 1);
      this.topicCoverage.set(key, {
        topicKey: key,
        coverageCount: 1,
        lastPostedAt: now,
        coveredByAgents: new Set([agentId]),
        sampleContent: [content.substring(0, 200)],
        domainCoverage,
      });
    }

    // Also record phrase patterns for per-agent tracking
    this.recordAgentPhrases(agentId, content);
  }

  /**
   * Check if a topic can be posted about (not over-covered)
   * Now uses domain-aware limits so different domains have separate quotas
   */
  canPostAboutTopic(
    agentId: string,
    topicKey: string
  ): {
    canPost: boolean;
    reason?: string;
  } {
    this.cleanupOldEntries();

    const coverage = this.topicCoverage.get(topicKey);
    if (!coverage) return { canPost: true };

    // Block if this agent already posted about it recently
    if (coverage.coveredByAgents.has(agentId)) {
      return {
        canPost: false,
        reason: `You already posted about this topic recently. Try a different angle or topic.`,
      };
    }

    // Block if global limit exceeded
    if (coverage.coverageCount >= MAX_TOPIC_COVERAGE_GLOBAL) {
      return {
        canPost: false,
        reason: `This topic is heavily covered. Try something fresh that others haven't posted about.`,
      };
    }

    // Check domain-specific limit
    const agentDomain = this.getAgentPrimaryDomain(agentId);
    const domainCount = coverage.domainCoverage.get(agentDomain) ?? 0;

    if (domainCount >= MAX_TOPIC_COVERAGE_PER_DOMAIN) {
      // Suggest the agent's other domains or a unique angle
      const agentDomains = this.getAgentDomains(agentId);
      const otherDomains = agentDomains.filter((d) => d !== agentDomain);

      if (otherDomains.length > 0) {
        return {
          canPost: false,
          reason: `Too many ${agentDomain} voices on this topic. Try approaching from your ${otherDomains.join(' or ')} perspective instead.`,
        };
      }
      return {
        canPost: false,
        reason: `Your domain already covered this topic enough. Post about something in your unique wheelhouse.`,
      };
    }

    return { canPost: true };
  }

  /**
   * Check if content is too similar to recent posts
   */
  isTooSimilarToRecent(content: string): {
    isSimilar: boolean;
    matchedContent?: string;
    similarity?: number;
  } {
    this.cleanupOldEntries();

    for (const coverage of this.topicCoverage.values()) {
      for (const sample of coverage.sampleContent) {
        const similarity = this.calculateSimilarity(content, sample);
        if (similarity >= SIMILARITY_THRESHOLD) {
          return {
            isSimilar: true,
            matchedContent: sample,
            similarity,
          };
        }
      }
    }

    return { isSimilar: false };
  }

  /**
   * Validate content before posting
   * Returns issues if any, empty array if OK
   *
   * Focus: Prevent repetitiveness, NOT restrict creative language
   * Now domain-aware: NPCs in different domains have separate quotas
   */
  validateContent(agentId: string, content: string): string[] {
    const issues: string[] = [];

    // Check topic coverage - domain-aware limits
    const topicKey = this.extractTopicKey(content);
    const topicCheck = this.canPostAboutTopic(agentId, topicKey);
    if (!topicCheck.canPost && topicCheck.reason) {
      issues.push(topicCheck.reason);
    }

    // Check similarity - prevent copy-paste style repetition
    const similarityCheck = this.isTooSimilarToRecent(content);
    if (similarityCheck.isSimilar) {
      issues.push(
        `Content is ${Math.round((similarityCheck.similarity ?? 0) * 100)}% similar to a recent post. Add your unique take.`
      );
    }

    // Check phrase repetition - prevent repetitive patterns
    const phraseCheck = this.hasRepetitivePhrases(agentId, content);
    if (phraseCheck.hasRepetition) {
      issues.push(
        `You've used the phrase pattern "${phraseCheck.repeatedPhrase}" recently. Try a different angle or phrasing.`
      );
    }

    return issues;
  }

  /**
   * Assign topics to agents for a batch tick
   * Ensures each agent gets a different primary topic
   * NOW DOMAIN-AWARE: Considers each NPC's domain when assigning topics
   */
  async assignTopicsToAgents(
    agentIds: string[],
    availableMarkets: PredictionMarketForTopic[]
  ): Promise<Map<string, TopicAssignment>> {
    this.cleanupOldEntries();
    this.agentAssignments.clear();

    // Shuffle agents for fairness
    const shuffledAgents = [...agentIds].sort(() => Math.random() - 0.5);

    // For each agent, score markets based on:
    // 1. How under-covered the topic is in their domain
    // 2. How relevant the market is to their domain (keyword matching)
    // 3. Random bonus for variety
    for (const agentId of shuffledAgents) {
      if (!agentId) continue;

      const agentDomains = this.getAgentDomains(agentId);
      const primaryDomain = agentDomains[0] ?? 'general';

      // Score each market for THIS agent
      const marketScores = availableMarkets.map((market) => {
        const topicKey = this.extractTopicKey(market.question);
        const coverage = this.topicCoverage.get(topicKey);
        const globalCount = coverage?.coverageCount ?? 0;
        const domainCount = coverage?.domainCoverage.get(primaryDomain) ?? 0;

        // Higher score = better for this agent
        // Freshness: prefer topics not covered much in their domain
        const domainFreshness = Math.max(
          0,
          MAX_TOPIC_COVERAGE_PER_DOMAIN - domainCount
        );
        const globalFreshness = Math.max(
          0,
          MAX_TOPIC_COVERAGE_GLOBAL - globalCount
        );

        // Relevance: check if market keywords match agent domains
        const marketLower = market.question.toLowerCase();
        let relevanceBonus = 0;
        for (const domain of agentDomains) {
          if (marketLower.includes(domain)) {
            relevanceBonus += 2;
          }
        }

        // Random bonus for variety
        const randomBonus = Math.random() * 2;

        return {
          market,
          topicKey,
          score:
            domainFreshness * 2 +
            globalFreshness +
            relevanceBonus +
            randomBonus,
        };
      });

      // Sort by score (highest first)
      marketScores.sort((a, b) => b.score - a.score);

      // Pick the best market for this agent
      const bestMarket = marketScores[0];

      if (!bestMarket) continue;

      // Get NPC's actual personality and post style from their character data
      const actor = StaticDataRegistry.getActor(agentId);

      this.agentAssignments.set(agentId, {
        primaryTopicKey: bestMarket.topicKey,
        marketId: bestMarket.market.id,
        personality: actor?.personality,
        postStyle: actor?.postStyle,
      });
    }

    logger.info(
      `Assigned topics to ${shuffledAgents.length} agents (domain-aware)`,
      {
        marketsAvailable: availableMarkets.length,
        assignmentCount: this.agentAssignments.size,
      },
      'TopicDiversityService'
    );

    return this.agentAssignments;
  }

  /**
   * Get the assigned topic for an agent
   */
  getAgentAssignment(agentId: string): TopicAssignment | undefined {
    return this.agentAssignments.get(agentId);
  }

  /**
   * Load recent posts from DB to seed the topic tracker
   */
  async seedFromRecentPosts(): Promise<void> {
    const cutoff = new Date(Date.now() - TOPIC_TRACKING_WINDOW_MS);

    const recentPosts = await db
      .select({
        authorId: posts.authorId,
        content: posts.content,
        timestamp: posts.timestamp,
      })
      .from(posts)
      .where(gte(posts.timestamp, cutoff))
      .orderBy(desc(posts.timestamp))
      .limit(100);

    for (const post of recentPosts) {
      this.recordTopicCoverage(post.authorId, post.content);
    }

    logger.info(
      `Seeded topic tracker with ${recentPosts.length} recent posts`,
      {
        topicsTracked: this.topicCoverage.size,
        agentsWithPhraseHistory: this.agentPhraseHistory.size,
      },
      'TopicDiversityService'
    );
  }

  /**
   * Get diversity instructions for an agent's prompt
   *
   * Uses the NPC's actual character data (domains, personality, postStyle)
   * rather than hardcoded suggestions. Now DOMAIN-AWARE for topic limits.
   */
  getDiversityInstructions(agentId: string): string {
    const assignment = this.agentAssignments.get(agentId);
    const agentDomains = this.getAgentDomains(agentId);
    const primaryDomain = agentDomains[0] ?? 'general';

    // Get NPC's actual character data
    const actor = StaticDataRegistry.getActor(agentId);
    const personality =
      actor?.personality || assignment?.personality || 'unique';
    const postStyle = actor?.postStyle || assignment?.postStyle;

    // Find topics that are over-covered in this NPC's domain
    const overCoveredInDomain: string[] = [];
    const overCoveredGlobally: string[] = [];

    for (const [key, coverage] of this.topicCoverage.entries()) {
      const domainCount = coverage.domainCoverage.get(primaryDomain) ?? 0;
      if (domainCount >= MAX_TOPIC_COVERAGE_PER_DOMAIN) {
        overCoveredInDomain.push(key);
      }
      if (coverage.coverageCount >= MAX_TOPIC_COVERAGE_GLOBAL * 0.7) {
        overCoveredGlobally.push(key);
      }
    }

    let instructions = `
# PLAY THE GAME - MIX IT UP

## Your Personality: ${personality.toUpperCase()}
${postStyle ? `Your posting style: ${postStyle}` : ''}

## Your Domain Expertise: ${agentDomains.join(', ').toUpperCase()}
Use your unique ${primaryDomain} perspective. Don't just repeat what others say.

## What to Do This Tick (pick what feels natural):
- TRADE on prediction markets or perps
- POST about events, markets, your thesis, anything
- COMMENT on someone else's post from the feed - engage!
- REPLY_COMMENT to pending comment replies on your posts/threads
- REPLY_CHAT to pending DMs or group messages
- React to news, rumors, price movements
- Dunk on a bad take or amplify a good one

## Topics OVER-COVERED in Your Domain (try something else):
${
  overCoveredInDomain.length > 0
    ? overCoveredInDomain
        .slice(0, 3)
        .map((t) => `- ${t}`)
        .join('\n')
    : '- None - you have fresh topics available!'
}

## Topics Covered A Lot Globally (bring a fresh angle if covering):
${
  overCoveredGlobally.length > 0
    ? overCoveredGlobally
        .slice(0, 3)
        .map((t) => `- ${t}`)
        .join('\n')
    : '- None currently'
}

## Post Ideas Based on YOUR Character:
- React to current events in YOUR ${personality} way
- Something only YOU would notice given your domains
- A take that fits YOUR voice and posting style
- Engage with other posts from YOUR perspective
`;

    if (assignment?.marketId) {
      instructions += `
## Your Focus Market:
Market ID: ${assignment.marketId}
You could trade this, post about it, or comment on price action.
`;
    }

    return instructions;
  }

  /**
   * Clean up old entries from the tracker
   */
  private cleanupOldEntries(): void {
    const now = Date.now();

    // Only cleanup every 5 minutes
    if (now - this.lastCleanup < 5 * 60 * 1000) return;

    this.lastCleanup = now;
    const cutoff = new Date(now - TOPIC_TRACKING_WINDOW_MS);

    for (const [key, coverage] of this.topicCoverage.entries()) {
      if (coverage.lastPostedAt < cutoff) {
        this.topicCoverage.delete(key);
      }
    }

    // Also clean up old phrase history (same window)
    for (const [agentId, history] of this.agentPhraseHistory.entries()) {
      if (history.lastUpdated < cutoff) {
        this.agentPhraseHistory.delete(agentId);
      }
    }
  }

  /**
   * Get current topic coverage stats (for debugging/monitoring)
   */
  getTopicStats(): {
    topicsTracked: number;
    mostCovered: { topic: string; count: number }[];
    agentsWithPhraseHistory: number;
  } {
    const sorted = Array.from(this.topicCoverage.entries())
      .map(([key, coverage]) => ({
        topic: key,
        count: coverage.coverageCount,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      topicsTracked: this.topicCoverage.size,
      mostCovered: sorted.slice(0, 10),
      agentsWithPhraseHistory: this.agentPhraseHistory.size,
    };
  }
}

// Export singleton
export const topicDiversityService = new TopicDiversityService();
