/**
 * Database Service
 *
 * @description Wrapper for all database operations. Provides a clean interface
 * for interacting with the database, handling posts, questions, organizations,
 * stock prices, events, and actors. Includes game state management.
 *
 * @usage
 * ```typescript
 * import { getDbInstance } from '@babylon/db'
 * await getDbInstance().createPost({...})
 * const posts = await getDbInstance().getRecentPosts(100)
 * ```
 */

import { generateSnowflakeId } from "@babylon/shared";
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
} from "drizzle-orm";
import { db } from "./db";
import { logger } from "./logger";
import type { OrganizationStateRow, Question } from "./model-types";
import {
  games,
  organizations,
  posts,
  questions,
  stockPrices,
  users,
  worldEvents,
} from "./schema";

/**
 * FeedPost type representing a post in the feed.
 */
export interface FeedPost {
  id: string;
  content: string;
  author: string;
  timestamp: string;
  type?: string;
}

/**
 * Database Service Class
 *
 * @description Main service class for database operations. Provides methods
 * for game state, posts, questions, organizations, stock prices, events, and actors.
 * Singleton pattern ensures single instance across the application.
 */
class DatabaseService {
  /**
   * Direct access to the database client for custom queries.
   */
  get db() {
    return db;
  }

  /**
   * Initialize game state in the database.
   * Creates a new continuous game if one doesn't exist.
   *
   * @returns The game instance (existing or newly created)
   */
  async initializeGame() {
    const existing = await db
      .select()
      .from(games)
      .where(eq(games.isContinuous, true))
      .limit(1);

    if (existing.length > 0 && existing[0]) {
      logger.info(`Game already initialized (${existing[0].id})`);
      return existing[0];
    }

    const gameId = await generateSnowflakeId();
    const created = await db
      .insert(games)
      .values({
        id: gameId,
        isContinuous: true,
        isRunning: true,
        currentDate: new Date(),
        speed: 60000,
        updatedAt: new Date(),
      })
      .returning();

    const game = created[0]!;
    logger.info(`Game initialized (${game.id})`);
    return game;
  }

  /**
   * Get the current continuous game state.
   *
   * @returns The current game state or null if no game exists
   */
  async getGameState() {
    const result = await db
      .select()
      .from(games)
      .where(eq(games.isContinuous, true))
      .limit(1);
    return result[0] ?? null;
  }

  /**
   * Update game state with new values.
   *
   * @param data - Partial game state data to update
   * @returns The updated game state
   * @throws Error if game is not initialized
   */
  async updateGameState(data: {
    currentDay?: number;
    currentDate?: Date;
    lastTickAt?: Date;
    lastSnapshotAt?: Date;
    activeQuestions?: number;
  }) {
    const game = await this.getGameState();
    if (!game) throw new Error("Game not initialized");

    const updated = await db
      .update(games)
      .set(data)
      .where(eq(games.id, game.id))
      .returning();

    return updated[0]!;
  }

  // ========== POSTS ==========

  /**
   * Create a new post in the database.
   *
   * @param post - Post data including id, content, author, timestamp, and optional game fields
   * @returns The created post record
   */
  async createPost(post: FeedPost & { gameId?: string; dayNumber?: number }) {
    const created = await db
      .insert(posts)
      .values({
        id: post.id,
        content: post.content,
        authorId: post.author,
        gameId: post.gameId,
        dayNumber: post.dayNumber,
        timestamp: new Date(post.timestamp),
      })
      .returning();

    return created[0]!;
  }

  /**
   * Create a post with all fields including article-specific fields.
   *
   * @param data - Complete post data including article fields
   * @returns The created post record
   */
  async createPostWithAllFields(data: {
    id: string;
    type?: string;
    content: string;
    fullContent?: string;
    articleTitle?: string;
    byline?: string;
    biasScore?: number;
    sentiment?: string;
    slant?: string;
    category?: string;
    imageUrl?: string;
    authorId: string;
    gameId?: string;
    dayNumber?: number;
    timestamp: Date;
    commentOnPostId?: string;
    parentCommentId?: string;
    originalPostId?: string;
    relatedQuestion?: number;
  }) {
    const safeDayNumber =
      typeof data.dayNumber === "number" &&
      Number.isFinite(data.dayNumber) &&
      data.dayNumber >= 0 &&
      data.dayNumber <= 2147483647
        ? data.dayNumber
        : undefined;

    if (data.dayNumber !== undefined && safeDayNumber === undefined) {
      logger.warn("[Post] Invalid dayNumber value", {
        dayNumber: data.dayNumber,
        postId: data.id,
      });
    }

    const safeRelatedQuestion =
      typeof data.relatedQuestion === "number" &&
      Number.isFinite(data.relatedQuestion) &&
      data.relatedQuestion >= 0 &&
      data.relatedQuestion <= 2147483647
        ? Math.floor(data.relatedQuestion)
        : undefined;

    if (
      data.relatedQuestion !== undefined &&
      safeRelatedQuestion === undefined
    ) {
      logger.warn("[Post] Invalid relatedQuestion value", {
        relatedQuestion: data.relatedQuestion,
        postId: data.id,
      });
    }

    const created = await db
      .insert(posts)
      .values({
        id: data.id,
        type: data.type || "post",
        content: data.content,
        fullContent: data.fullContent,
        articleTitle: data.articleTitle,
        byline: data.byline,
        biasScore: data.biasScore,
        sentiment: data.sentiment,
        slant: data.slant,
        category: data.category,
        imageUrl: data.imageUrl,
        authorId: data.authorId,
        gameId: data.gameId,
        dayNumber: safeDayNumber,
        timestamp: data.timestamp,
        commentOnPostId: data.commentOnPostId,
        parentCommentId: data.parentCommentId,
        originalPostId: data.originalPostId,
        relatedQuestion: safeRelatedQuestion,
      })
      .returning();

    return created[0]!;
  }

  /**
   * Create multiple posts in a single batch operation.
   *
   * @param postsData - Array of post data objects
   * @returns Object with count of created posts
   */
  async createManyPosts(
    postsData: Array<FeedPost & { gameId?: string; dayNumber?: number }>,
  ) {
    if (postsData.length === 0) return { count: 0 };

    const values = postsData.map((post) => {
      const safeDayNumber =
        typeof post.dayNumber === "number" &&
        Number.isFinite(post.dayNumber) &&
        post.dayNumber >= 0 &&
        post.dayNumber <= 2147483647
          ? post.dayNumber
          : undefined;

      if (post.dayNumber !== undefined && safeDayNumber === undefined) {
        logger.warn("[Post] Invalid dayNumber value", {
          dayNumber: post.dayNumber,
          postId: post.id,
        });
      }

      return {
        id: post.id,
        content: post.content,
        authorId: post.author,
        gameId: post.gameId,
        dayNumber: safeDayNumber,
        timestamp: new Date(post.timestamp),
      };
    });

    await db.insert(posts).values(values).onConflictDoNothing();

    return { count: postsData.length };
  }

  /**
   * Get recent posts with cursor-based or offset-based pagination.
   * Automatically filters out posts from test users.
   *
   * @param limit - Maximum number of posts to return (default: 100)
   * @param cursorOrOffset - Cursor string for cursor-based pagination or number for offset-based
   * @returns Array of recent posts
   */
  async getRecentPosts(limit = 100, cursorOrOffset?: string | number) {
    const isCursor = typeof cursorOrOffset === "string";
    const cursor = isCursor ? cursorOrOffset : undefined;
    const offset =
      !isCursor && typeof cursorOrOffset === "number" ? cursorOrOffset : 0;

    logger.debug("DatabaseService.getRecentPosts called", {
      limit,
      cursor,
      offset,
    });

    const now = new Date();

    const conditions = [isNull(posts.deletedAt)];

    if (cursor) {
      conditions.push(lt(posts.timestamp, new Date(cursor)));
      conditions.push(lte(posts.timestamp, now));
    } else {
      conditions.push(lte(posts.timestamp, now));
    }

    const allPosts = await db
      .select()
      .from(posts)
      .where(and(...conditions))
      .limit(limit * 2)
      .offset(cursor ? 0 : offset)
      .orderBy(desc(posts.timestamp));

    const authorIds = [...new Set(allPosts.map((p) => p.authorId))];

    // Check users table for isTest flag
    const testUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.id, authorIds), eq(users.isTest, true)));

    // For actors, use ID pattern: test actors have IDs starting with 'test-'
    const testActorIds = authorIds.filter((id) => id.startsWith("test-"));

    const testAuthorIds = new Set([
      ...testUsers.map((u) => u.id),
      ...testActorIds,
    ]);

    const filteredPosts = allPosts
      .filter((post) => !testAuthorIds.has(post.authorId))
      .slice(0, limit);

    logger.info("DatabaseService.getRecentPosts completed", {
      limit,
      cursor,
      offset,
      postCount: filteredPosts.length,
      filteredTestPosts: allPosts.length - filteredPosts.length,
      firstPostId: filteredPosts[0]?.id,
      lastPostId: filteredPosts[filteredPosts.length - 1]?.id,
    });

    return filteredPosts;
  }

  /**
   * Get posts by a specific actor with cursor-based or offset-based pagination.
   * Returns empty array if the actor is a test user.
   *
   * @param authorId - ID of the actor/user whose posts to retrieve
   * @param limit - Maximum number of posts to return (default: 100)
   * @param cursorOrOffset - Cursor string or offset number for pagination
   * @returns Array of posts by the actor
   */
  async getPostsByActor(
    authorId: string,
    limit = 100,
    cursorOrOffset?: string | number,
  ) {
    const isCursor = typeof cursorOrOffset === "string";
    const cursor = isCursor ? cursorOrOffset : undefined;
    const offset =
      !isCursor && typeof cursorOrOffset === "number" ? cursorOrOffset : 0;

    logger.debug("DatabaseService.getPostsByActor called", {
      authorId,
      limit,
      cursor,
      offset,
    });

    // Check if it's a test user from users table or test actor by ID pattern
    const user = await db
      .select({ isTest: users.isTest })
      .from(users)
      .where(eq(users.id, authorId))
      .limit(1);

    // Test actors have IDs starting with 'test-'
    const isTestUser = user[0]?.isTest || authorId.startsWith("test-") || false;

    if (isTestUser) {
      logger.info("DatabaseService.getPostsByActor - test user filtered", {
        authorId,
        isTestUser: true,
      });
      return [];
    }

    const now = new Date();

    const conditions = [eq(posts.authorId, authorId), isNull(posts.deletedAt)];

    if (cursor) {
      conditions.push(lt(posts.timestamp, new Date(cursor)));
      conditions.push(lte(posts.timestamp, now));
    } else {
      conditions.push(lte(posts.timestamp, now));
    }

    const result = await db
      .select()
      .from(posts)
      .where(and(...conditions))
      .limit(limit)
      .offset(cursor ? 0 : offset)
      .orderBy(desc(posts.timestamp));

    logger.info("DatabaseService.getPostsByActor completed", {
      authorId,
      limit,
      cursor,
      offset,
      postCount: result.length,
    });

    return result;
  }

  /**
   * Get the total count of all posts in the database.
   *
   * @returns Total number of posts
   */
  async getTotalPosts() {
    const result = await db.select({ count: count() }).from(posts);
    return Number(result[0]?.count ?? 0);
  }

  // ========== QUESTIONS ==========

  /**
   * Create a new question in the database.
   *
   * @param question - Question data including text, resolution date, and optional fields
   * @returns The created question record
   */
  async createQuestion(question: {
    text: string;
    scenario?: number;
    outcome?: boolean;
    rank?: number;
    createdDate?: string | Date;
    resolutionDate: string | Date;
    status?: string;
    resolvedOutcome?: boolean;
    questionNumber: number;
  }) {
    const created = await db
      .insert(questions)
      .values({
        id: await generateSnowflakeId(),
        questionNumber: question.questionNumber,
        text: question.text,
        scenarioId: question.scenario ?? 0,
        outcome: question.outcome ?? false,
        rank: question.rank ?? 0,
        createdDate: new Date(question.createdDate || new Date()),
        resolutionDate: new Date(question.resolutionDate),
        status: question.status || "active",
        resolvedOutcome: question.resolvedOutcome,
        updatedAt: new Date(),
      })
      .returning();

    return created[0]!;
  }

  /**
   * Adapt database question to include computed fields like timeframe.
   */
  private adaptQuestion(dbQuestion: Question): Question & {
    scenario: number;
    timeframe: string;
  } {
    return {
      ...dbQuestion,
      scenario: dbQuestion.scenarioId,
      timeframe: this.calculateTimeframe(dbQuestion.resolutionDate),
    };
  }

  /**
   * Calculate timeframe category (24h, 7d, 30d, 30d+) from resolution date.
   */
  private calculateTimeframe(resolutionDate: Date): string {
    const now = new Date();
    const msUntilResolution = resolutionDate.getTime() - now.getTime();
    const daysUntilResolution = Math.ceil(
      msUntilResolution / (1000 * 60 * 60 * 24),
    );

    if (daysUntilResolution <= 1) return "24h";
    if (daysUntilResolution <= 7) return "7d";
    if (daysUntilResolution <= 30) return "30d";
    return "30d+";
  }

  /**
   * Get active questions, optionally filtered by timeframe.
   *
   * @param timeframe - Optional timeframe filter: '24h', '7d', '30d', or '30d+'
   * @returns Array of active questions with computed fields
   */
  async getActiveQuestions(timeframe?: string) {
    const now = new Date();
    const conditions = [eq(questions.status, "active")];

    if (timeframe) {
      let endDate: Date | undefined;

      switch (timeframe) {
        case "24h":
          endDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
          conditions.push(gte(questions.resolutionDate, now));
          conditions.push(lte(questions.resolutionDate, endDate));
          break;
        case "7d":
          endDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
          conditions.push(gte(questions.resolutionDate, now));
          conditions.push(lte(questions.resolutionDate, endDate));
          break;
        case "30d":
          endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
          conditions.push(gte(questions.resolutionDate, now));
          conditions.push(lte(questions.resolutionDate, endDate));
          break;
        case "30d+": {
          const startDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
          conditions.push(gte(questions.resolutionDate, startDate));
          break;
        }
      }
    }

    const result = await db
      .select()
      .from(questions)
      .where(and(...conditions))
      .orderBy(desc(questions.createdDate));

    return result.map((q) => this.adaptQuestion(q));
  }

  /**
   * Get active questions that are ready to be resolved (resolutionDate <= now).
   *
   * @returns Array of questions ready for resolution
   */
  async getQuestionsToResolve() {
    const result = await db
      .select()
      .from(questions)
      .where(
        and(
          eq(questions.status, "active"),
          lte(questions.resolutionDate, new Date()),
        ),
      );

    return result.map((q) => this.adaptQuestion(q));
  }

  /**
   * Get all questions including both active and resolved.
   *
   * @returns Array of all questions
   */
  async getAllQuestions() {
    const result = await db
      .select()
      .from(questions)
      .orderBy(desc(questions.createdDate));

    return result.map((q) => this.adaptQuestion(q));
  }

  /**
   * Resolve a question with the specified outcome.
   *
   * @param id - Question ID to resolve
   * @param resolvedOutcome - The outcome (true/false) for the question
   * @returns The updated question record
   */
  async resolveQuestion(id: string, resolvedOutcome: boolean) {
    const updated = await db
      .update(questions)
      .set({
        status: "resolved",
        resolvedOutcome,
      })
      .where(eq(questions.id, id))
      .returning();

    return updated[0]!;
  }

  // ========== ORGANIZATIONS ==========

  /**
   * Update an organization's current price.
   *
   * @param id - Organization ID
   * @param currentPrice - Current price value
   * @returns The updated organization record
   */
  async upsertOrganizationState(
    id: string,
    currentPrice: number | null,
  ): Promise<OrganizationStateRow> {
    const existing = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, id))
      .limit(1);

    if (existing.length > 0) {
      const updated = await db
        .update(organizations)
        .set({
          currentPrice,
          updatedAt: new Date(),
        })
        .where(eq(organizations.id, id))
        .returning();
      return updated[0]!;
    }

    // Organization doesn't exist - this shouldn't happen normally
    // Organizations should be created with full data
    logger.warn(`Organization ${id} not found for price update`);
    throw new Error(`Organization ${id} not found`);
  }

  /**
   * Update an organization's current price.
   *
   * @param id - Organization ID
   * @param price - New price value
   * @returns The updated organization record
   */
  async updateOrganizationPrice(
    id: string,
    price: number,
  ): Promise<OrganizationStateRow> {
    return this.upsertOrganizationState(id, price);
  }

  /**
   * Get organization by ID.
   *
   * @param id - Organization ID
   * @returns The organization or null if not found
   */
  async getOrganizationState(id: string): Promise<OrganizationStateRow | null> {
    const result = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, id))
      .limit(1);
    return result[0] ?? null;
  }

  /**
   * Get all organizations.
   *
   * @returns Array of all organization records
   */
  async getAllOrganizationStates(): Promise<OrganizationStateRow[]> {
    return db.select().from(organizations);
  }

  /**
   * Get all organizations with current prices ordered by price.
   *
   * @returns Array of organizations ordered by price descending
   */
  async getOrganizationsByPrice(): Promise<OrganizationStateRow[]> {
    return db
      .select()
      .from(organizations)
      .orderBy(desc(organizations.currentPrice));
  }

  // ========== STOCK PRICES ==========

  /**
   * Record a stock price update for an organization.
   *
   * @param organizationId - Organization ID
   * @param price - Current price
   * @param change - Price change amount
   * @param changePercent - Price change percentage
   * @returns The created price record
   */
  async recordPriceUpdate(
    organizationId: string,
    price: number,
    change: number,
    changePercent: number,
  ) {
    const created = await db
      .insert(stockPrices)
      .values({
        id: await generateSnowflakeId(),
        organizationId,
        price,
        change,
        changePercent,
        timestamp: new Date(),
        isSnapshot: false,
      })
      .returning();

    return created[0]!;
  }

  /**
   * Record a daily end-of-day (EOD) price snapshot with OHLCV data.
   *
   * @param organizationId - Organization ID
   * @param data - OHLCV data (open, high, low, close, volume)
   * @returns The created snapshot record
   */
  async recordDailySnapshot(
    organizationId: string,
    data: {
      openPrice: number;
      highPrice: number;
      lowPrice: number;
      closePrice: number;
      volume: number;
    },
  ) {
    const created = await db
      .insert(stockPrices)
      .values({
        id: await generateSnowflakeId(),
        organizationId,
        price: data.closePrice,
        change: data.closePrice - data.openPrice,
        changePercent:
          ((data.closePrice - data.openPrice) / data.openPrice) * 100,
        timestamp: new Date(),
        isSnapshot: true,
        openPrice: data.openPrice,
        highPrice: data.highPrice,
        lowPrice: data.lowPrice,
        volume: data.volume,
      })
      .returning();

    return created[0]!;
  }

  /**
   * Get price history for an organization.
   *
   * @param organizationId - Organization ID
   * @param limit - Maximum number of records to return (default: 1440)
   * @returns Array of price records ordered by timestamp (newest first)
   */
  async getPriceHistory(organizationId: string, limit = 1440) {
    return await db
      .select()
      .from(stockPrices)
      .where(eq(stockPrices.organizationId, organizationId))
      .limit(limit)
      .orderBy(desc(stockPrices.timestamp));
  }

  /**
   * Get daily end-of-day price snapshots for an organization.
   *
   * @param organizationId - Organization ID
   * @param days - Number of days of snapshots to retrieve (default: 30)
   * @returns Array of daily snapshot records
   */
  async getDailySnapshots(organizationId: string, days = 30) {
    return await db
      .select()
      .from(stockPrices)
      .where(
        and(
          eq(stockPrices.organizationId, organizationId),
          eq(stockPrices.isSnapshot, true),
        ),
      )
      .limit(days)
      .orderBy(desc(stockPrices.timestamp));
  }

  // ========== EVENTS ==========

  /**
   * Create a world event in the database.
   *
   * @param event - Event data including type, description, actors, and visibility
   * @returns The created event record
   */
  async createEvent(event: {
    id: string;
    eventType: string;
    description:
      | string
      | { title?: string; text?: string; timestamp?: string; source?: string };
    actors: string[];
    relatedQuestion?: number;
    pointsToward?: string;
    visibility: string;
    gameId?: string;
    dayNumber?: number;
  }) {
    let descriptionString: string;
    if (typeof event.description === "string") {
      descriptionString = event.description;
    } else if (event.description && typeof event.description === "object") {
      descriptionString =
        event.description.text ||
        event.description.title ||
        JSON.stringify(event.description);
    } else {
      descriptionString = String(event.description || "");
    }

    const safeRelatedQuestion =
      typeof event.relatedQuestion === "number" &&
      Number.isFinite(event.relatedQuestion) &&
      event.relatedQuestion >= 0 &&
      event.relatedQuestion <= 2147483647
        ? event.relatedQuestion
        : undefined;

    const safeDayNumber =
      typeof event.dayNumber === "number" &&
      Number.isFinite(event.dayNumber) &&
      event.dayNumber >= 0 &&
      event.dayNumber <= 2147483647
        ? event.dayNumber
        : undefined;

    if (
      event.relatedQuestion !== undefined &&
      safeRelatedQuestion === undefined
    ) {
      logger.warn("[WorldEvent] Invalid relatedQuestion value", {
        relatedQuestion: event.relatedQuestion,
        eventId: event.id,
      });
    }

    if (event.dayNumber !== undefined && safeDayNumber === undefined) {
      logger.warn("[WorldEvent] Invalid dayNumber value", {
        dayNumber: event.dayNumber,
        eventId: event.id,
      });
    }

    const created = await db
      .insert(worldEvents)
      .values({
        id: event.id,
        eventType: event.eventType,
        description: descriptionString,
        actors: event.actors,
        relatedQuestion: safeRelatedQuestion,
        pointsToward: event.pointsToward,
        visibility: event.visibility,
        gameId: event.gameId,
        dayNumber: safeDayNumber,
      })
      .returning();

    return created[0]!;
  }

  /**
   * Get recent world events ordered by timestamp.
   *
   * @param limit - Maximum number of events to return (default: 100)
   * @returns Array of recent events
   */
  async getRecentEvents(limit = 100) {
    return await db
      .select()
      .from(worldEvents)
      .limit(limit)
      .orderBy(desc(worldEvents.timestamp));
  }

  // ========== ACTOR STATE ==========
  // Actor state is deprecated in Polyagent

  /**
   * @deprecated Actor state is no longer used in Polyagent
   */
  async upsertActorState(_state: {
    id: string;
    [key: string]: unknown;
  }): Promise<null> {
    logger.warn("upsertActorState is deprecated and has no effect");
    return null;
  }

  /**
   * @deprecated Actor state is no longer used in Polyagent
   */
  async getAllActorStates(): Promise<never[]> {
    return [];
  }

  /**
   * @deprecated Actor state is no longer used in Polyagent
   */
  async getActorState(_id: string): Promise<null> {
    return null;
  }

  // ========== UTILITY ==========

  /**
   * Get database statistics including counts and game state.
   *
   * @returns Object containing various database statistics
   */
  async getStats() {
    const [totalPosts, totalQuestions, activeQuestions, gameState] =
      await Promise.all([
        db
          .select({ count: count() })
          .from(posts)
          .then((r) => Number(r[0]?.count ?? 0)),
        db
          .select({ count: count() })
          .from(questions)
          .then((r) => Number(r[0]?.count ?? 0)),
        db
          .select({ count: count() })
          .from(questions)
          .where(eq(questions.status, "active"))
          .then((r) => Number(r[0]?.count ?? 0)),
        this.getGameState(),
      ]);

    return {
      totalPosts,
      totalQuestions,
      activeQuestions,
      totalOrganizations: 0, // Deprecated
      totalActors: 0, // Deprecated
      currentDay: gameState?.currentDay ?? 1,
      isRunning: gameState?.isRunning || false,
    };
  }

  /**
   * Get all games ordered by creation date (newest first).
   *
   * @returns Array of all game records
   */
  async getAllGames() {
    return await db.select().from(games).orderBy(desc(games.createdAt));
  }
}

// Singleton instance - ensure it's always available
let dbInstance: DatabaseService | null = null;

export function getDbInstance(): DatabaseService {
  if (!dbInstance) {
    dbInstance = new DatabaseService();
  }
  return dbInstance;
}

export { DatabaseService };
export default getDbInstance;
