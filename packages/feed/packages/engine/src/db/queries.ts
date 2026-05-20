/**
 * Centralized Database Query Helpers
 *
 * DRY principle: Common queries should be written once.
 * This module provides type-safe, reusable query functions for
 * frequently accessed database tables.
 *
 * @module engine/db/queries
 */

import {
  actorState,
  and,
  arcStates,
  db,
  desc,
  eq,
  games,
  gte,
  inArray,
  markets as marketsSchema,
  posts,
  questions as questionsSchema,
  worldEvents,
} from '@feed/db';

// =============================================================================
// Question Queries
// =============================================================================

/**
 * Get all questions with 'active' status.
 * Most commonly used query in the engine.
 */
export async function getActiveQuestions() {
  return db
    .select()
    .from(questionsSchema)
    .where(eq(questionsSchema.status, 'active'));
}

/**
 * Get active questions with a limit.
 */
export async function getActiveQuestionsWithLimit(limit: number) {
  return db
    .select()
    .from(questionsSchema)
    .where(eq(questionsSchema.status, 'active'))
    .limit(limit);
}

/**
 * Get question by question number.
 */
export async function getQuestionByNumber(questionNumber: number) {
  const [question] = await db
    .select()
    .from(questionsSchema)
    .where(eq(questionsSchema.questionNumber, questionNumber))
    .limit(1);
  return question;
}

/**
 * Get question by ID.
 */
export async function getQuestionById(id: string) {
  const [question] = await db
    .select()
    .from(questionsSchema)
    .where(eq(questionsSchema.id, id))
    .limit(1);
  return question;
}

// =============================================================================
// Market Queries
// =============================================================================

/**
 * Get all active (unresolved, not expired) markets.
 */
export async function getActiveMarkets(timestamp: Date = new Date()) {
  return db
    .select()
    .from(marketsSchema)
    .where(
      and(
        eq(marketsSchema.resolved, false),
        gte(marketsSchema.endDate, timestamp)
      )
    );
}

/**
 * Get market by ID.
 */
export async function getMarketById(id: string) {
  const [market] = await db
    .select()
    .from(marketsSchema)
    .where(eq(marketsSchema.id, id))
    .limit(1);
  return market;
}

/**
 * Get market by question text.
 */
export async function getMarketByQuestion(questionText: string) {
  const [market] = await db
    .select()
    .from(marketsSchema)
    .where(eq(marketsSchema.question, questionText))
    .limit(1);
  return market;
}

// =============================================================================
// Game Queries
// =============================================================================

/**
 * Get the continuous game instance.
 * There should only be one continuous game.
 */
export async function getContinuousGame() {
  const [game] = await db
    .select()
    .from(games)
    .where(eq(games.isContinuous, true))
    .limit(1);
  return game;
}

/**
 * Get game by ID.
 */
export async function getGameById(id: string) {
  const [game] = await db.select().from(games).where(eq(games.id, id)).limit(1);
  return game;
}

// =============================================================================
// World Event Queries
// =============================================================================

/**
 * Get recent world events within a time window.
 */
export async function getRecentWorldEvents(since: Date, limit?: number) {
  const query = db
    .select()
    .from(worldEvents)
    .where(gte(worldEvents.timestamp, since))
    .orderBy(desc(worldEvents.timestamp));

  if (limit) {
    return query.limit(limit);
  }

  return query;
}

/**
 * Get world events for a specific question.
 *
 * @param questionId - The question ID as a string (will be parsed to number)
 * @throws Error if questionId cannot be parsed to a valid number
 */
export async function getWorldEventsForQuestion(questionId: string) {
  const numericId = Number(questionId);
  if (Number.isNaN(numericId)) {
    throw new Error(
      `getWorldEventsForQuestion: Invalid questionId "${questionId}" - must be a numeric string for worldEvents.relatedQuestion`
    );
  }
  return db
    .select()
    .from(worldEvents)
    .where(eq(worldEvents.relatedQuestion, numericId))
    .orderBy(desc(worldEvents.timestamp));
}

// =============================================================================
// Arc State Queries
// =============================================================================

/**
 * Get arc state by question ID.
 */
export async function getArcStateByQuestionId(questionId: string) {
  const [arcState] = await db
    .select()
    .from(arcStates)
    .where(eq(arcStates.questionId, questionId))
    .limit(1);
  return arcState;
}

/**
 * Get arc states for multiple questions (batch query).
 */
export async function getArcStatesByQuestionIds(questionIds: string[]) {
  if (questionIds.length === 0) return [];
  return db
    .select()
    .from(arcStates)
    .where(inArray(arcStates.questionId, questionIds));
}

// =============================================================================
// Actor Queries
// =============================================================================

/**
 * Get actor by ID.
 *
 * Note: Input actor IDs are normalized to lowercase via toLowerCase() before querying.
 * The actorState.id column is stored and compared in lowercase, so callers can pass
 * IDs in any case and they will be matched correctly.
 */
export async function getActorById(actorId: string) {
  const [actor] = await db
    .select()
    .from(actorState)
    .where(eq(actorState.id, actorId.toLowerCase()))
    .limit(1);
  return actor;
}

/**
 * Get multiple actors by IDs (batch query).
 *
 * Note: Input actor IDs are normalized to lowercase via toLowerCase() before querying.
 * The actorState.id column is stored and compared in lowercase, so callers can pass
 * IDs in any case and they will be matched correctly via the inArray comparison.
 */
export async function getActorsByIds(actorIds: string[]) {
  if (actorIds.length === 0) return [];
  const normalizedIds = actorIds.map((id) => id.toLowerCase());
  return db
    .select()
    .from(actorState)
    .where(inArray(actorState.id, normalizedIds));
}

// =============================================================================
// Post Queries
// =============================================================================

/**
 * Get recent posts within a time window.
 */
export async function getRecentPosts(since: Date, limit?: number) {
  const query = db
    .select()
    .from(posts)
    .where(gte(posts.timestamp, since))
    .orderBy(desc(posts.timestamp));

  if (limit) {
    return query.limit(limit);
  }

  return query;
}

/**
 * Get posts by author ID.
 */
export async function getPostsByAuthor(authorId: string, limit?: number) {
  const query = db
    .select()
    .from(posts)
    .where(eq(posts.authorId, authorId))
    .orderBy(desc(posts.timestamp));

  if (limit) {
    return query.limit(limit);
  }

  return query;
}
