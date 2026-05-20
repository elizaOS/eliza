/**
 * Random Context Provider
 *
 * Fetches random contextual data to inject into prompts for entropy:
 * - Active questions/predictions
 * - Market gainers/losers
 * - Trending posts
 * - Recent news/events
 *
 * This adds variety and prevents AI from falling into repetitive patterns.
 */

import {
  db,
  desc,
  eq,
  getDbInstance,
  gte,
  lte,
  markets,
  posts,
  worldEvents,
} from '@feed/db';
import { logger } from '@feed/shared';
import { StaticDataRegistry } from '../services/static-data-registry';
import { sampleRandom, shuffleArray } from '../utils/randomization';

export interface RandomMarketContext {
  gainers?: Array<{ name: string; price: number; change: number }>;
  losers?: Array<{ name: string; price: number; change: number }>;
  activeQuestions?: Array<{ question: string; yesPrice: number }>;
  trendingPosts?: Array<{ author: string; content: string; likes: number }>;
  recentEvents?: Array<{ title: string; description: string }>;
}

/**
 * Get top market gainers (stocks with biggest price increases)
 */
async function getMarketGainers(
  limit = 3
): Promise<Array<{ name: string; price: number; change: number }>> {
  try {
    // Get static org data and dynamic prices
    const staticOrgs = StaticDataRegistry.getAllOrganizations().filter(
      (o) => o.type === 'company'
    );
    const orgStates = await getDbInstance().getAllOrganizationStates();
    const priceMap = new Map(
      orgStates.map((s): [string, number | null] => [s.id, s.currentPrice])
    );

    const withChanges = staticOrgs
      .filter((c) => {
        const currentPrice = priceMap.get(c.id) ?? c.initialPrice;
        return currentPrice !== null && c.initialPrice !== null;
      })
      .map((c) => {
        const current = priceMap.get(c.id) ?? c.initialPrice ?? 0;
        const initial = c.initialPrice ?? 0;
        const change = initial > 0 ? ((current - initial) / initial) * 100 : 0;
        return { name: c.name, price: current, change };
      })
      .filter((c) => c.change > 0)
      .sort((a, b) => b.change - a.change)
      .slice(0, limit);

    return withChanges;
  } catch (error) {
    logger.error('Error fetching market gainers', { error }, 'random-context');
    return [];
  }
}

/**
 * Get top market losers (stocks with biggest price decreases)
 */
async function getMarketLosers(
  limit = 3
): Promise<Array<{ name: string; price: number; change: number }>> {
  try {
    // Get static org data and dynamic prices (reuse data from gainers)
    const staticOrgs = StaticDataRegistry.getAllOrganizations().filter(
      (o) => o.type === 'company'
    );
    const orgStates = await getDbInstance().getAllOrganizationStates();
    const priceMap = new Map(
      orgStates.map((s): [string, number | null] => [s.id, s.currentPrice])
    );

    const withChanges = staticOrgs
      .filter((c) => {
        const currentPrice = priceMap.get(c.id) ?? c.initialPrice;
        return currentPrice !== null && c.initialPrice !== null;
      })
      .map((c) => {
        const current = priceMap.get(c.id) ?? c.initialPrice ?? 0;
        const initial = c.initialPrice ?? 0;
        const change = initial > 0 ? ((current - initial) / initial) * 100 : 0;
        return { name: c.name, price: current, change };
      })
      .filter((c) => c.change < 0)
      .sort((a, b) => a.change - b.change) // Most negative first
      .slice(0, limit);

    return withChanges;
  } catch (error) {
    logger.error('Error fetching market losers', { error }, 'random-context');
    return [];
  }
}

/**
 * Get random active prediction questions
 */
async function getActiveQuestions(
  limit = 3
): Promise<Array<{ question: string; yesPrice: number }>> {
  try {
    const now = new Date();
    const marketsResult = await db
      .select()
      .from(markets)
      .where(and(eq(markets.resolved, false), gte(markets.endDate, now)))
      .limit(20); // Get more, then sample randomly

    const formatted = marketsResult.map((m) => {
      const yesShares = Number.parseFloat(m.yesShares.toString());
      const noShares = Number.parseFloat(m.noShares.toString());
      const totalShares = yesShares + noShares;
      const yesPrice =
        totalShares > 0 ? Math.round((yesShares / totalShares) * 100) : 50;

      return { question: m.question, yesPrice };
    });

    // Randomly sample
    return sampleRandom(formatted, limit);
  } catch (error) {
    logger.error(
      'Error fetching active questions',
      { error },
      'random-context'
    );
    return [];
  }
}

/**
 * Get trending posts (high engagement)
 */
async function getTrendingPosts(
  limit = 3
): Promise<Array<{ author: string; content: string; likes: number }>> {
  try {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const postsResult = await db
      .select()
      .from(posts)
      .where(and(gte(posts.timestamp, oneDayAgo), lte(posts.timestamp, now)))
      .orderBy(desc(posts.timestamp))
      .limit(20); // Get more, then sample

    const formatted = postsResult.map((p) => ({
      author: 'Unknown', // Author info would need a join with User table
      content:
        p.content.length > 150 ? p.content.slice(0, 150) + '...' : p.content,
      likes: 0, // Like count would need aggregation from Reaction table
    }));

    // Randomly sample from top posts
    return sampleRandom(formatted, limit);
  } catch (error) {
    logger.error('Error fetching trending posts', { error }, 'random-context');
    return [];
  }
}

/**
 * Get recent world events
 */
async function getRecentEvents(
  limit = 2
): Promise<Array<{ title: string; description: string }>> {
  try {
    const now = new Date();
    const eventsResult = await db
      .select()
      .from(worldEvents)
      .where(lte(worldEvents.timestamp, now))
      .orderBy(desc(worldEvents.timestamp))
      .limit(10); // Get more, then sample

    const formatted = eventsResult.map((e) => ({
      title: e.eventType, // Use eventType as title since there's no title field
      description:
        e.description.length > 100
          ? e.description.slice(0, 100) + '...'
          : e.description,
    }));

    return sampleRandom(formatted, limit);
  } catch (error) {
    logger.error('Error fetching recent events', { error }, 'random-context');
    return [];
  }
}

/**
 * Generate a random market context bundle
 * Each call returns different random samples for variety
 */
export async function generateRandomMarketContext(options?: {
  includeGainers?: boolean;
  includeLosers?: boolean;
  includeQuestions?: boolean;
  includePosts?: boolean;
  includeEvents?: boolean;
}): Promise<RandomMarketContext> {
  const {
    includeGainers = true,
    includeLosers = true,
    includeQuestions = true,
    includePosts = true,
    includeEvents = true,
  } = options || {};

  const [gainers, losers, activeQuestions, trendingPosts, recentEvents] =
    await Promise.all([
      includeGainers ? getMarketGainers(3) : Promise.resolve(undefined),
      includeLosers ? getMarketLosers(3) : Promise.resolve(undefined),
      includeQuestions ? getActiveQuestions(3) : Promise.resolve(undefined),
      includePosts ? getTrendingPosts(3) : Promise.resolve(undefined),
      includeEvents ? getRecentEvents(2) : Promise.resolve(undefined),
    ]);

  return {
    gainers,
    losers,
    activeQuestions,
    trendingPosts,
    recentEvents,
  };
}

/**
 * Format random context as a string for injection into prompts
 */
export function formatRandomContext(context: RandomMarketContext): string {
  const parts: string[] = [];

  if (context.gainers && context.gainers.length > 0) {
    parts.push(
      `Top Gainers: ${context.gainers.map((g) => `${g.name} (+${g.change.toFixed(1)}%)`).join(', ')}`
    );
  }

  if (context.losers && context.losers.length > 0) {
    parts.push(
      `Top Losers: ${context.losers.map((l) => `${l.name} (${l.change.toFixed(1)}%)`).join(', ')}`
    );
  }

  if (context.activeQuestions && context.activeQuestions.length > 0) {
    parts.push(
      `Active Questions:\n${context.activeQuestions.map((q) => `- ${q.question} (${q.yesPrice}% Yes)`).join('\n')}`
    );
  }

  if (context.trendingPosts && context.trendingPosts.length > 0) {
    parts.push(
      `Trending Posts:\n${context.trendingPosts.map((p) => `- @${p.author}: "${p.content}" (${p.likes} likes)`).join('\n')}`
    );
  }

  if (context.recentEvents && context.recentEvents.length > 0) {
    parts.push(
      `Recent Events:\n${context.recentEvents.map((e) => `- ${e.title}: ${e.description}`).join('\n')}`
    );
  }

  return parts.length > 0
    ? `\n\nCurrent Context (for awareness, you don't need to respond to this):\n${parts.join('\n\n')}`
    : '';
}

/**
 * Shuffle actors array for use in prompts
 */
export function shuffleActors<T>(actors: T[]): T[] {
  return shuffleArray(actors);
}

// Import and for queries
import { and } from 'drizzle-orm';
