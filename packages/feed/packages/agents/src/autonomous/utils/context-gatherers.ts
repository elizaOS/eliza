/**
 * Context Gathering Utilities
 *
 * Fetches market data, positions, posts, and other context
 * for agent decision making.
 */

import {
  actorRelationships,
  actorState,
  agentLogs as agentLogsTable,
  agentTrades,
  and,
  chatParticipants,
  chats,
  comments,
  count,
  db,
  desc,
  eq,
  follows,
  getDbInstance,
  getRawDrizzle,
  groups,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  markets,
  ne,
  or,
  perpMarketSnapshots,
  perpPositions,
  positions,
  posts,
  reactions,
  shares,
  sql,
  users,
  worldEvents,
} from "@feed/db";
import { StaticDataRegistry } from "@feed/engine";
import { logger } from "../../shared/logger";
import type {
  AgentMemoryEntry,
  AgentOwnPostContext,
  AgentSocialConnection,
  AgentTradeHistoryEntry,
  GroupChatIntel,
  MarketTrendContext,
  MoodStateContext,
  PerpMarketContext,
  PerpPositionContext,
  PostContext,
  PredictionMarketContext,
  PredictionPositionContext,
  RelationshipContext,
  WorldEventContext,
} from "../templates/multi-step-decision";
import { getPredictionMarketPrices } from "./prediction-pricing";
import { formatTimeHeld, getTimeAgo } from "./time-helpers";

// =============================================================================
// Market Context
// =============================================================================

/**
 * Get active prediction markets with pricing
 */
export async function getPredictionMarkets(): Promise<
  PredictionMarketContext[]
> {
  const activeMarkets = await db
    .select()
    .from(markets)
    .where(and(eq(markets.resolved, false), gte(markets.endDate, new Date())))
    .orderBy(desc(markets.createdAt))
    .limit(8);

  return activeMarkets.map((m) => {
    const yesShares = Number(m.yesShares || 1);
    const noShares = Number(m.noShares || 1);
    const { yesPrice, noPrice } = getPredictionMarketPrices(
      yesShares,
      noShares,
    );

    return {
      id: m.id,
      question: m.question,
      yesPrice,
      noPrice,
      volume: yesShares + noShares,
      endDate: m.endDate?.toISOString().split("T")[0] ?? "Unknown",
    };
  });
}

/**
 * Get perp markets with current prices
 */
export async function getPerpMarkets(): Promise<PerpMarketContext[]> {
  const orgStates = await getDbInstance().getOrganizationsByPrice();
  const result: PerpMarketContext[] = [];

  for (const state of orgStates.slice(0, 8)) {
    const staticOrg = StaticDataRegistry.getOrganization(state.id);
    if (!staticOrg || staticOrg.type !== "company" || !staticOrg.ticker)
      continue;

    const currentPrice = state.currentPrice ?? staticOrg.initialPrice ?? 100;
    const initialPrice = staticOrg.initialPrice ?? 100;
    const changePercent = ((currentPrice - initialPrice) / initialPrice) * 100;

    result.push({
      ticker: staticOrg.ticker,
      name: staticOrg.name,
      currentPrice,
      initialPrice,
      changePercent,
    });
  }

  return result;
}

// =============================================================================
// Position Context
// =============================================================================

/**
 * Get agent's current positions with full context including time held and price movement
 */
export async function getAgentPositions(agentUserId: string): Promise<{
  predictions: PredictionPositionContext[];
  perps: PerpPositionContext[];
}> {
  const now = Date.now();

  // Prediction positions - fetch more fields
  const predPositions = await db
    .select({
      marketId: positions.marketId,
      side: positions.side,
      shares: positions.shares,
      avgPrice: positions.avgPrice,
      createdAt: positions.createdAt,
    })
    .from(positions)
    .where(
      and(eq(positions.userId, agentUserId), eq(positions.status, "active")),
    )
    .limit(10);

  // Get market data for positions (question + current prices)
  const marketIds = predPositions
    .map((p) => p.marketId)
    .filter(Boolean) as string[];
  const marketData = new Map<
    string,
    { question: string; yesPrice: number; noPrice: number }
  >();
  if (marketIds.length > 0) {
    const marketsData = await db
      .select({
        id: markets.id,
        question: markets.question,
        yesShares: markets.yesShares,
        noShares: markets.noShares,
      })
      .from(markets)
      .where(inArray(markets.id, marketIds));
    for (const m of marketsData) {
      const yesShares = Number(m.yesShares || 1);
      const noShares = Number(m.noShares || 1);
      const { yesPrice, noPrice } = getPredictionMarketPrices(
        yesShares,
        noShares,
      );
      marketData.set(m.id, {
        question: m.question,
        yesPrice,
        noPrice,
      });
    }
  }

  // Filter out dust positions (shares <= 0.01) to match executor's MIN_SHARES_THRESHOLD.
  // Without this, the LLM sees positions it can't actually trade, causing failed sell attempts.
  const MIN_SHARES_THRESHOLD = 0.01;

  const predictions: PredictionPositionContext[] = predPositions
    .filter((p) => p.marketId && Number(p.shares || 0) > MIN_SHARES_THRESHOLD)
    .map((p) => {
      const market = marketData.get(p.marketId as string);
      const avgPrice = Number(p.avgPrice || 0.5);
      const isYes = p.side === true;
      const currentPrice = market
        ? isYes
          ? market.yesPrice
          : market.noPrice
        : avgPrice;
      const pnlPercent =
        avgPrice > 0 ? ((currentPrice - avgPrice) / avgPrice) * 100 : 0;
      const timeHeldMs = p.createdAt
        ? now - new Date(p.createdAt).getTime()
        : 0;

      return {
        marketId: p.marketId as string,
        question: market?.question ?? "Unknown",
        side: isYes ? "YES" : "NO",
        shares: Number(p.shares || 0),
        avgPrice,
        currentPrice,
        pnlPercent,
        timeHeld: formatTimeHeld(timeHeldMs),
        timeHeldMs,
      };
    });

  // Perp positions - fetch more fields including entry price and opened time
  const perpPositionsList = await db
    .select({
      ticker: perpPositions.ticker,
      side: perpPositions.side,
      size: perpPositions.size,
      entryPrice: perpPositions.entryPrice,
      currentPrice: perpPositions.currentPrice,
      unrealizedPnL: perpPositions.unrealizedPnL,
      unrealizedPnLPercent: perpPositions.unrealizedPnLPercent,
      openedAt: perpPositions.openedAt,
    })
    .from(perpPositions)
    .where(
      and(
        eq(perpPositions.userId, agentUserId),
        isNull(perpPositions.closedAt),
      ),
    )
    .limit(10);

  const perps: PerpPositionContext[] = perpPositionsList.map((p) => {
    const entryPrice = Number(p.entryPrice || 100);
    const currentPrice = Number(p.currentPrice || entryPrice);
    const timeHeldMs = p.openedAt ? now - new Date(p.openedAt).getTime() : 0;

    // Calculate P&L percent based on side
    let pnlPercent = Number(p.unrealizedPnLPercent || 0);
    if (pnlPercent === 0 && entryPrice > 0) {
      const priceChange = currentPrice - entryPrice;
      const isLong = p.side === "long";
      pnlPercent = (priceChange / entryPrice) * 100 * (isLong ? 1 : -1);
    }

    return {
      ticker: p.ticker,
      side: p.side,
      size: Number(p.size || 0),
      pnl: Number(p.unrealizedPnL || 0),
      pnlPercent,
      entryPrice,
      currentPrice,
      timeHeld: formatTimeHeld(timeHeldMs),
      timeHeldMs,
    };
  });

  return { predictions, perps };
}

// =============================================================================
// Social Context
// =============================================================================

/**
 * Get agent's group chats for potential sharing
 * Excludes team chats (Agents) - agents shouldn't auto-respond there
 */
export async function getAgentGroupChats(
  agentUserId: string,
): Promise<
  { id: string; groupId: string | null; name: string; memberCount: number }[]
> {
  try {
    // Filter out team chats (Agents)
    const teamGroups = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.type, "team"));
    const teamGroupIds = new Set(teamGroups.map((g) => g.id));

    // Use DB-side aggregate count instead of loading all participant rows
    const rawDb = getRawDrizzle();
    const agentParticipation = rawDb
      .select({ chatId: chatParticipants.chatId })
      .from(chatParticipants)
      .where(eq(chatParticipants.userId, agentUserId))
      .as("agent_participation");

    const groupChatsWithCount = await rawDb
      .select({
        id: chats.id,
        name: chats.name,
        groupId: chats.groupId,
        memberCount: count(chatParticipants.id),
      })
      .from(chats)
      .innerJoin(agentParticipation, eq(chats.id, agentParticipation.chatId))
      .innerJoin(chatParticipants, eq(chats.id, chatParticipants.chatId))
      .where(eq(chats.isGroup, true))
      .groupBy(chats.id, chats.name, chats.groupId)
      .limit(10); // Fetch more to account for filtering

    // Filter out team chats
    const filteredChats = groupChatsWithCount.filter(
      (chat) => !chat.groupId || !teamGroupIds.has(chat.groupId),
    );

    return filteredChats.slice(0, 5).map((chat) => ({
      id: chat.id,
      groupId: chat.groupId,
      name: chat.name ?? "Group Chat",
      memberCount: chat.memberCount,
    }));
  } catch (error) {
    logger.warn(
      "Failed to fetch agent group chats",
      {
        agentUserId,
        error: error instanceof Error ? error.message : String(error),
      },
      "ContextGatherers",
    );
    return [];
  }
}

/**
 * Resolve a group chat by name for an agent.
 * Returns the chatId of the first matching group chat the agent is a member of.
 * Used for channel resolution when agents reference groups by name rather than ID.
 */
export async function resolveGroupChatByName(
  agentUserId: string,
  groupName: string,
): Promise<string | null> {
  // Sanitize input to prevent ilike pattern injection
  const sanitized = groupName.replace(/[%_\\]/g, "").trim();
  if (sanitized.length < 2) return null;

  const results = await db
    .select({ chatId: chats.id })
    .from(chatParticipants)
    .innerJoin(chats, eq(chatParticipants.chatId, chats.id))
    .innerJoin(groups, eq(chats.groupId, groups.id))
    .where(
      and(
        eq(chatParticipants.userId, agentUserId),
        eq(chats.isGroup, true),
        ilike(groups.name, `%${sanitized}%`),
      ),
    )
    .limit(1);

  return results[0]?.chatId ?? null;
}

/**
 * Resolve a user by their username.
 * Returns the userId or null if not found.
 */
export async function resolveUserByUsername(
  username: string,
): Promise<string | null> {
  const clean = username.replace(/^@/, "").trim().toLowerCase();
  if (!clean) return null;

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, clean))
    .limit(1);

  return user?.id ?? null;
}

/**
 * Get agent's own recent posts for self-awareness
 */
export async function getAgentOwnPosts(
  agentUserId: string,
): Promise<AgentOwnPostContext[]> {
  try {
    const recentOwnPosts = await db
      .select({
        id: posts.id,
        content: posts.content,
        timestamp: posts.timestamp,
      })
      .from(posts)
      .where(and(eq(posts.authorId, agentUserId), isNull(posts.deletedAt)))
      .orderBy(desc(posts.timestamp))
      .limit(5);

    if (recentOwnPosts.length === 0) {
      return [];
    }

    // Get engagement counts for these posts
    const postIds = recentOwnPosts.map((p) => p.id);
    const [likeCounts, commentCounts] = await Promise.all([
      db
        .select({
          postId: reactions.postId,
          count: sql<number>`count(*)`,
        })
        .from(reactions)
        .where(
          and(inArray(reactions.postId, postIds), eq(reactions.type, "like")),
        )
        .groupBy(reactions.postId),
      db
        .select({
          postId: comments.postId,
          count: sql<number>`count(*)`,
        })
        .from(comments)
        .where(
          and(inArray(comments.postId, postIds), isNull(comments.deletedAt)),
        )
        .groupBy(comments.postId),
    ]);

    const likeCountMap = new Map<string, number>();
    const commentCountMap = new Map<string, number>();
    for (const row of likeCounts) {
      if (row.postId) likeCountMap.set(row.postId, Number(row.count));
    }
    for (const row of commentCounts) {
      if (row.postId) commentCountMap.set(row.postId, Number(row.count));
    }

    return recentOwnPosts.map((p) => ({
      content: p.content,
      timeAgo: getTimeAgo(p.timestamp),
      likeCount: likeCountMap.get(p.id) ?? 0,
      commentCount: commentCountMap.get(p.id) ?? 0,
    }));
  } catch (error) {
    logger.warn(
      "Failed to fetch agent own posts",
      {
        agentUserId,
        error: error instanceof Error ? error.message : String(error),
      },
      "ContextGatherers",
    );
    return [];
  }
}

/**
 * Get recent posts to potentially engage with
 */
export async function getRecentPosts(
  agentUserId: string,
): Promise<PostContext[]> {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const now = new Date();

  const recentPostsRaw = await db
    .select({
      id: posts.id,
      content: posts.content,
      authorId: posts.authorId,
      createdAt: posts.createdAt,
    })
    .from(posts)
    .where(
      and(
        ne(posts.authorId, agentUserId),
        isNull(posts.deletedAt),
        gte(posts.timestamp, oneDayAgo),
        lte(posts.timestamp, now),
      ),
    )
    .orderBy(desc(posts.createdAt))
    .limit(20);

  // Get author names
  const authorIds = [...new Set(recentPostsRaw.map((p) => p.authorId))];
  const authorNames = new Map<string, string>();
  const contactableAuthorIds = new Set<string>();

  for (const authorId of authorIds) {
    // Check static registry first
    const actor = StaticDataRegistry.getActor(authorId);
    if (actor) {
      authorNames.set(authorId, actor.name);
      continue;
    }
    const org = StaticDataRegistry.getOrganization(authorId);
    if (org) {
      authorNames.set(authorId, org.name);
    }
  }

  // Fetch remaining from DB
  const missingIds = authorIds.filter((id) => !authorNames.has(id));
  if (missingIds.length > 0) {
    const dbUsers = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        username: users.username,
        isActor: users.isActor,
      })
      .from(users)
      .where(inArray(users.id, missingIds));
    for (const u of dbUsers) {
      authorNames.set(u.id, u.displayName || u.username || "User");
      if (!u.isActor) {
        contactableAuthorIds.add(u.id);
      }
    }
  }

  // Fetch agent's existing engagement on these posts
  const postIds = recentPostsRaw.map((p) => p.id);
  const agentComments = new Map<string, string>();
  const agentLikes = new Set<string>();
  const agentReposts = new Set<string>();
  const postLikeCounts = new Map<string, number>();
  const postRepostCounts = new Map<string, number>();
  const postCommentCounts = new Map<string, number>();

  if (postIds.length > 0) {
    // Fetch agent's existing comments (top-level only)
    const existingComments = await db
      .select({
        postId: comments.postId,
        content: comments.content,
      })
      .from(comments)
      .where(
        and(
          inArray(comments.postId, postIds),
          eq(comments.authorId, agentUserId),
          isNull(comments.parentCommentId),
          isNull(comments.deletedAt),
        ),
      );

    for (const comment of existingComments) {
      if (comment.postId) {
        agentComments.set(comment.postId, comment.content);
      }
    }

    // Execute all engagement queries in parallel
    const [
      existingLikes,
      existingReposts,
      likeCounts,
      repostCounts,
      commentCounts,
    ] = await Promise.all([
      db
        .select({ postId: reactions.postId })
        .from(reactions)
        .where(
          and(
            inArray(reactions.postId, postIds),
            eq(reactions.userId, agentUserId),
            eq(reactions.type, "like"),
          ),
        ),
      db
        .select({ postId: shares.postId })
        .from(shares)
        .where(
          and(inArray(shares.postId, postIds), eq(shares.userId, agentUserId)),
        ),
      db
        .select({
          postId: reactions.postId,
          count: sql<number>`count(*)`,
        })
        .from(reactions)
        .where(
          and(inArray(reactions.postId, postIds), eq(reactions.type, "like")),
        )
        .groupBy(reactions.postId),
      db
        .select({
          postId: shares.postId,
          count: sql<number>`count(*)`,
        })
        .from(shares)
        .where(inArray(shares.postId, postIds))
        .groupBy(shares.postId),
      db
        .select({
          postId: comments.postId,
          count: sql<number>`count(*)`,
        })
        .from(comments)
        .where(
          and(inArray(comments.postId, postIds), isNull(comments.deletedAt)),
        )
        .groupBy(comments.postId),
    ]);

    for (const like of existingLikes) {
      if (like.postId) agentLikes.add(like.postId);
    }

    for (const repost of existingReposts) {
      agentReposts.add(repost.postId);
    }

    for (const row of likeCounts) {
      if (row.postId) postLikeCounts.set(row.postId, Number(row.count));
    }

    for (const row of repostCounts) {
      postRepostCounts.set(row.postId, Number(row.count));
    }

    for (const row of commentCounts) {
      if (row.postId) postCommentCounts.set(row.postId, Number(row.count));
    }
  }

  return recentPostsRaw.map((p) => ({
    id: p.id,
    authorId: p.authorId,
    authorName: authorNames.get(p.authorId) || "User",
    authorCanContact: contactableAuthorIds.has(p.authorId),
    content: p.content,
    commentCount: postCommentCounts.get(p.id) ?? 0,
    likeCount: postLikeCounts.get(p.id) ?? 0,
    repostCount: postRepostCounts.get(p.id) ?? 0,
    timeAgo: getTimeAgo(p.createdAt),
    agentComment: agentComments.get(p.id),
    agentLiked: agentLikes.has(p.id),
    agentReposted: agentReposts.has(p.id),
  }));
}

// =============================================================================
// Market Trends (price direction + volatility)
// =============================================================================

/**
 * Get perp market trends with 24h price movement data.
 * Provides the richer context that MarketDecisionEngine had.
 */
export async function getMarketTrends(): Promise<MarketTrendContext[]> {
  try {
    const snapshots = await db
      .select({
        ticker: perpMarketSnapshots.ticker,
        name: perpMarketSnapshots.name,
        currentPrice: perpMarketSnapshots.currentPrice,
        price24hAgo: perpMarketSnapshots.price24hAgo,
        change24h: perpMarketSnapshots.change24h,
        changePercent24h: perpMarketSnapshots.changePercent24h,
        high24h: perpMarketSnapshots.high24h,
        low24h: perpMarketSnapshots.low24h,
        volume24h: perpMarketSnapshots.volume24h,
        openInterest: perpMarketSnapshots.openInterest,
      })
      .from(perpMarketSnapshots)
      .orderBy(desc(perpMarketSnapshots.openInterest))
      .limit(12);

    return snapshots.map((s) => {
      const price = s.currentPrice;
      const high = s.high24h;
      const low = s.low24h;
      const volatility = price > 0 ? ((high - low) / price) * 100 : 0;

      return {
        ticker: s.ticker,
        name: s.name ?? s.ticker,
        currentPrice: price,
        change24h: s.change24h,
        changePercent24h: s.changePercent24h,
        high24h: high,
        low24h: low,
        volume24h: s.volume24h,
        openInterest: s.openInterest,
        volatility24h: Math.round(volatility * 100) / 100,
        direction:
          s.changePercent24h > 1
            ? "up"
            : s.changePercent24h < -1
              ? "down"
              : "flat",
      };
    });
  } catch (error) {
    logger.warn(
      "Failed to fetch market trends",
      { error: error instanceof Error ? error.message : String(error) },
      "ContextGatherers",
    );
    return [];
  }
}

// =============================================================================
// Relationships
// =============================================================================

/**
 * Get NPC relationships (friends, enemies, allies).
 * Replicates the relationship context from MarketContextService.
 */
export async function getRelationships(
  agentUserId: string,
): Promise<RelationshipContext[]> {
  try {
    const relationships = await db
      .select({
        actor1Id: actorRelationships.actor1Id,
        actor2Id: actorRelationships.actor2Id,
        relationshipType: actorRelationships.relationshipType,
        strength: actorRelationships.strength,
        sentiment: actorRelationships.sentiment,
        history: actorRelationships.history,
      })
      .from(actorRelationships)
      .where(
        or(
          eq(actorRelationships.actor1Id, agentUserId),
          eq(actorRelationships.actor2Id, agentUserId),
        ),
      )
      .limit(10);

    return relationships.map((r) => {
      const otherId = r.actor1Id === agentUserId ? r.actor2Id : r.actor1Id;
      const actor = StaticDataRegistry.getActor(otherId);

      return {
        actorId: otherId,
        actorName: actor?.name ?? otherId,
        relationshipType: r.relationshipType,
        strength: r.strength,
        sentiment: r.sentiment,
        history: r.history ?? undefined,
      };
    });
  } catch (error) {
    logger.warn(
      "Failed to fetch relationships",
      {
        agentUserId,
        error: error instanceof Error ? error.message : String(error),
      },
      "ContextGatherers",
    );
    return [];
  }
}

// =============================================================================
// World Events / News
// =============================================================================

/**
 * Get recent world events for agent context.
 *
 * NPCs receive all events including leaked ones and signal direction
 * (pointsToward), giving them insider-level awareness.
 *
 * User-controlled agents only see public events with no signal direction,
 * similar to what a real player would observe — they know something
 * happened but not which way it points.
 */
export async function getWorldEventsContext(
  agentUserId?: string,
  isNpc = false,
): Promise<WorldEventContext[]> {
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const now = new Date();

    // User agents only see public events; NPCs see everything
    const visibilityFilter = isNpc
      ? undefined
      : eq(worldEvents.visibility, "public");

    const events = await db
      .select({
        eventType: worldEvents.eventType,
        description: worldEvents.description,
        actors: worldEvents.actors,
        relatedQuestion: worldEvents.relatedQuestion,
        pointsToward: worldEvents.pointsToward,
        timestamp: worldEvents.timestamp,
      })
      .from(worldEvents)
      .where(
        and(
          gte(worldEvents.timestamp, oneDayAgo),
          lte(worldEvents.timestamp, now),
          visibilityFilter,
        ),
      )
      .orderBy(desc(worldEvents.timestamp))
      .limit(10);

    return events.map((e) => ({
      type: e.eventType,
      description: e.description.slice(0, 300),
      timestamp: e.timestamp.toISOString(),
      actors: e.actors ?? [],
      relatedQuestion: e.relatedQuestion ?? undefined,
      // Strip signal direction for non-NPCs — no insider info
      pointsToward: isNpc ? (e.pointsToward ?? undefined) : undefined,
      isRelevantToAgent:
        agentUserId != null &&
        Array.isArray(e.actors) &&
        e.actors.includes(agentUserId),
    }));
  } catch (error) {
    logger.warn(
      "Failed to fetch world events",
      { error: error instanceof Error ? error.message : String(error) },
      "ContextGatherers",
    );
    return [];
  }
}

// =============================================================================
// Mood / State
// =============================================================================

/**
 * Get NPC mood and activity state for context.
 */
export async function getMoodState(
  agentUserId: string,
): Promise<MoodStateContext | null> {
  try {
    const [state] = await db
      .select({
        currentMood: actorState.currentMood,
        tradingBalance: actorState.tradingBalance,
        reputationPoints: actorState.reputationPoints,
      })
      .from(actorState)
      .where(eq(actorState.id, agentUserId))
      .limit(1);

    if (!state) return null;

    const moodValue = Number(state.currentMood ?? 0);
    const moodLabel =
      moodValue > 0.3 ? "bullish" : moodValue < -0.3 ? "bearish" : "neutral";

    return {
      mood: moodLabel,
      luck: 0,
      tradingBalance: Number(state.tradingBalance),
      reputationPoints: state.reputationPoints ?? 0,
    };
  } catch (error) {
    logger.warn(
      "Failed to fetch mood state",
      {
        agentUserId,
        error: error instanceof Error ? error.message : String(error),
      },
      "ContextGatherers",
    );
    return null;
  }
}

// =============================================================================
// Group Chat Intel
// =============================================================================

/**
 * Fetch group chat intel (summaries, facts, recent messages) for agent context.
 * Uses the SharedChatContextService which maintains lightweight summaries
 * refreshed on cadence (every 10 messages) or staleness (30+ mins).
 */
export async function getGroupChatIntel(
  agentUserId: string,
): Promise<GroupChatIntel[]> {
  try {
    const { sharedChatContextService } = await import("@feed/engine");
    const contexts =
      await sharedChatContextService.getRelevantGroupContextForUser(
        agentUserId,
        {
          chatLimit: 5,
          messageWindowSize: 8,
          factLimit: 5,
          staleAfterMinutes: 30,
          refreshThreshold: 10,
        },
      );

    return contexts.map((ctx) => ({
      chatName: ctx.chatName || "Group Chat",
      summary: ctx.summary,
      keyFacts: ctx.facts,
      recentMessages: ctx.recentMessages.map((m) => ({
        speaker: m.speaker,
        content: m.content,
      })),
    }));
  } catch (error) {
    logger.warn(
      "Failed to fetch group chat intel",
      {
        agentUserId,
        error: error instanceof Error ? error.message : String(error),
      },
      "ContextGatherers",
    );
    return [];
  }
}

// =============================================================================
// Agent Trade History (user-controlled agents)
// =============================================================================

/**
 * Get recent trade history for a user-controlled autonomous agent.
 * Returns structured trade records including the LLM's reasoning for each trade.
 *
 * Uses the `agentTrades` table (populated by AgentPnLService.recordTrade)
 * with the existing compound index on (agentUserId, executedAt).
 */
export async function getAgentTradeHistory(
  agentUserId: string,
  limit = 10,
): Promise<AgentTradeHistoryEntry[]> {
  try {
    const rows = await db
      .select({
        marketType: agentTrades.marketType,
        ticker: agentTrades.ticker,
        marketId: agentTrades.marketId,
        side: agentTrades.side,
        amount: agentTrades.amount,
        price: agentTrades.price,
        pnl: agentTrades.pnl,
        reasoning: agentTrades.reasoning,
        executedAt: agentTrades.executedAt,
      })
      .from(agentTrades)
      .where(eq(agentTrades.agentUserId, agentUserId))
      .orderBy(desc(agentTrades.executedAt))
      .limit(limit);

    return rows.map((r) => ({
      marketType: r.marketType,
      ticker: r.ticker,
      marketId: r.marketId,
      side: r.side,
      amount: r.amount,
      price: r.price,
      pnl: r.pnl,
      reasoning: r.reasoning,
      executedAt: r.executedAt,
    }));
  } catch (error) {
    logger.warn(
      "Failed to fetch agent trade history",
      {
        agentUserId,
        error: error instanceof Error ? error.message : String(error),
      },
      "ContextGatherers",
    );
    return [];
  }
}

// =============================================================================
// Agent Social Graph (user-controlled agents)
// =============================================================================

/**
 * Derive a lightweight social graph for a user-controlled agent from:
 * 1. follows table — who the agent follows and who follows them back (mutual detection)
 * 2. comments + posts — who the agent has engaged with recently (last 7 days)
 *
 * Uses existing indexes: Follow_followerId_idx, Follow_followingId_idx,
 * Comment_authorId_createdAt_idx, Reaction_userId_createdAt_idx
 */
export async function getAgentSocialGraph(
  agentUserId: string,
): Promise<AgentSocialConnection[]> {
  try {
    return await getAgentSocialGraphInner(agentUserId);
  } catch (error) {
    logger.warn(
      "Failed to fetch agent social graph",
      {
        agentUserId,
        error: error instanceof Error ? error.message : String(error),
      },
      "ContextGatherers",
    );
    return [];
  }
}

async function getAgentSocialGraphInner(
  agentUserId: string,
): Promise<AgentSocialConnection[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    followingRows,
    followerRows,
    commentInteractions,
    reactionInteractions,
  ] = await Promise.all([
    db
      .select({ followingId: follows.followingId })
      .from(follows)
      .where(eq(follows.followerId, agentUserId))
      .orderBy(desc(follows.createdAt))
      .limit(20),

    db
      .select({ followerId: follows.followerId })
      .from(follows)
      .where(eq(follows.followingId, agentUserId))
      .limit(100),

    db
      .select({
        targetUserId: posts.authorId,
        interactionCount: count(),
      })
      .from(comments)
      .innerJoin(posts, eq(comments.postId, posts.id))
      .where(
        and(
          eq(comments.authorId, agentUserId),
          ne(posts.authorId, agentUserId),
          gte(comments.createdAt, sevenDaysAgo),
        ),
      )
      .groupBy(posts.authorId)
      .orderBy(desc(count()))
      .limit(10),

    db
      .select({
        targetUserId: posts.authorId,
        interactionCount: count(),
      })
      .from(reactions)
      .innerJoin(posts, eq(reactions.postId, posts.id))
      .where(
        and(
          eq(reactions.userId, agentUserId),
          ne(posts.authorId, agentUserId),
          gte(reactions.createdAt, sevenDaysAgo),
        ),
      )
      .groupBy(posts.authorId)
      .orderBy(desc(count()))
      .limit(10),
  ]);

  const followingIds = new Set(followingRows.map((r) => r.followingId));
  const followerIds = new Set(followerRows.map((r) => r.followerId));

  const interactionMap = new Map<string, number>();
  for (const row of commentInteractions) {
    interactionMap.set(
      row.targetUserId,
      (interactionMap.get(row.targetUserId) || 0) +
        Number(row.interactionCount),
    );
  }
  for (const row of reactionInteractions) {
    interactionMap.set(
      row.targetUserId,
      (interactionMap.get(row.targetUserId) || 0) +
        Number(row.interactionCount),
    );
  }

  const connectionMap = new Map<string, AgentSocialConnection>();

  for (const id of followingIds) {
    connectionMap.set(id, {
      userId: id,
      displayName: "",
      username: null,
      isFollowing: true,
      isFollowedBy: followerIds.has(id),
      interactionCount: interactionMap.get(id) || 0,
      source: interactionMap.has(id) ? "both" : "follow",
    });
  }

  for (const [userId, cnt] of interactionMap) {
    if (!connectionMap.has(userId)) {
      connectionMap.set(userId, {
        userId,
        displayName: "",
        username: null,
        isFollowing: false,
        isFollowedBy: followerIds.has(userId),
        interactionCount: cnt,
        source: "interaction",
      });
    }
  }

  if (connectionMap.size === 0) return [];

  const allUserIds = [...connectionMap.keys()];
  const userRows = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      username: users.username,
    })
    .from(users)
    .where(inArray(users.id, allUserIds));

  const nameMap = new Map(
    userRows.map((u) => [
      u.id,
      {
        displayName: u.displayName || u.username || u.id.slice(0, 8),
        username: u.username,
      },
    ]),
  );

  const connections = [...connectionMap.values()].map((c) => ({
    ...c,
    displayName: nameMap.get(c.userId)?.displayName || c.userId.slice(0, 8),
    username: nameMap.get(c.userId)?.username || null,
  }));

  connections.sort((a, b) => {
    const aMutual = a.isFollowing && a.isFollowedBy ? 1 : 0;
    const bMutual = b.isFollowing && b.isFollowedBy ? 1 : 0;
    if (aMutual !== bMutual) return bMutual - aMutual;
    return b.interactionCount - a.interactionCount;
  });

  return connections.slice(0, 15);
}

// =============================================================================
// Agent Memory (user-controlled agents)
// =============================================================================

/**
 * Get recent activity log entries for a user-controlled agent to use as memory.
 * Queries the agentLogs table for the agent's recent actions, re-surfacing
 * the LLM's reasoning (thinking field) from previous ticks.
 *
 * Uses the existing compound index on (agentUserId, createdAt).
 *
 * @param excludeTypes - Log types to exclude (e.g., ['trade'] when trade
 *   history section already provides that data, avoiding duplication)
 */
export async function getAgentMemory(
  agentUserId: string,
  excludeTypes: string[] = [],
): Promise<AgentMemoryEntry[]> {
  const allTypes = ["trade", "post", "comment", "chat", "dm"];
  const types = allTypes.filter((t) => !excludeTypes.includes(t));
  if (types.length === 0) return [];

  const rows = await db
    .select({
      type: agentLogsTable.type,
      message: agentLogsTable.message,
      thinking: agentLogsTable.thinking,
      createdAt: agentLogsTable.createdAt,
    })
    .from(agentLogsTable)
    .where(
      and(
        eq(agentLogsTable.agentUserId, agentUserId),
        inArray(agentLogsTable.type, types),
        eq(agentLogsTable.level, "info"),
      ),
    )
    .orderBy(desc(agentLogsTable.createdAt))
    .limit(12);

  return rows.map((r) => ({
    type: r.type,
    message:
      r.message.length > 100 ? `${r.message.slice(0, 100)}...` : r.message,
    thinking: r.thinking
      ? r.thinking.length > 120
        ? `${r.thinking.slice(0, 120)}...`
        : r.thinking
      : null,
    createdAt: r.createdAt,
  }));
}
