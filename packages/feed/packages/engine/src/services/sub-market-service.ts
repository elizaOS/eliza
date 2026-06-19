/**
 * Sub-Market Service
 *
 * Handles the creation and management of child markets spawned from
 * narrative events. When a significant event occurs in a parent market,
 * this service determines if and what child market should be created.
 *
 * ## Spawn Flow
 *
 * 1. Event occurs in parent market
 * 2. Event type is matched against SUB_MARKET_TRIGGERS
 * 3. Probability check determines if spawn occurs
 * 4. Question is generated from template
 * 5. Child market is created with appropriate timeframe
 * 6. Spawn is logged for analytics and deduplication
 */

import {
  type ArcStateType,
  and,
  db,
  eq,
  gte,
  lte,
  type MarketCategory,
  type MarketTimeframe,
  type NewSubMarketSpawnLog,
  type NewTimeframedMarket,
  or,
  organizations,
  sql,
  subMarketSpawnLogs,
  type TimeframedMarket,
  type Transaction,
  timeframedMarkets,
  withTransaction,
} from "@feed/db";
import { generateSnowflakeId, logger } from "@feed/shared";
import { formatError } from "../utils/error-utils";
import {
  deriveTopicFromText,
  normalizeTopicDate,
  normalizeTopicKey,
} from "./daily-topic-service";
import {
  calculateEndTime,
  type SubMarketTrigger,
  shouldSpawnSubMarket,
  TIMEFRAME_CONFIGS,
} from "./market-timeframes";
import { StaticDataRegistry } from "./static-data-registry";

// =============================================================================
// TYPES
// =============================================================================

export interface SpawnContext {
  parentMarketId: string;
  eventId?: string;
  eventType: string;
  category: MarketCategory;
  timeframe: MarketTimeframe;
  /** Variables to substitute in question template */
  templateVars: Record<string, string>;
}

export interface SpawnResult {
  spawned: boolean;
  marketId?: string;
  reason?: string;
}

export interface GeneratedQuestion {
  text: string;
  affiliatedOrgIds: string[];
  affiliatedActorIds: string[];
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Maximum child markets per parent (prevent runaway spawning) */
const MAX_CHILD_MARKETS_PER_PARENT = 10;

/** Minimum time between spawns from same parent (minutes) */
const MIN_SPAWN_INTERVAL_MINUTES = 5;

/** Default duration modifier for child markets */
const DEFAULT_DURATION_MODIFIER = 1.0;

// =============================================================================
// SERVICE CLASS
// =============================================================================

export class SubMarketService {
  /**
   * Attempt to spawn a sub-market from an event
   */
  async trySpawnFromEvent(context: SpawnContext): Promise<SpawnResult> {
    const { parentMarketId, eventType, category, timeframe, templateVars } =
      context;

    try {
      // Check if spawn should occur
      const trigger = shouldSpawnSubMarket(eventType, category, timeframe);

      if (!trigger) {
        logger.debug(
          `No matching spawn trigger for event`,
          { eventType, category, timeframe },
          "SubMarketService",
        );
        return { spawned: false, reason: "no_matching_trigger" };
      }

      // Get parent market
      const [parent] = await db
        .select()
        .from(timeframedMarkets)
        .where(eq(timeframedMarkets.id, parentMarketId))
        .limit(1);

      if (!parent) {
        return { spawned: false, reason: "parent_not_found" };
      }

      // Check child market limit
      if (parent.childMarketCount >= MAX_CHILD_MARKETS_PER_PARENT) {
        await this.logSpawnSkipped(context, "max_children_reached");
        return { spawned: false, reason: "max_children_reached" };
      }

      // Check spawn interval
      const recentSpawns = await this.getRecentSpawns(
        parentMarketId,
        MIN_SPAWN_INTERVAL_MINUTES,
      );
      if (recentSpawns > 0) {
        await this.logSpawnSkipped(context, "too_recent");
        return { spawned: false, reason: "too_recent" };
      }

      // Generate question from template
      const question = await this.generateQuestion(
        trigger.questionTemplate,
        templateVars,
      );

      // Create the child market
      const childMarket = await this.createChildMarket(
        parent,
        trigger,
        question,
        context.eventId,
        templateVars,
      );

      // Log spawn
      await this.logSpawnSuccess(
        context,
        trigger,
        childMarket.id,
        question.text,
      );

      logger.info(
        `Spawned sub-market`,
        {
          parentId: parentMarketId,
          childId: childMarket.id,
          timeframe: trigger.childTimeframe,
          question: question.text,
        },
        "SubMarketService",
      );

      return { spawned: true, marketId: childMarket.id };
    } catch (error) {
      logger.error(
        `Failed to spawn sub-market`,
        { error: formatError(error) },
        "SubMarketService",
      );
      return { spawned: false, reason: "error" };
    }
  }

  /**
   * Get all active child markets for a parent
   */
  async getChildMarkets(parentMarketId: string): Promise<TimeframedMarket[]> {
    return db
      .select()
      .from(timeframedMarkets)
      .where(eq(timeframedMarkets.parentMarketId, parentMarketId));
  }

  /**
   * Get all markets in a hierarchy (root and all descendants)
   */
  async getMarketHierarchy(rootMarketId: string): Promise<TimeframedMarket[]> {
    // Get root and all descendants via rootMarketId
    return db
      .select()
      .from(timeframedMarkets)
      .where(eq(timeframedMarkets.rootMarketId, rootMarketId));
  }

  /**
   * Get active markets by timeframe
   */
  async getActiveMarketsByTimeframe(
    timeframe: MarketTimeframe,
  ): Promise<TimeframedMarket[]> {
    return db
      .select()
      .from(timeframedMarkets)
      .where(
        and(
          eq(timeframedMarkets.timeframe, timeframe),
          eq(timeframedMarkets.isActive, true),
        ),
      );
  }

  /**
   * Create a new timeframed market (can be standalone or part of hierarchy)
   */
  async createMarket(params: {
    questionId?: string;
    timeframe: MarketTimeframe;
    category: MarketCategory;
    parentMarketId?: string;
    startTime?: Date;
    durationModifier?: number;
    affiliatedOrgIds?: string[];
    affiliatedActorIds?: string[];
  }): Promise<TimeframedMarket> {
    const now = new Date();
    const startTime = params.startTime ?? now;
    const endTime = calculateEndTime(
      startTime,
      params.timeframe,
      params.durationModifier ?? DEFAULT_DURATION_MODIFIER,
    );

    // Determine root market ID
    let rootMarketId: string | null = null;
    if (params.parentMarketId) {
      const [parent] = await db
        .select({
          rootMarketId: timeframedMarkets.rootMarketId,
          id: timeframedMarkets.id,
        })
        .from(timeframedMarkets)
        .where(eq(timeframedMarkets.id, params.parentMarketId))
        .limit(1);

      if (parent) {
        // Root is either parent's root or parent itself if parent is root
        rootMarketId = parent.rootMarketId ?? parent.id;
      }
    }

    const id = await generateSnowflakeId();
    const arcStatesConfig = TIMEFRAME_CONFIGS[params.timeframe].arcStates;

    const newMarket: NewTimeframedMarket = {
      id,
      questionId: params.questionId ?? null,
      timeframe: params.timeframe,
      category: params.category,
      parentMarketId: params.parentMarketId ?? null,
      rootMarketId: rootMarketId,
      startTime,
      endTime,
      arcState: (arcStatesConfig[0] ?? "setup") as ArcStateType,
      arcStateEnteredAt: now,
      isActive: true,
      isResolved: false,
      affiliatedOrgIds: params.affiliatedOrgIds ?? [],
      affiliatedActorIds: params.affiliatedActorIds ?? [],
      childMarketCount: 0,
      eventsGenerated: 0,
      createdAt: now,
      updatedAt: now,
    };

    // Persist market and update parent count atomically within a transaction
    const created = await withTransaction(async (tx) => {
      const market = await this.persistTimeframedMarket(newMarket, tx);

      // Update parent's child count if applicable
      if (params.parentMarketId) {
        await this.incrementParentChildCount(params.parentMarketId, tx);
      }

      return market;
    });

    return created;
  }

  /**
   * Update arc state for a market
   */
  async updateArcState(
    marketId: string,
    newState: ArcStateType,
  ): Promise<void> {
    const now = new Date();
    await db
      .update(timeframedMarkets)
      .set({
        arcState: newState,
        arcStateEnteredAt: now,
        updatedAt: now,
      })
      .where(eq(timeframedMarkets.id, marketId));
  }

  /**
   * Mark a market as resolved
   */
  async resolveMarket(marketId: string): Promise<void> {
    const now = new Date();
    await db
      .update(timeframedMarkets)
      .set({
        isActive: false,
        isResolved: true,
        resolvedAt: now,
        arcState: "resolution",
        updatedAt: now,
      })
      .where(eq(timeframedMarkets.id, marketId));
  }

  /**
   * Get markets that need resolution (past end time but not resolved)
   */
  async getMarketsNeedingResolution(): Promise<TimeframedMarket[]> {
    const now = new Date();
    // Use database-level filtering for efficiency
    return db
      .select()
      .from(timeframedMarkets)
      .where(
        and(
          eq(timeframedMarkets.isActive, true),
          lte(timeframedMarkets.endTime, now),
          eq(timeframedMarkets.isResolved, false),
        ),
      );
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  /**
   * Shared helper to persist a timeframed market and return the created row.
   * Centralizes the insert logic to avoid duplication between createMarket and createChildMarket.
   * @param marketData - The market data to persist
   * @param tx - Optional transaction context for atomicity
   */
  private async persistTimeframedMarket(
    marketData: NewTimeframedMarket,
    tx?: Transaction,
  ): Promise<TimeframedMarket> {
    const dbClient = tx ?? db;
    const [created] = await dbClient
      .insert(timeframedMarkets)
      .values(marketData)
      .returning();

    if (!created) {
      throw new Error(`Failed to create timeframed market ${marketData.id}`);
    }

    return created;
  }

  /**
   * Shared helper to increment a parent market's child count.
   * Centralizes the parent-child count update logic.
   * @param parentMarketId - The parent market ID to update
   * @param tx - Optional transaction context for atomicity
   */
  private async incrementParentChildCount(
    parentMarketId: string,
    tx?: Transaction,
  ): Promise<void> {
    const dbClient = tx ?? db;
    const now = new Date();
    await dbClient
      .update(timeframedMarkets)
      .set({
        childMarketCount: sql`${timeframedMarkets.childMarketCount} + 1`,
        updatedAt: now,
      })
      .where(eq(timeframedMarkets.id, parentMarketId));
  }

  private async createChildMarket(
    parent: TimeframedMarket,
    trigger: SubMarketTrigger,
    question: GeneratedQuestion,
    eventId?: string,
    templateVars?: Record<string, string>,
  ): Promise<TimeframedMarket> {
    const now = new Date();
    const endTime = calculateEndTime(
      now,
      trigger.childTimeframe,
      trigger.durationModifier ?? DEFAULT_DURATION_MODIFIER,
    );

    const id = await generateSnowflakeId();
    const arcStatesConfig = TIMEFRAME_CONFIGS[trigger.childTimeframe].arcStates;
    const derivedTopic = deriveTopicFromText(question.text, now);

    // Topic resolution priority:
    // 1. Inherit from parent market if present
    // 2. Use trigger.topicSourceVar resolved from templateVars
    // 3. Fall back to deriveTopicFromText (frequency-based)
    let inheritedTopic: {
      topicKey: string;
      topicLabel: string;
      topicDate: Date;
    };

    if (parent.topicKey && parent.topicLabel) {
      inheritedTopic = {
        topicKey: parent.topicKey,
        topicLabel: parent.topicLabel,
        topicDate: parent.topicDate ?? derivedTopic.date,
      };
    } else if (trigger.topicSourceVar) {
      const varValue = templateVars?.[trigger.topicSourceVar]?.trim();
      if (varValue) {
        const normalizedKey = normalizeTopicKey(varValue);
        if (normalizedKey) {
          inheritedTopic = {
            topicKey: normalizedKey,
            topicLabel: varValue,
            topicDate: normalizeTopicDate(now),
          };
        } else {
          // varValue was all stopwords — fall back both key and label
          inheritedTopic = {
            topicKey: derivedTopic.topicKey,
            topicLabel: derivedTopic.topicLabel,
            topicDate: normalizeTopicDate(now),
          };
        }
      } else {
        logger.warn(
          `topicSourceVar "${trigger.topicSourceVar}" not found in templateVars for trigger ${trigger.eventType}`,
        );
        inheritedTopic = {
          topicKey: derivedTopic.topicKey,
          topicLabel: derivedTopic.topicLabel,
          topicDate: normalizeTopicDate(now),
        };
      }
    } else {
      inheritedTopic = {
        topicKey: derivedTopic.topicKey,
        topicLabel: derivedTopic.topicLabel,
        topicDate: normalizeTopicDate(now),
      };
    }

    const newMarket: NewTimeframedMarket = {
      id,
      questionId: null, // Child markets don't have a pre-existing question
      timeframe: trigger.childTimeframe,
      category: parent.category,
      topicKey: inheritedTopic.topicKey,
      topicLabel: inheritedTopic.topicLabel,
      topicDate: inheritedTopic.topicDate,
      parentMarketId: parent.id,
      rootMarketId: parent.rootMarketId ?? parent.id,
      startTime: now,
      endTime,
      arcState: (arcStatesConfig[0] ?? "setup") as ArcStateType,
      arcStateEnteredAt: now,
      isActive: true,
      isResolved: false,
      triggerData: {
        eventType: trigger.eventType,
        questionTemplate: trigger.questionTemplate,
        spawnedAt: now.toISOString(),
        parentEventId: eventId,
      },
      affiliatedOrgIds: question.affiliatedOrgIds,
      affiliatedActorIds: question.affiliatedActorIds,
      childMarketCount: 0,
      eventsGenerated: 0,
      createdAt: now,
      updatedAt: now,
    };

    // Persist market and update parent count atomically within a transaction
    const created = await withTransaction(async (tx) => {
      const market = await this.persistTimeframedMarket(newMarket, tx);
      await this.incrementParentChildCount(parent.id, tx);
      return market;
    });

    return created;
  }

  private async generateQuestion(
    template: string,
    vars: Record<string, string>,
  ): Promise<GeneratedQuestion> {
    let text = template;

    // Substitute template variables using split/join for literal replacement
    // Avoids ReDoS risk from regex metacharacters in keys
    for (const [key, value] of Object.entries(vars)) {
      text = text.split(`{${key}}`).join(value);
    }

    // Extract affiliations from variables
    const affiliatedOrgIds: string[] = [];
    const affiliatedActorIds: string[] = [];

    // Combine org name and ticker lookups into a single query with DISTINCT
    if (vars.org || vars.ticker) {
      const conditions = [];
      if (vars.org) {
        conditions.push(eq(organizations.name, vars.org));
      }
      if (vars.ticker) {
        conditions.push(eq(organizations.ticker, vars.ticker));
      }

      const orgs = await db
        .selectDistinct({ id: organizations.id })
        .from(organizations)
        .where(or(...conditions));

      for (const org of orgs) {
        affiliatedOrgIds.push(org.id);
      }
    }

    if (vars.actor) {
      // Try to find actor by name
      const actors = StaticDataRegistry.getAllActors();
      const actorName = vars.actor;
      const actor = actors.find(
        (a) =>
          a.name.toLowerCase() === actorName.toLowerCase() ||
          a.id === actorName,
      );
      if (actor) {
        affiliatedActorIds.push(actor.id);
      }
    }

    return {
      text,
      affiliatedOrgIds,
      affiliatedActorIds,
    };
  }

  private async getRecentSpawns(
    parentMarketId: string,
    withinMinutes: number,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - withinMinutes * 60 * 1000);
    // Use COUNT aggregation instead of fetching all rows for efficiency
    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(subMarketSpawnLogs)
      .where(
        and(
          eq(subMarketSpawnLogs.parentMarketId, parentMarketId),
          gte(subMarketSpawnLogs.createdAt, cutoff),
        ),
      );

    return result?.count ?? 0;
  }

  private async logSpawnSkipped(
    context: SpawnContext,
    reason: string,
  ): Promise<void> {
    const log: NewSubMarketSpawnLog = {
      id: await generateSnowflakeId(),
      parentMarketId: context.parentMarketId,
      sourceEventId: context.eventId ?? null,
      eventType: context.eventType,
      wasSpawned: false,
      skipReason: reason,
      createdAt: new Date(),
    };

    await db.insert(subMarketSpawnLogs).values(log);
  }

  private async logSpawnSuccess(
    context: SpawnContext,
    trigger: SubMarketTrigger,
    spawnedMarketId: string,
    generatedQuestion: string,
  ): Promise<void> {
    const log: NewSubMarketSpawnLog = {
      id: await generateSnowflakeId(),
      parentMarketId: context.parentMarketId,
      sourceEventId: context.eventId ?? null,
      eventType: context.eventType,
      spawnedMarketId,
      wasSpawned: true,
      questionTemplate: trigger.questionTemplate,
      generatedQuestion,
      childTimeframe: trigger.childTimeframe,
      createdAt: new Date(),
    };

    await db.insert(subMarketSpawnLogs).values(log);
  }
}

// Singleton instance
export const subMarketService = new SubMarketService();
