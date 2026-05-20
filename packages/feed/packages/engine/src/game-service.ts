/**
 * Game Service - API Wrapper
 *
 * @description Provides access to game data for API routes. Wraps database
 * operations with a clean service interface. Game tick runs automatically via
 * cron (production) or local simulator (development). All operations query the
 * database directly, which is updated by game tick.
 *
 * Vercel-compatible: No filesystem access, all data from database.
 */

import {
  db,
  desc,
  eq,
  games,
  getDbInstance,
  markets,
  questions,
} from '@feed/db';
import { logger } from '@feed/shared';
import { StaticDataRegistry } from './services/static-data-registry';
import { getGameDayNumber } from './utils/date-utils';

/**
 * Active market summary for NPC context (lightweight)
 */
export interface ActiveMarketSummary {
  id: string;
  question: string;
}

/**
 * Game Service Class
 *
 * @description Service class for accessing game data. Provides methods for
 * retrieving posts, companies, questions, and game statistics. Singleton
 * pattern ensures single instance across the application.
 */
class GameService {
  async getRecentPosts(limit = 100, offset = 0) {
    return await getDbInstance().getRecentPosts(limit, offset);
  }

  async getPostsByActor(actorId: string, limit = 100) {
    return await getDbInstance().getPostsByActor(actorId, limit);
  }

  async getCompanies() {
    // Get static organization data from registry
    const staticOrgs = StaticDataRegistry.getAllOrganizations();
    // Get dynamic price data from database
    const orgStates = await getDbInstance().getAllOrganizationStates();
    const priceMap = new Map(orgStates.map((s) => [s.id, s.currentPrice]));

    // Combine static and dynamic data, filter to companies
    return staticOrgs
      .filter((org) => org.type === 'company')
      .map((org) => ({
        id: org.id,
        name: org.name,
        description: org.description,
        type: org.type,
        canBeInvolved: org.canBeInvolved,
        initialPrice: org.initialPrice,
        currentPrice: priceMap.get(org.id) ?? org.initialPrice,
      }))
      .sort((a, b) => (b.currentPrice ?? 0) - (a.currentPrice ?? 0));
  }

  async getActiveQuestions() {
    return await getDbInstance().getActiveQuestions();
  }

  /**
   * Get game statistics from database.
   * Works even if engine is not running (daemon writes to database).
   */
  async getStats() {
    return await getDbInstance().getStats();
  }

  /**
   * Get all games from database
   */
  async getAllGames() {
    return await getDbInstance().getAllGames();
  }

  /**
   * Get game status.
   * Returns status indicating if game is running and tick is active.
   */
  async getStatus() {
    // Check game state from database
    const gameState = await getDbInstance().getGameState();
    return {
      isRunning: false,
      initialized: false,
      currentDay: gameState?.currentDay ?? 1,
      currentDate: gameState?.currentDate?.toISOString(),
      speed: 60000,
      lastTickAt: gameState?.lastTickAt?.toISOString(),
    };
  }

  async getRealtimePosts(limit = 100, offset = 0, actorId?: string) {
    // On Vercel: Read from database instead of filesystem
    // The daemon writes posts to database, so we can query them directly
    const posts = actorId
      ? await getDbInstance().getPostsByActor(actorId, limit)
      : await getDbInstance().getRecentPosts(limit, offset);

    if (!posts || posts.length === 0) {
      return null;
    }

    return {
      posts: posts.map((post) => ({
        id: post.id,
        content: post.content,
        authorId: post.authorId,
        author: post.authorId, // Post model doesn't have author field, use authorId
        timestamp: post.createdAt.toISOString(),
        createdAt: post.createdAt.toISOString(),
        gameId: post.gameId,
        dayNumber: post.dayNumber,
      })),
      total: posts.length,
    };
  }

  /**
   * Get the current game day from the active continuous game.
   * Returns 1 if no game is running (Day 1 is the default).
   * Uses startedAt as single source of truth for day calculation.
   */
  async getCurrentGameDay(): Promise<number> {
    const [game] = await db
      .select({
        currentDay: games.currentDay,
        startedAt: games.startedAt,
      })
      .from(games)
      .where(eq(games.isContinuous, true))
      .orderBy(desc(games.startedAt))
      .limit(1);

    if (!game) {
      logger.warn('No continuous game found', {}, 'GameService');
      return 1;
    }

    if (!game.startedAt) {
      logger.warn(
        'Game startedAt is null - using stored currentDay',
        { currentDay: game.currentDay },
        'GameService'
      );
      return game.currentDay ?? 1;
    }

    // Calculate fresh from epoch (single source of truth)
    return getGameDayNumber(game.startedAt, new Date());
  }

  /**
   * Get active (unresolved) prediction markets with minimal fields.
   * Used by NPC context providers to avoid direct DB access.
   */
  async getActiveMarketSummaries(limit = 5): Promise<ActiveMarketSummary[]> {
    const activeMarkets = await db
      .select({
        id: markets.id,
        question: markets.question,
      })
      .from(markets)
      .where(eq(markets.resolved, false))
      .limit(limit);

    return activeMarkets;
  }
  /**
   * Get the predetermined outcome for a question/market.
   * Returns the boolean outcome, or null if not found.
   * Used by NPC game context to provide correct insider signals.
   */
  async getQuestionOutcome(marketId: string): Promise<boolean | null> {
    try {
      // Markets and questions are linked — market.id maps to question.id
      const [question] = await db
        .select({ outcome: questions.outcome })
        .from(questions)
        .where(eq(questions.id, marketId))
        .limit(1);

      return question?.outcome ?? null;
    } catch {
      return null;
    }
  }
}

export const gameService = new GameService();
