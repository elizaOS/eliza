/**
 * Database-backed state store for game tick execution.
 * Implements GameStateStore interface for production use.
 *
 * NOTE: Static data (actors, organizations) is loaded from in-memory cache
 * via StaticDataRegistry to avoid unnecessary database queries.
 */

import {
  and,
  db,
  eq,
  lte,
  markets,
  posts,
  questions,
  worldEvents,
} from "@feed/db";
import { generateSnowflakeId, logger } from "@feed/shared";
import type {
  ActiveMarket,
  ActiveQuestion,
  ArticleInput,
  EventInput,
  GameActor,
  GameOrganization,
  GameStateStore,
  Position,
  PostInput,
  QuestionInput,
  TradeInput,
  TradeResult,
} from "../GameTick";
import { persistArticle } from "../services/article-persistence";
import { StaticDataRegistry } from "../services/static-data-registry";
import {
  generateTagsFromPost,
  storeTagsForPost,
} from "../services/tag-service";
import { formatError } from "../utils/error-utils";

export class DbStateStore implements GameStateStore {
  async getActiveQuestions(): Promise<ActiveQuestion[]> {
    const rows = await db
      .select()
      .from(questions)
      .where(eq(questions.status, "active"));

    return rows.map((q) => ({
      id: q.id,
      questionNumber: q.questionNumber,
      text: q.text,
      status: q.status as "active" | "resolved",
      outcome: q.outcome ?? undefined,
      resolutionDate: q.resolutionDate ?? undefined,
      scenarioId: q.scenarioId ?? undefined,
    }));
  }

  async getQuestionsToResolve(beforeTime: Date): Promise<ActiveQuestion[]> {
    const rows = await db
      .select()
      .from(questions)
      .where(
        and(
          eq(questions.status, "active"),
          lte(questions.resolutionDate, beforeTime),
        ),
      );

    return rows.map((q) => ({
      id: q.id,
      questionNumber: q.questionNumber,
      text: q.text,
      status: q.status as "active" | "resolved",
      outcome: q.outcome ?? undefined,
      resolutionDate: q.resolutionDate ?? undefined,
      scenarioId: q.scenarioId ?? undefined,
    }));
  }

  async createQuestion(question: QuestionInput): Promise<string> {
    const id = await generateSnowflakeId();
    const questionNumber = Date.now() % 100000;

    await db.insert(questions).values({
      id,
      questionNumber,
      text: question.text,
      status: "active",
      outcome: false, // Default outcome until resolved
      rank: 1, // Default rank
      resolutionDate: question.resolutionDate,
      scenarioId: question.scenarioId ?? 1, // Default to scenario 1 if not provided
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return id;
  }

  async resolveQuestion(questionId: string, outcome: boolean): Promise<void> {
    await db
      .update(questions)
      .set({
        status: "resolved",
        outcome,
        updatedAt: new Date(),
      })
      .where(eq(questions.id, questionId));
  }

  async getActiveMarkets(): Promise<ActiveMarket[]> {
    const rows = await db
      .select()
      .from(markets)
      .where(eq(markets.resolved, false));

    return rows.map((m) => ({
      id: m.id,
      questionNumber: 0, // Markets don't have questionNumber directly
      yesShares: Number(m.yesShares),
      noShares: Number(m.noShares),
      yesPrice:
        Number(m.yesShares) / (Number(m.yesShares) + Number(m.noShares) || 1),
      noPrice:
        Number(m.noShares) / (Number(m.yesShares) + Number(m.noShares) || 1),
      resolved: m.resolved,
    }));
  }

  async updateMarketPrice(
    _marketId: string,
    _yesPrice: number,
    _noPrice: number,
  ): Promise<void> {
    // Prices are derived from shares - no direct update needed
  }

  async createPost(post: PostInput): Promise<string> {
    const id = await generateSnowflakeId();

    await db.insert(posts).values({
      id,
      authorId: post.authorId,
      content: post.content,
      type: post.type,
      timestamp: post.timestamp,
      gameId: "continuous",
    });

    // Fire-and-forget: generate and store tags so NPC posts surface in
    // tag-filtered feeds. Non-blocking — tag failure never breaks post creation.
    void generateTagsFromPost(post.content)
      .then(async (generatedTags) => {
        if (generatedTags.length > 0) {
          await storeTagsForPost(id, generatedTags);
        }
      })
      .catch((tagError) => {
        logger.warn(
          "Failed to generate/store NPC post tags (non-blocking)",
          { postId: id, error: formatError(tagError) },
          "DbStateStore",
        );
      });

    return id;
  }

  async createEvent(event: EventInput): Promise<string> {
    const id = await generateSnowflakeId();

    await db.insert(worldEvents).values({
      id,
      eventType: event.type,
      description: event.description,
      dayNumber: event.day,
      actors: event.actors,
      visibility: event.visibility,
      pointsToward: event.pointsToward,
      relatedQuestion: event.relatedQuestion,
      timestamp: new Date(),
    });

    return id;
  }

  async createArticle(article: ArticleInput): Promise<string> {
    // Delegate to shared persistence service (bypasses rate limit for simulation use)
    const result = await persistArticle(
      {
        title: article.title,
        summary: article.summary,
        content: article.content,
        authorOrgId: article.authorOrgId,
        gameId: "continuous",
        category: article.category,
        timestamp: article.timestamp,
      },
      { checkRateLimit: false, generateImage: false },
    );

    if (!result.success) {
      if (result.rateLimited) {
        throw new Error(
          `Rate limited: Article creation blocked by rate limiter${result.error ? ` - ${result.error}` : ""}`,
        );
      }
      throw new Error(result.error || "Failed to persist article");
    }

    // With discriminated union, articleId is guaranteed to exist when success is true
    return result.articleId;
  }

  /**
   * Get actors from in-memory static data registry (NO DATABASE CALL)
   */
  async getActors(limit = 50): Promise<GameActor[]> {
    const staticActors = StaticDataRegistry.getAllActors().slice(0, limit);

    return staticActors.map((a) => ({
      id: a.id,
      name: a.name,
      tier: a.tier ?? undefined,
      personality: a.personality ?? undefined,
      domain: a.domain.length > 0 ? a.domain : undefined,
    }));
  }

  /**
   * Get organizations from in-memory static data registry (NO DATABASE CALL)
   */
  async getOrganizations(): Promise<GameOrganization[]> {
    const staticOrgs = StaticDataRegistry.getAllOrganizations();

    return staticOrgs.map((o) => ({
      id: o.id,
      name: o.name,
      type: o.type as "company" | "media" | "government",
    }));
  }

  async executeTrade(_trade: TradeInput): Promise<TradeResult> {
    // Trade execution requires full TradeExecutionService
    return {
      success: false,
      error: "Use TradeExecutionService for trade execution",
    };
  }

  async getPositions(_actorId: string): Promise<Position[]> {
    // Positions are managed through pools - use NPCInvestmentManager for full access
    return [];
  }
}
