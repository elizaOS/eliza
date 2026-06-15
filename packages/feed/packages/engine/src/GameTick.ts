/**
 * Core game tick - the canonical unit of game progression.
 * Works with any state store (DB or in-memory) via injectable context.
 */

import { logger } from "@feed/shared";
import type { GameClock, GameTime } from "./GameClock";

/** Result of executing one game tick */
export interface TickResult {
  time: GameTime;
  postsCreated: number;
  eventsCreated: number;
  articlesCreated: number;
  tradesExecuted: number;
  marketsUpdated: number;
  questionsResolved: number;
  questionsCreated: number;
}

/** Configuration for a game tick */
export interface TickConfig {
  /** Skip content generation (posts, events, articles) */
  skipContent?: boolean;
  /** Skip NPC trading decisions */
  skipTrading?: boolean;
  /** Skip question resolution */
  skipResolution?: boolean;
  /** Maximum time budget for this tick (ms) */
  budgetMs?: number;
}

/** Abstract interface for game state storage */
export interface GameStateStore {
  // Questions
  getActiveQuestions(): Promise<ActiveQuestion[]>;
  getQuestionsToResolve(beforeTime: Date): Promise<ActiveQuestion[]>;
  createQuestion(question: QuestionInput): Promise<string>;
  resolveQuestion(questionId: string, outcome: boolean): Promise<void>;

  // Markets
  getActiveMarkets(): Promise<ActiveMarket[]>;
  updateMarketPrice(
    marketId: string,
    yesPrice: number,
    noPrice: number,
  ): Promise<void>;

  // Content
  createPost(post: PostInput): Promise<string>;
  createEvent(event: EventInput): Promise<string>;
  createArticle(article: ArticleInput): Promise<string>;

  // Actors
  getActors(limit?: number): Promise<GameActor[]>;
  getOrganizations(): Promise<GameOrganization[]>;

  // Trading
  executeTrade(trade: TradeInput): Promise<TradeResult>;
  getPositions(actorId: string): Promise<Position[]>;
}

export interface ActiveQuestion {
  id: string;
  questionNumber: number;
  text: string;
  status: "active" | "resolved";
  outcome?: boolean;
  resolutionDate?: Date;
  scenarioId?: number;
}

export interface ActiveMarket {
  id: string;
  questionNumber: number;
  yesShares: number;
  noShares: number;
  yesPrice: number;
  noPrice: number;
  resolved: boolean;
}

export interface QuestionInput {
  text: string;
  resolutionDate: Date;
  scenarioId?: number;
}

export interface PostInput {
  authorId: string;
  content: string;
  type: "post" | "article" | "reply";
  timestamp: Date;
}

export interface EventInput {
  type: string;
  description: string;
  day: number;
  hour: number;
  actors: string[];
  visibility: "public" | "leaked" | "private";
  pointsToward?: "YES" | "NO";
  relatedQuestion?: number;
}

export interface ArticleInput {
  title: string;
  content: string;
  summary: string;
  authorOrgId: string;
  timestamp: Date;
  category?: string;
}

export interface GameActor {
  id: string;
  name: string;
  tier?: string;
  personality?: string;
  domain?: string[];
}

export interface GameOrganization {
  id: string;
  name: string;
  type: "company" | "media" | "government";
}

export interface TradeInput {
  actorId: string;
  marketId: string;
  side: "YES" | "NO";
  amount: number;
}

export interface TradeResult {
  success: boolean;
  shares?: number;
  price?: number;
  totalCost?: number;
  error?: string;
}

export interface Position {
  marketId: string;
  side: "YES" | "NO";
  shares: number;
  avgPrice: number;
}

/** Services needed to execute a tick */
export interface TickServices {
  /** LLM client for content generation */
  llm?: {
    generatePost(actor: GameActor, context: string): Promise<string>;
    generateArticle(
      org: GameOrganization,
      topic: string,
    ): Promise<ArticleInput>;
    generateTradingDecision(
      actor: GameActor,
      markets: ActiveMarket[],
    ): Promise<TradeInput | null>;
  };
  /** Market decision engine */
  marketDecisions?: {
    generateBatchDecisions(): Promise<TradeInput[]>;
  };
  /** Question manager */
  questionManager?: {
    generateQuestion(): Promise<QuestionInput>;
    generateResolutionProof(
      question: ActiveQuestion,
    ): Promise<{ description: string; proof?: string }>;
  };
}

/**
 * Core game tick executor.
 * Processes one unit of game time with injectable clock and state store.
 */
export class GameTick {
  constructor(
    private clock: GameClock,
    private store: GameStateStore,
    private services: TickServices = {},
  ) {}

  /** Execute one game tick */
  async execute(config: TickConfig = {}): Promise<TickResult> {
    const time = this.clock.tick();
    const startMs = Date.now();
    const deadline = config.budgetMs ? startMs + config.budgetMs : Infinity;

    logger.info(
      `Executing tick ${time.tick}: Day ${time.day}, Hour ${time.hour}`,
      { timestamp: time.timestamp.toISOString() },
      "GameTick",
    );

    const result: TickResult = {
      time,
      postsCreated: 0,
      eventsCreated: 0,
      articlesCreated: 0,
      tradesExecuted: 0,
      marketsUpdated: 0,
      questionsResolved: 0,
      questionsCreated: 0,
    };

    // 1. Resolve questions that are due
    if (!config.skipResolution && Date.now() < deadline) {
      const resolved = await this.resolveQuestions(time);
      result.questionsResolved = resolved;
    }

    // 2. Execute NPC trading decisions
    if (!config.skipTrading && Date.now() < deadline) {
      const trades = await this.executeTrading();
      result.tradesExecuted = trades.executed;
      result.marketsUpdated = trades.marketsUpdated;
    }

    // 3. Generate content (posts, events, articles)
    if (!config.skipContent && Date.now() < deadline) {
      const content = await this.generateContent(time);
      result.postsCreated = content.posts;
      result.eventsCreated = content.events;
      result.articlesCreated = content.articles;
    }

    // 4. Generate new questions if needed
    if (!config.skipResolution && Date.now() < deadline) {
      const created = await this.ensureActiveQuestions();
      result.questionsCreated = created;
    }

    const durationMs = Date.now() - startMs;
    logger.info(
      `Tick ${time.tick} complete in ${durationMs}ms`,
      result,
      "GameTick",
    );

    return result;
  }

  private async resolveQuestions(time: GameTime): Promise<number> {
    const toResolve = await this.store.getQuestionsToResolve(time.timestamp);

    for (const question of toResolve) {
      if (question.outcome !== undefined) {
        await this.store.resolveQuestion(question.id, question.outcome);
        logger.info(
          `Resolved Q${question.questionNumber}: ${question.outcome ? "YES" : "NO"}`,
          {},
          "GameTick",
        );
      }
    }

    return toResolve.length;
  }

  private async executeTrading(): Promise<{
    executed: number;
    marketsUpdated: number;
  }> {
    if (!this.services.marketDecisions) {
      return { executed: 0, marketsUpdated: 0 };
    }

    const decisions =
      await this.services.marketDecisions.generateBatchDecisions();
    let executed = 0;
    const marketsAffected = new Set<string>();

    for (const trade of decisions) {
      const result = await this.store.executeTrade(trade);
      if (result.success) {
        executed++;
        marketsAffected.add(trade.marketId);
      }
    }

    return { executed, marketsUpdated: marketsAffected.size };
  }

  private async generateContent(
    _time: GameTime,
  ): Promise<{ posts: number; events: number; articles: number }> {
    // Core ticks do not own content adapters; hosts can wire generation services.
    return { posts: 0, events: 0, articles: 0 };
  }

  private async ensureActiveQuestions(): Promise<number> {
    const active = await this.store.getActiveQuestions();
    const targetCount = 10;

    if (active.length >= targetCount || !this.services.questionManager) {
      return 0;
    }

    const toCreate = Math.min(3, targetCount - active.length);
    let created = 0;

    for (let i = 0; i < toCreate; i++) {
      const question = await this.services.questionManager.generateQuestion();
      await this.store.createQuestion(question);
      created++;
    }

    return created;
  }
}
