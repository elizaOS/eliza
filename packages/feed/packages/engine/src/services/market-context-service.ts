/**
 * Market Context Service
 *
 * Builds complete market context for NPCs to make trading decisions.
 * Gathers: feed posts, group chats, events, market data, current positions.
 *
 * Token-aware: Limits context size to prevent LLM token overflows
 */

import { PerpDbAdapter } from '@feed/core/markets/perps';
import { maxSafeBuy } from '@feed/core/markets/prediction/client';
import {
  actorRelationships,
  actorState,
  and,
  chatParticipants,
  chats,
  db,
  desc,
  eq,
  getDbInstance,
  gte,
  inArray,
  isNull,
  lte,
  markets,
  messages,
  or,
  perpPositions,
  poolPositions,
  posts,
  questions,
  worldEvents,
} from '@feed/db';
import { logger } from '@feed/shared';
import {
  getSimulationPrice,
  getSimulationTickers,
  SIMULATION_PREDICTION_MARKETS,
} from '../config/simulation';
import { isSimulationMode } from '../storage-bridge';
import type {
  EventContext,
  FeedPostContext,
  GroupChatContext,
  MarketSignalContext,
  MarketSnapshots,
  NPCMarketContext,
  NPCPosition,
  PerpMarketSnapshot,
  PredictionMarketSnapshot,
  RelationshipContext,
} from '../types/market-context';
import {
  fetchRelevantPosts,
  findRelatedActorsByAffiliation,
  resolveActorName,
} from '../utils/actor-utils';
import { parseStringArraySafe } from './jsonb-validators';
import {
  buildPerpMarketSnapshot,
  buildPredictionMarketSnapshot,
} from './market-context-helpers';
import {
  buildPredictionMarketProfile,
  getPredictionMarketLiquidityTier,
} from './prediction-market-profiles';
import { SignalExtractionService } from './signal-extraction-service';
import { StaticDataRegistry } from './static-data-registry';

export class MarketContextService {
  /**
   * Build market context for all NPCs in the system
   *
   * Optimized to minimize database queries by fetching shared data once
   * and reusing it across all NPCs. Filters out test actors.
   *
   * @param options - Optional overrides for simulation mode
   * @param options.priceOverrides - Map of ticker -> price for causal simulation
   * @param options.recentEvents - Array of recent events (for causal simulation)
   * @returns Map of NPC ID to their market context
   *
   * @remarks
   * This method is optimized for batch processing. For single NPC context,
   * use buildContextForNPC() which is more efficient for individual lookups.
   *
   * @example
   * ```typescript
   * const contexts = await service.buildContextForAllNPCs();
   * const npcContext = contexts.get('npc-123');
   * ```
   */
  async buildContextForAllNPCs(options?: {
    priceOverrides?: Map<string, number>;
    recentEvents?: EventContext[];
  }): Promise<Map<string, NPCMarketContext>> {
    const startTime = Date.now();

    // Simulation Mode Bypass
    if (isSimulationMode()) {
      const staticActors = StaticDataRegistry.getAllActors();

      // Filter out test actors
      const npcs = staticActors
        .filter((actor) => !actor.name.includes('Group Test') && !actor.isTest)
        .map((actor) => ({
          id: actor.id,
          name: actor.name,
          description: actor.description,
          domain: actor.domain,
          personality: actor.personality,
          tier: actor.tier,
          affiliations: actor.affiliations,
          postStyle: actor.postStyle,
          postExample: actor.postExample,
          tradingBalance: '100000', // Mock balance
          reputationPoints: 10000,
          hasPool: true,
        }));

      // In simulation mode, we skip DB queries for messages/relationships/positions
      // and provide empty/mock data using centralized constants from config/simulation.ts
      const contexts = new Map<string, NPCMarketContext>();

      // Build perp markets using shared price helpers
      const priceOverrides = options?.priceOverrides;
      const tickers = getSimulationTickers(priceOverrides);

      const perpMarkets: PerpMarketSnapshot[] = tickers.map((ticker) => {
        const price = getSimulationPrice(ticker, priceOverrides);
        return {
          ticker,
          currentPrice: price,
          change24h: 0,
          changePercent24h: 0,
          name: ticker,
          organizationId: ticker.toLowerCase(),
          high24h: price * 1.01,
          low24h: price * 0.99,
          volume24h: 1000000,
          openInterest: 500000,
        };
      });

      // Use centralized prediction market constants
      const predictionMarkets: PredictionMarketSnapshot[] =
        SIMULATION_PREDICTION_MARKETS.map((m) => {
          const profile = buildPredictionMarketProfile({
            marketId: m.id,
            question: m.text,
            endDate: new Date(Date.now() + m.resolveDays * 86400000),
          });
          // Derive approximate pool shares from totalVolume and yesPrice
          // (mirrors initializeMarket logic for simulation mode estimates).
          const simNoShares = m.totalVolume * (m.yesPrice / 100);
          const simYesShares = m.totalVolume - simNoShares;
          return {
            id: m.id,
            text: m.text,
            yesPrice: m.yesPrice,
            noPrice: m.noPrice,
            totalVolume: m.totalVolume,
            resolutionDate: new Date(
              Date.now() + m.resolveDays * 86400000
            ).toISOString(),
            daysUntilResolution: m.resolveDays,
            horizonBucket: profile.horizonBucket,
            liquidityTier: getPredictionMarketLiquidityTier(m.totalVolume),
            urgencyLevel: profile.urgencyLevel,
            eventSensitivity: profile.eventSensitivity,
            maxSafeBet: maxSafeBuy(simYesShares, simNoShares),
          };
        });

      // Use provided events or empty array
      const recentEvents = options?.recentEvents ?? [];

      for (const npc of npcs) {
        contexts.set(npc.id, {
          npcId: npc.id,
          npcName: npc.name,
          personality: npc.personality || 'neutral trader',
          tier: npc.tier || 'B_TIER',
          availableBalance: 100000,
          relationships: [], // Empty for simulation
          recentPosts: [], // Empty for simulation
          groupChatMessages: [], // Empty for simulation
          recentEvents, // Use provided events (from causal simulation)
          perpMarkets,
          predictionMarkets,
          currentPositions: [], // Empty for simulation start
        });
      }

      return contexts;
    }

    // Fetch all NPCs from static registry and state table
    // Filter out test actors (Group Test Alice, Bob, Charlie)
    const staticActors = StaticDataRegistry.getAllActors();
    const actorStates = await db.select().from(actorState);
    const stateMap = new Map(actorStates.map((s) => [s.id, s]));

    // Combine static and dynamic data, filter test actors
    const npcs = staticActors
      .filter((actor) => !actor.name.includes('Group Test') && !actor.isTest)
      .map((actor) => {
        const state = stateMap.get(actor.id);
        return {
          id: actor.id,
          name: actor.name,
          description: actor.description,
          domain: actor.domain,
          personality: actor.personality,
          tier: actor.tier,
          affiliations: actor.affiliations,
          postStyle: actor.postStyle,
          postExample: actor.postExample,
          tradingBalance: state?.tradingBalance ?? '10000',
          reputationPoints: state?.reputationPoints ?? 10000,
          hasPool: state?.hasPool ?? false,
        };
      });

    // Fetch shared data once (used by all NPCs)
    const [marketSnapshots, recentPosts, recentEvents] = await Promise.all([
      this.getMarketSnapshots(),
      this.getRecentFeed(),
      this.getRecentEvents(),
    ]);

    // Extract signal analysis for active prediction markets (for better NPC trading)
    // This is internal context - never exposed to players
    const marketSignals = await this.extractMarketSignals(
      marketSnapshots.predictions
    );

    // Get group chats with messages
    const groupChats = await db
      .select({
        id: chats.id,
        name: chats.name,
      })
      .from(chats)
      .where(eq(chats.isGroup, true));

    // Get messages for each group chat
    const groupChatMessages = new Map<string, typeof messagesData>();
    const messagesData = await db
      .select()
      .from(messages)
      .where(
        inArray(
          messages.chatId,
          groupChats.map((c) => c.id)
        )
      )
      .orderBy(desc(messages.createdAt))
      .limit(500); // Limit total messages

    // Group messages by chat
    for (const msg of messagesData) {
      const existing = groupChatMessages.get(msg.chatId) || [];
      if (existing.length < 50) {
        // Max 50 per chat
        existing.push(msg);
        groupChatMessages.set(msg.chatId, existing);
      }
    }

    // Fetch all relationships for all NPCs in one query
    const npcIds = npcs.map((npc) => npc.id);
    const actorNameById = new Map(npcs.map((npc) => [npc.id, npc.name]));
    const allRelationships =
      npcIds.length > 0
        ? await db
            .select()
            .from(actorRelationships)
            .where(
              or(
                inArray(actorRelationships.actor1Id, npcIds),
                inArray(actorRelationships.actor2Id, npcIds)
              )
            )
        : [];

    const positionsByNpc = await this.getCurrentPositionsByNpcIds(npcIds);

    const groupChatIds = groupChats.map((chat) => chat.id);
    const groupChatMemberships =
      groupChatIds.length > 0 && npcIds.length > 0
        ? await db
            .select({
              chatId: chatParticipants.chatId,
              userId: chatParticipants.userId,
            })
            .from(chatParticipants)
            .where(
              and(
                inArray(chatParticipants.chatId, groupChatIds),
                inArray(chatParticipants.userId, npcIds)
              )
            )
        : [];
    const chatIdsByNpc = new Map<string, Set<string>>();
    for (const membership of groupChatMemberships) {
      const existing = chatIdsByNpc.get(membership.userId) ?? new Set<string>();
      existing.add(membership.chatId);
      chatIdsByNpc.set(membership.userId, existing);
    }

    // Build context for each NPC
    const contexts = new Map<string, NPCMarketContext>();

    for (const npc of npcs) {
      // Use actor's trading balance (no pools)
      const availableBalance = Number.parseFloat(npc.tradingBalance.toString());

      // Filter group chats this NPC is a member of (based on chat participants)
      const npcGroupChats: GroupChatContext[] = [];
      const memberChatIds = chatIdsByNpc.get(npc.id) ?? new Set<string>();
      for (const chat of groupChats) {
        if (!memberChatIds.has(chat.id)) {
          continue;
        }
        const chatMsgs = groupChatMessages.get(chat.id) || [];
        for (const msg of chatMsgs) {
          npcGroupChats.push({
            chatId: chat.id,
            chatName: chat.name || 'Group Chat',
            from: msg.senderId,
            fromName: actorNameById.get(msg.senderId) ?? msg.senderId,
            message: msg.content,
            timestamp: msg.createdAt.toISOString(),
          });
        }
      }

      const currentPositions = positionsByNpc.get(npc.id) ?? [];

      // Get relationships for this NPC
      const npcRelationships = allRelationships
        .filter((rel) => rel.actor1Id === npc.id || rel.actor2Id === npc.id)
        .map((rel) => {
          const isActor1 = rel.actor1Id === npc.id;
          const otherActorId = isActor1 ? rel.actor2Id : rel.actor1Id;

          return {
            actorId: otherActorId,
            actorName: otherActorId,
            relationshipType: rel.relationshipType,
            sentiment: rel.sentiment || 0,
            strength: rel.strength || 0.5,
            history: rel.history || undefined,
          };
        });

      contexts.set(npc.id, {
        npcId: npc.id,
        npcName: npc.name,
        personality: npc.personality || 'neutral trader',
        tier: npc.tier || 'B_TIER',
        availableBalance,
        relationships: npcRelationships,
        recentPosts,
        groupChatMessages: npcGroupChats,
        recentEvents,
        perpMarkets: marketSnapshots.perps,
        predictionMarkets: marketSnapshots.predictions,
        currentPositions,
        marketSignals, // Add signal analysis for better trading decisions
      });
    }

    const duration = Date.now() - startTime;
    logger.info(
      `Built market context for ${contexts.size} NPCs in ${duration}ms`,
      {
        npcCount: contexts.size,
        durationMs: duration,
      },
      'MarketContextService'
    );

    return contexts;
  }

  /**
   * Build context for a specific NPC with relationship data
   *
   * Fetches market data, feed posts, events, and relationships for a single NPC.
   * More efficient than buildContextForAllNPCs() for individual lookups.
   *
   * @param npcId - Unique identifier for the NPC
   * @returns Complete market context for the NPC
   * @throws Error if NPC not found
   *
   * @example
   * ```typescript
   * const context = await service.buildContextForNPC('npc-123');
   * console.log(`Balance: ${context.availableBalance}`);
   * console.log(`Markets: ${context.predictionMarkets.length}`);
   * ```
   */
  async buildContextForNPC(npcId: string): Promise<NPCMarketContext> {
    // Get static actor data from registry
    const staticNpc = StaticDataRegistry.getActor(npcId);
    if (!staticNpc) {
      throw new Error(`NPC not found: ${npcId}`);
    }

    // Get dynamic state from database
    const npcState = await getDbInstance().getActorState(npcId);

    // Combine static and dynamic data
    const npc = {
      ...staticNpc,
      tradingBalance: npcState?.tradingBalance ?? '10000',
      reputationPoints: npcState?.reputationPoints ?? 10000,
      hasPool: npcState?.hasPool ?? false,
    };

    const [marketSnapshots, recentPosts, recentEvents, groupChatMessages] =
      await Promise.all([
        this.getMarketSnapshots(),
        this.getRecentFeed(),
        this.getRecentEvents(),
        this.getInsiderInfo(npcId),
      ]);

    // Extract signal analysis for prediction markets
    const marketSignals = await this.extractMarketSignals(
      marketSnapshots.predictions
    );

    // Get relationships for this NPC
    const relationships = await this.getRelationshipsForNPC(npcId);

    // Use actor's trading balance (no pools)
    const availableBalance = Number.parseFloat(npc.tradingBalance.toString());

    const currentPositions =
      (await this.getCurrentPositionsByNpcIds([npcId])).get(npcId) ?? [];

    return {
      npcId: npc.id,
      npcName: npc.name,
      personality: npc.personality || 'neutral trader',
      tier: npc.tier || 'B_TIER',
      availableBalance,
      relationships,
      recentPosts,
      groupChatMessages,
      recentEvents,
      perpMarkets: marketSnapshots.perps,
      predictionMarkets: marketSnapshots.predictions,
      currentPositions,
      marketSignals, // Add signal analysis for better trading decisions
    };
  }

  /**
   * Get relationships for an NPC
   *
   * Retrieves all actor relationships where the NPC is involved,
   * regardless of event association.
   *
   * @param npcId - Unique identifier for the NPC
   * @returns Array of relationship contexts
   */
  private async getRelationshipsForNPC(
    npcId: string
  ): Promise<RelationshipContext[]> {
    const relationshipsList = await db
      .select()
      .from(actorRelationships)
      .where(
        or(
          eq(actorRelationships.actor1Id, npcId),
          eq(actorRelationships.actor2Id, npcId)
        )
      );

    return relationshipsList.map((rel) => {
      const isActor1 = rel.actor1Id === npcId;
      const otherActorId = isActor1 ? rel.actor2Id : rel.actor1Id;

      return {
        actorId: otherActorId,
        actorName: otherActorId,
        relationshipType: rel.relationshipType,
        sentiment: rel.sentiment || 0,
        strength: rel.strength || 0.5,
        history: rel.history || undefined,
      };
    });
  }

  /**
   * Get insider information from group chats this NPC is in
   *
   * Retrieves messages from group chats where the NPC is a member.
   * Messages are truncated and limited to prevent token overflow.
   *
   * @param npcId - Unique identifier for the NPC
   * @returns Array of group chat message contexts
   *
   * @remarks
   * - Limited to 20 messages per chat
   * - Messages truncated to 120 characters
   * - Only includes chats where NPC is a participant
   */
  private async getInsiderInfo(npcId: string): Promise<GroupChatContext[]> {
    // Get chats where NPC is a participant
    const participantRecords = await db
      .select({ chatId: chatParticipants.chatId })
      .from(chatParticipants)
      .where(eq(chatParticipants.userId, npcId));

    const participantChatIds = participantRecords.map((p) => p.chatId);

    if (participantChatIds.length === 0) {
      return [];
    }

    const groupChats = await db
      .select()
      .from(chats)
      .where(
        and(eq(chats.isGroup, true), inArray(chats.id, participantChatIds))
      );

    const result: GroupChatContext[] = [];

    for (const chat of groupChats) {
      const chatMessages = await db
        .select()
        .from(messages)
        .where(eq(messages.chatId, chat.id))
        .orderBy(desc(messages.createdAt))
        .limit(20);

      for (const msg of chatMessages.slice(0, 5)) {
        const maxMsgLength = 300;
        const message =
          msg.content.length > maxMsgLength
            ? msg.content.slice(0, maxMsgLength) + '...'
            : msg.content;

        result.push({
          chatId: chat.id,
          chatName: chat.name || 'Group Chat',
          from: msg.senderId,
          fromName: resolveActorName(msg.senderId),
          message,
          timestamp: msg.createdAt.toISOString(),
        });
      }
    }

    return result;
  }

  /**
   * Get feed posts relevant to a specific NPC.
   * Prioritizes posts from actors the NPC shares affiliations or relationships with,
   * then fills remaining slots with recent posts from anyone.
   */
  async getRelevantFeedForNPC(npcId: string): Promise<FeedPostContext[]> {
    const actor = StaticDataRegistry.getActor(npcId);
    const affiliations = actor?.affiliations || [];

    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);

    // Build related actor IDs from affiliations
    const relatedActorIds = findRelatedActorsByAffiliation(npcId, affiliations);

    // Also include actors from relationships
    const relationships = await db
      .select({
        actor1Id: actorRelationships.actor1Id,
        actor2Id: actorRelationships.actor2Id,
      })
      .from(actorRelationships)
      .where(
        or(
          eq(actorRelationships.actor1Id, npcId),
          eq(actorRelationships.actor2Id, npcId)
        )
      );
    for (const rel of relationships) {
      const otherId = rel.actor1Id === npcId ? rel.actor2Id : rel.actor1Id;
      if (!relatedActorIds.includes(otherId)) relatedActorIds.push(otherId);
    }

    return fetchRelevantPosts(relatedActorIds, twoDaysAgo, now);
  }

  private async getRecentFeed(): Promise<FeedPostContext[]> {
    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const postList = await db
      .select()
      .from(posts)
      .where(
        and(
          isNull(posts.deletedAt),
          lte(posts.timestamp, now),
          gte(posts.timestamp, twoDaysAgo)
        )
      )
      .orderBy(desc(posts.timestamp))
      .limit(15);

    return postList.map((post) => {
      const maxContentLength = 500;
      const content =
        post.content.length > maxContentLength
          ? post.content.slice(0, maxContentLength) + '...'
          : post.content;

      const maxTitleLength = 120;
      const articleTitle =
        post.articleTitle && post.articleTitle.length > maxTitleLength
          ? post.articleTitle.slice(0, maxTitleLength) + '...'
          : post.articleTitle;

      return {
        author: post.authorId,
        authorName: resolveActorName(post.authorId),
        content,
        timestamp: post.timestamp.toISOString(),
        articleTitle: articleTitle || undefined,
      };
    });
  }

  /**
   * Get recent events with actor involvement
   *
   * Retrieves recent world events, filtering to only include events
   * up to the current time to prevent future information leakage.
   *
   * @returns Array of event contexts
   *
   * @remarks
   * - Limited to 20 most recent events
   * - Event descriptions truncated to 300 characters
   * - Only includes events with timestamp <= now()
   */
  private async getRecentEvents(): Promise<EventContext[]> {
    const now = new Date();
    const eventList = await db
      .select()
      .from(worldEvents)
      .where(lte(worldEvents.timestamp, now))
      .orderBy(desc(worldEvents.timestamp))
      .limit(20);

    return eventList.map((event) => {
      const maxDescLength = 300;
      const description =
        event.description.length > maxDescLength
          ? event.description.slice(0, maxDescLength) + '...'
          : event.description;

      return {
        type: event.eventType,
        description,
        actors: parseStringArraySafe(event.actors, {
          field: 'worldEvents.actors',
        }),
        timestamp: event.timestamp.toISOString(),
        relatedQuestion: event.relatedQuestion || undefined,
        pointsToward: event.pointsToward || undefined,
      };
    });
  }

  /**
   * Get events that involve a specific NPC
   *
   * Retrieves events where the NPC is listed in the actors array.
   * This is used to build personal context for NPC content generation.
   *
   * @param npcId - Unique identifier for the NPC
   * @param npcName - Name of the NPC (for name-based matching)
   * @returns Array of event contexts specific to this NPC
   */
  async getEventsForNPC(
    npcId: string,
    npcName: string
  ): Promise<EventContext[]> {
    // In simulation mode, events are not persisted to DB - return empty
    if (isSimulationMode()) {
      return [];
    }

    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

    // Get all recent events and filter by NPC involvement
    const eventList = await db
      .select()
      .from(worldEvents)
      .where(
        and(
          lte(worldEvents.timestamp, now),
          gte(worldEvents.timestamp, threeDaysAgo)
        )
      )
      .orderBy(desc(worldEvents.timestamp))
      .limit(100);

    // Filter events where NPC is in the actors array or mentioned in description
    const npcEvents = eventList.filter((event) => {
      const actorsArray = event.actors || [];
      const isInActors =
        actorsArray.includes(npcId) ||
        actorsArray.some(
          (a) =>
            a.toLowerCase().includes(npcName.toLowerCase()) ||
            npcName.toLowerCase().includes(a.toLowerCase())
        );
      const isMentioned =
        event.description.toLowerCase().includes(npcName.toLowerCase()) ||
        event.description.includes(npcId);

      return isInActors || isMentioned;
    });

    return npcEvents.slice(0, 15).map((event) => {
      const maxDescLength = 200;
      const description =
        event.description.length > maxDescLength
          ? event.description.slice(0, maxDescLength) + '...'
          : event.description;

      return {
        type: event.eventType,
        description,
        actors: parseStringArraySafe(event.actors, {
          field: 'worldEvents.actors',
        }),
        timestamp: event.timestamp.toISOString(),
        relatedQuestion: event.relatedQuestion || undefined,
        pointsToward: event.pointsToward || undefined,
      };
    });
  }

  /**
   * Get recent posts by a specific NPC
   *
   * Used to provide memory of what the NPC has previously posted,
   * preventing repetition and maintaining consistency.
   *
   * @param npcId - Unique identifier for the NPC
   * @returns Array of the NPC's recent posts
   */
  async getRecentPostsByNPC(npcId: string): Promise<FeedPostContext[]> {
    // In simulation mode, posts are not persisted to DB - return empty
    if (isSimulationMode()) {
      return [];
    }

    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

    const npcPosts = await db
      .select()
      .from(posts)
      .where(
        and(
          eq(posts.authorId, npcId),
          gte(posts.timestamp, threeDaysAgo),
          lte(posts.timestamp, now),
          isNull(posts.deletedAt)
        )
      )
      .orderBy(desc(posts.timestamp))
      .limit(10);

    return npcPosts.map((post) => {
      const maxContentLength = 200;
      const content =
        post.content.length > maxContentLength
          ? post.content.slice(0, maxContentLength) + '...'
          : post.content;

      return {
        author: post.authorId,
        authorName: post.authorId,
        content,
        timestamp: post.timestamp.toISOString(),
        articleTitle: post.articleTitle || undefined,
      };
    });
  }

  /**
   * Get current market snapshots
   *
   * Retrieves snapshots of both perpetual and prediction markets.
   *
   * @returns MarketSnapshots with perps, predictions, and timestamp
   */
  private async getMarketSnapshots(): Promise<MarketSnapshots> {
    const [perps, predictions] = await Promise.all([
      this.getPerpMarketSnapshots(),
      this.getPredictionMarketSnapshots(),
    ]);

    return {
      perps,
      predictions,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get perpetual market snapshots
   *
   * Retrieves current state of all perpetual markets including:
   * - Current price and 24h price change
   * - High/low prices
   * - Volume and open interest
   *
   * @returns Array of perpetual market snapshots
   */
  private async getPerpMarketSnapshots(): Promise<PerpMarketSnapshot[]> {
    const perpDb = new PerpDbAdapter();
    const marketList = await perpDb.listMarkets();
    return marketList
      .sort(
        (a, b) => b.openInterest - a.openInterest || b.volume24h - a.volume24h
      )
      .map((market) => buildPerpMarketSnapshot(market));
  }

  /**
   * Get prediction market snapshots
   *
   * Retrieves current state of active prediction markets.
   * Limited to top 15 most active markets to control token usage.
   *
   * @returns Array of prediction market snapshots
   *
   * @remarks
   * - Limited to 15 most active markets (by yesShares)
   * - Question text is never truncated
   * - Only includes unresolved markets with endDate >= now
   */
  private async getPredictionMarketSnapshots(): Promise<
    PredictionMarketSnapshot[]
  > {
    const now = new Date();
    const marketList = await db
      .select()
      .from(markets)
      .where(and(eq(markets.resolved, false), gte(markets.endDate, now)))
      .orderBy(desc(markets.liquidity), desc(markets.updatedAt))
      .limit(15);

    return marketList.map((market) =>
      buildPredictionMarketSnapshot(
        {
          id: market.id,
          question: market.question,
          yesShares: Number.parseFloat(market.yesShares.toString()),
          noShares: Number.parseFloat(market.noShares.toString()),
          liquidity: Number.parseFloat(market.liquidity.toString()),
          endDate: market.endDate,
        },
        now
      )
    );
  }

  /**
   * Extract signal analysis for prediction markets
   *
   * Uses SignalExtractionService to analyze feed content and determine
   * signal direction for each active market. This helps NPCs make
   * better-informed trading decisions.
   *
   * @internal This data is for NPC AI only - never expose to players
   * @param predictionMarkets - Active prediction markets to analyze
   * @returns Array of market signal contexts
   */
  private async extractMarketSignals(
    predictionMarkets: PredictionMarketSnapshot[]
  ): Promise<MarketSignalContext[]> {
    if (predictionMarkets.length === 0) {
      return [];
    }

    const signals: MarketSignalContext[] = [];

    // Extract signals for up to 5 active markets (limit to avoid overhead)
    const marketsToAnalyze = predictionMarkets.slice(0, 5);

    for (const market of marketsToAnalyze) {
      const questionResult = await db
        .select({ questionNumber: questions.questionNumber })
        .from(questions)
        .where(eq(questions.id, market.id))
        .limit(1);

      const questionNumber = questionResult[0]?.questionNumber;
      if (questionNumber === undefined || questionNumber === null) continue;

      try {
        const analysis =
          await SignalExtractionService.extractMarketSignal(questionNumber);

        // Don't expose suggestedOutcome to NPCs — it leaks the correct answer.
        // Only provide signal strength and confidence (directionally neutral).
        signals.push({
          marketId: market.id,
          yesSignal: analysis.yesSignal,
          noSignal: analysis.noSignal,
          netSignal: analysis.netSignal,
          strength: analysis.signalStrength,
          suggestedOutcome: 'UNCERTAIN' as const, // Neutralized: don't leak predetermined outcomes to NPCs
          confidence: analysis.confidence,
        });

        logger.debug(
          'Extracted market signal',
          {
            marketId: market.id,
            suggestedOutcome: analysis.suggestedOutcome,
            confidence: (analysis.confidence * 100).toFixed(1) + '%',
          },
          'MarketContextService'
        );
      } catch (error) {
        // Signal extraction is optional - continue if it fails
        logger.debug(
          'Signal extraction failed for market (non-critical)',
          {
            marketId: market.id,
            error: error instanceof Error ? error.message : 'Unknown',
          },
          'MarketContextService'
        );
      }
    }

    return signals;
  }

  private async getCurrentPositionsByNpcIds(
    npcIds: string[]
  ): Promise<Map<string, NPCPosition[]>> {
    if (npcIds.length === 0) {
      return new Map();
    }

    const [
      openPerpPositions,
      openLegacyPerpPositions,
      openPredictionPositions,
    ] = await Promise.all([
      db
        .select({
          id: perpPositions.id,
          userId: perpPositions.userId,
          ticker: perpPositions.ticker,
          side: perpPositions.side,
          entryPrice: perpPositions.entryPrice,
          currentPrice: perpPositions.currentPrice,
          size: perpPositions.size,
          unrealizedPnL: perpPositions.unrealizedPnL,
          openedAt: perpPositions.openedAt,
        })
        .from(perpPositions)
        .where(
          and(
            inArray(perpPositions.userId, npcIds),
            isNull(perpPositions.closedAt)
          )
        ),
      db
        .select({
          id: poolPositions.id,
          poolId: poolPositions.poolId,
          ticker: poolPositions.ticker,
          side: poolPositions.side,
          entryPrice: poolPositions.entryPrice,
          currentPrice: poolPositions.currentPrice,
          size: poolPositions.size,
          unrealizedPnL: poolPositions.unrealizedPnL,
          openedAt: poolPositions.openedAt,
        })
        .from(poolPositions)
        .where(
          and(
            inArray(poolPositions.poolId, npcIds),
            eq(poolPositions.marketType, 'perp'),
            isNull(poolPositions.closedAt)
          )
        ),
      db
        .select({
          id: poolPositions.id,
          poolId: poolPositions.poolId,
          marketId: poolPositions.marketId,
          side: poolPositions.side,
          entryPrice: poolPositions.entryPrice,
          currentPrice: poolPositions.currentPrice,
          size: poolPositions.size,
          shares: poolPositions.shares,
          unrealizedPnL: poolPositions.unrealizedPnL,
          openedAt: poolPositions.openedAt,
        })
        .from(poolPositions)
        .where(
          and(
            inArray(poolPositions.poolId, npcIds),
            eq(poolPositions.marketType, 'prediction'),
            isNull(poolPositions.closedAt)
          )
        ),
    ]);

    const positionsByNpc = new Map<string, NPCPosition[]>();
    const livePerpPositionIds = new Set(
      openPerpPositions.map((position) => position.id)
    );

    const pushPosition = (npcId: string, position: NPCPosition): void => {
      const existing = positionsByNpc.get(npcId);
      if (existing) {
        existing.push(position);
        return;
      }
      positionsByNpc.set(npcId, [position]);
    };

    for (const position of openPerpPositions) {
      pushPosition(position.userId, {
        id: position.id,
        marketType: 'perp',
        ticker: position.ticker,
        side: position.side,
        entryPrice: Number(position.entryPrice),
        currentPrice: Number(position.currentPrice),
        size: Number(position.size),
        unrealizedPnL: Number(position.unrealizedPnL),
        openedAt: position.openedAt.toISOString(),
      });
    }

    for (const position of openLegacyPerpPositions) {
      if (!position.poolId || livePerpPositionIds.has(position.id)) continue;
      pushPosition(position.poolId, {
        id: position.id,
        marketType: 'perp',
        ticker: position.ticker ?? undefined,
        side: position.side,
        entryPrice: Number(position.entryPrice),
        currentPrice: Number(position.currentPrice),
        size: Number(position.size),
        unrealizedPnL: Number(position.unrealizedPnL),
        openedAt: position.openedAt.toISOString(),
      });
    }

    for (const position of openPredictionPositions) {
      if (!position.poolId) continue;
      pushPosition(position.poolId, {
        id: position.id,
        marketType: 'prediction',
        marketId: position.marketId || undefined,
        side: position.side,
        entryPrice: Number(position.entryPrice),
        currentPrice: Number(position.currentPrice),
        size: Number(position.size),
        shares:
          position.shares === null || position.shares === undefined
            ? undefined
            : Number(position.shares),
        unrealizedPnL: Number(position.unrealizedPnL),
        openedAt: position.openedAt.toISOString(),
      });
    }

    return positionsByNpc;
  }
}
