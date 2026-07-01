/**
 * Autonomous A2A Service
 *
 * Handles autonomous agent actions using the A2A protocol for protocol-compliant
 * interactions. Provides advanced actions beyond direct database access.
 *
 * @packageDocumentation
 */

import type { IAgentRuntime } from "@elizaos/core";
import { db, eq, users } from "@feed/db";
import type { FeedRuntime } from "../plugins/feed/types";
import { agentPnLService } from "../services/AgentPnLService";
import {
  getAgentConfig,
  isAutonomousTradingEnabled,
} from "../shared/agent-config";
import { logger } from "../shared/logger";
import { trackAgentTradeExecuted } from "./track-agent-trade";
import { getPredictionMarketPrices } from "./utils/prediction-pricing";

/**
 * Type guard to check if runtime has A2A client
 *
 * @internal
 */
function isFeedRuntime(runtime: IAgentRuntime): runtime is FeedRuntime {
  return (
    "a2aClient" in runtime && (runtime as FeedRuntime).a2aClient !== undefined
  );
}

/**
 * Prediction market data structure
 * @internal
 */
interface PredictionMarket {
  id: string;
  yesShares: number;
  noShares: number;
  liquidity: number;
  question: string;
}

/**
 * Perpetual position data structure
 * @internal
 */
interface PerpPosition {
  id: string;
  side: string;
  currentPrice: number;
  entryPrice: number;
}

interface PortfolioPosition {
  id: string;
  marketId?: string;
  ticker?: string;
  side: string;
  amount: number;
  price: number;
  pnl?: number;
  type: "prediction" | "perp";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPortfolioPosition(value: unknown): value is PortfolioPosition {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    typeof value.side === "string" &&
    typeof value.amount === "number" &&
    typeof value.price === "number" &&
    (value.type === "prediction" || value.type === "perp")
  );
}

function readPortfolio(value: unknown): {
  balance: number;
  positions: PortfolioPosition[];
  pnl: number;
} {
  if (!isRecord(value)) {
    return { balance: 0, positions: [], pnl: 0 };
  }

  return {
    balance: typeof value.balance === "number" ? value.balance : 0,
    positions: Array.isArray(value.positions)
      ? value.positions.filter(isPortfolioPosition)
      : [],
    pnl: typeof value.pnl === "number" ? value.pnl : 0,
  };
}

/**
 * Service for autonomous actions via A2A protocol
 */
export class AutonomousA2AService {
  /**
   * Executes autonomous trading via A2A protocol
   *
   * Uses LLM-based decision making to analyze market conditions and execute
   * intelligent trades through the A2A protocol.
   *
   * @param agentUserId - Agent user ID
   * @param runtime - Agent runtime with A2A client
   * @returns Trade execution result
   * @throws Error if agent not found or A2A client unavailable
   */
  async executeA2ATrade(
    agentUserId: string,
    runtime: IAgentRuntime,
  ): Promise<{
    success: boolean;
    tradeId?: string;
    marketId?: string;
    ticker?: string;
    side?: string;
    marketType?: "prediction" | "perp";
  }> {
    if (!isFeedRuntime(runtime) || !runtime.a2aClient?.isConnected()) {
      logger.debug("A2A not available, skipping A2A trade", { agentUserId });
      return {
        success: false,
        marketId: undefined,
        ticker: undefined,
        side: undefined,
        marketType: undefined,
      };
    }

    const agentResult = await db
      .select()
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);
    const agent = agentResult[0];
    const config = await getAgentConfig(agentUserId);

    if (!agent?.isAgent || !isAutonomousTradingEnabled(config)) {
      return {
        success: false,
        marketId: undefined,
        ticker: undefined,
        side: undefined,
        marketType: undefined,
      };
    }

    // After type guard, runtime is FeedRuntime and a2aClient is defined
    const a2aClient = runtime.a2aClient;

    // Get available markets (both prediction and perpetual)
    const predictionsResponse = (await a2aClient.sendRequest(
      "a2a.getPredictions",
      {
        status: "active",
      },
    )) as { predictions?: PredictionMarket[] };

    const perpetualsResponse = (await a2aClient.sendRequest(
      "a2a.getPerpetuals",
      {},
    )) as {
      perpetuals?: Array<{
        ticker: string;
        price: number;
        priceChange24h?: number;
        volume24h: number;
      }>;
    };

    const predictionMarkets = predictionsResponse.predictions ?? [];
    const perpetualMarkets = perpetualsResponse.perpetuals ?? [];
    const hasPredictions = predictionMarkets.length > 0;
    const hasPerpetuals = perpetualMarkets.length > 0;

    if (!hasPredictions && !hasPerpetuals) {
      logger.debug("No markets available for trading", { agentUserId });
      return {
        success: false,
        marketId: undefined,
        ticker: undefined,
        side: undefined,
        marketType: undefined,
      };
    }

    // Get portfolio for context
    const portfolio = readPortfolio(
      await a2aClient.sendRequest("a2a.getPortfolio", {}),
    );

    // Shuffle markets to provide variety and avoid bias toward first markets
    const { shuffleArray } = await import("@feed/engine");
    const shuffledPredictions = hasPredictions
      ? shuffleArray([...predictionMarkets])
      : [];
    const shuffledPerpetuals = hasPerpetuals
      ? shuffleArray([...perpetualMarkets])
      : [];

    // Build LLM decision prompt with both market types
    const predictions = shuffledPredictions.slice(0, 5);
    const perpetuals = shuffledPerpetuals.slice(0, 5);

    const prompt = `${config?.systemPrompt ?? "You are an autonomous trading agent."}

You are ${agent.displayName}, an autonomous trading agent making a prediction market trading decision.

Current Status:
- Balance: $${portfolio.balance.toFixed(2)}
- P&L: $${portfolio.pnl.toFixed(2)}
- Open Positions: ${portfolio.positions.length}

Available Prediction Markets:
${
  predictions.length > 0
    ? predictions
        .map((m: PredictionMarket, i: number) => {
          const { yesPrice, noPrice } = getPredictionMarketPrices(
            m.yesShares,
            m.noShares,
          );
          return `${i + 1}. "${m.question}"
   - Market ID: ${m.id}
   - YES: ${(yesPrice * 100).toFixed(1)}% (${m.yesShares} shares)
   - NO: ${(noPrice * 100).toFixed(1)}% (${m.noShares} shares)
   - Liquidity: $${m.liquidity?.toFixed(0) || "0"}`;
        })
        .join("\n\n")
    : "(None available)"
}

Available Perpetual Markets:
${
  perpetuals.length > 0
    ? perpetuals
        .map((m, i: number) => {
          const priceChange = m.priceChange24h || 0;
          const changePercent = (priceChange * 100).toFixed(1);
          const trend = priceChange > 0 ? "📈" : priceChange < 0 ? "📉" : "➡️";
          return `${i + 1}. ${m.ticker}
   - Current Price: $${m.price.toFixed(2)}
   - 24h Change: ${trend} ${changePercent}%
   - Volume: $${m.volume24h.toFixed(0)}`;
        })
        .join("\n\n")
    : "(None available)"
}

Analyze these markets and decide if you should trade. Consider:
- Market odds vs your assessment
- Your available balance
- Risk/reward ratio
- Your existing positions

IMPORTANT: You MUST respond with ONLY valid JSON, nothing else. No explanations, no thinking, just the JSON.

JSON format for prediction markets:
{
  "action": "trade",
  "trade": {
    "type": "prediction",
    "marketId": "market-id",
    "outcome": "YES" | "NO",
    "amount": number (10-100),
    "reasoning": "brief explanation"
  }
}

JSON format for perpetual markets:
{
  "action": "trade",
  "trade": {
    "type": "perp",
    "ticker": "BTC" | "ETH" | etc,
    "side": "LONG" | "SHORT",
    "size": number (10-100),
    "leverage": number (1-5),
    "reasoning": "brief explanation"
  }
}

If you don't see a good opportunity: {"action": "hold", "reasoning": "why not"}

Your JSON response:`;

    // Call LLM for decision
    const { callGroqDirect } = await import("../llm/direct-groq");
    const decision = await callGroqDirect({
      prompt,
      system: config?.systemPrompt ?? undefined,
      modelSize: "large",
      runtime, // Pass runtime to access W&B trained models AND trajectory context
      temperature: 0.7,
      maxTokens: 400,
      actionType: "evaluate_a2a_trade",
      purpose: "action", // RLAIF: This is a trading action decision
    });

    // Parse decision
    const jsonMatch = decision.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.debug("No valid JSON in LLM response", {
        agentUserId,
        responseLength: decision.length,
      });
      return {
        success: false,
        marketId: undefined,
        ticker: undefined,
        side: undefined,
        marketType: undefined,
      };
    }

    const tradeDecision = JSON.parse(jsonMatch[0]) as {
      action: "trade" | "hold";
      trade?: {
        type?: "prediction" | "perp";
        marketId?: string;
        outcome?: "YES" | "NO";
        amount?: number;
        ticker?: string;
        side?: "LONG" | "SHORT";
        size?: number;
        leverage?: number;
        reasoning: string;
      };
    };

    if (tradeDecision.action !== "trade" || !tradeDecision.trade) {
      logger.debug("Agent decided to hold", { agentUserId });
      return {
        success: false,
        marketId: undefined,
        ticker: undefined,
        side: undefined,
        marketType: undefined,
      };
    }

    const trade = tradeDecision.trade;
    const tradeType = trade.type || "prediction"; // Default to prediction for backward compat

    // Execute based on trade type
    if (tradeType === "perp") {
      // Perpetual market trade
      const { ticker, side, size, leverage, reasoning } = trade;

      if (!ticker || !side || !size || size < 10 || size > portfolio.balance) {
        logger.warn("Invalid perp trade parameters", {
          ticker,
          side,
          size,
          balance: portfolio.balance,
        });
        return {
          success: false,
          marketId: undefined,
          ticker: undefined,
          side: undefined,
          marketType: undefined,
        };
      }

      const perpLeverage = leverage || 1;
      const tradeResult = (await a2aClient.sendRequest("a2a.openPosition", {
        ticker,
        side,
        size,
        leverage: perpLeverage,
      })) as { positionId?: string; entryPrice?: number };

      logger.info("A2A LLM-based perp trade executed", {
        agentUserId,
        ticker,
        side,
        size,
        leverage: perpLeverage,
        reasoning,
      });

      // Record trade via shared service (DRY - same as DirectExecutors)
      await agentPnLService.recordTrade({
        agentId: agentUserId,
        userId: agentUserId, // A2A trades are self-managed
        marketType: "perp",
        ticker,
        action: "open",
        side: side.toLowerCase() as "long" | "short",
        amount: size,
        price: tradeResult.entryPrice || 0,
        reasoning: `LLM decision (${perpLeverage}x leverage): ${reasoning}`,
      });

      const ownerId = agent?.managedBy ?? agentUserId;
      trackAgentTradeExecuted(agentUserId, {
        agent_id: agentUserId,
        market_type: "perp",
        action: "open",
        ticker,
        side,
        amount: size,
        owner_id: ownerId,
      });

      return {
        success: true,
        tradeId: tradeResult.positionId,
        marketId: undefined,
        ticker,
        side,
        marketType: "perp",
      };
    }
    // Prediction market trade
    const { marketId, outcome, amount, reasoning } = trade;

    if (
      !marketId ||
      !outcome ||
      !amount ||
      amount < 10 ||
      amount > portfolio.balance
    ) {
      logger.warn("Invalid prediction trade parameters", {
        marketId,
        outcome,
        amount,
        balance: portfolio.balance,
      });
      return {
        success: false,
        marketId: undefined,
        ticker: undefined,
        side: undefined,
        marketType: undefined,
      };
    }

    const tradeResult = (await a2aClient.sendRequest("a2a.buyShares", {
      marketId,
      outcome,
      amount,
    })) as { shares?: number; avgPrice?: number; positionId?: string };

    logger.info("A2A LLM-based trade executed", {
      agentUserId,
      marketId,
      outcome,
      amount,
      shares: tradeResult.shares || 0,
      reasoning,
    });

    // Record trade via shared service (DRY - same as DirectExecutors)
    await agentPnLService.recordTrade({
      agentId: agentUserId,
      userId: agentUserId, // A2A trades are self-managed
      marketType: "prediction",
      marketId,
      action: "open",
      side: outcome.toLowerCase() as "yes" | "no",
      amount,
      price: tradeResult.avgPrice || 0,
      reasoning: `LLM decision: ${reasoning}`,
    });

    const ownerId = agent?.managedBy ?? agentUserId;
    trackAgentTradeExecuted(agentUserId, {
      agent_id: agentUserId,
      market_type: "prediction",
      action: "buy",
      market_id: marketId,
      side: outcome,
      amount,
      owner_id: ownerId,
    });

    return {
      success: true,
      tradeId: tradeResult.positionId,
      marketId,
      ticker: undefined,
      side: outcome,
      marketType: "prediction",
    };
  }

  /**
   * Post via A2A with enhanced context
   */
  async createA2APost(
    agentUserId: string,
    runtime: IAgentRuntime,
    content: string,
  ): Promise<{ success: boolean; postId?: string }> {
    if (!isFeedRuntime(runtime) || !runtime.a2aClient?.isConnected()) {
      logger.debug("A2A not connected, skipping A2A post", { agentUserId });
      return { success: false };
    }

    const agentResult = await db
      .select()
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);
    const agent = agentResult[0];
    const postingConfig = await getAgentConfig(agentUserId);

    if (!agent?.isAgent || !postingConfig?.autonomousPosting) {
      return { success: false };
    }

    // After type guard, runtime is FeedRuntime and a2aClient is defined
    const a2aClient = runtime.a2aClient;

    // Create post via A2A
    const postResult = (await a2aClient.sendRequest("a2a.createPost", {
      content,
      type: "post",
    })) as { postId?: string };

    logger.info("A2A post created", {
      agentUserId,
      postId: postResult.postId,
      contentLength: content.length,
    });

    return { success: true, postId: postResult.postId };
  }

  /**
   * Engage with trending content via A2A
   */
  async engageWithTrending(
    agentUserId: string,
    runtime: IAgentRuntime,
  ): Promise<{ success: boolean; engagements: number }> {
    if (!isFeedRuntime(runtime) || !runtime.a2aClient?.isConnected()) {
      return { success: false, engagements: 0 };
    }

    const agentResult = await db
      .select()
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);
    const agent = agentResult[0];

    if (!agent?.isAgent) {
      return { success: false, engagements: 0 };
    }

    // After type guard, runtime is FeedRuntime and a2aClient is defined
    const a2aClient = runtime.a2aClient;

    // Get trending topics
    const trendingResponse = (await a2aClient.sendRequest(
      "a2a.getTrendingTags",
      {
        limit: 3,
      },
    )) as {
      tags?: Array<{
        name: string;
        displayName: string;
        category: string;
        postCount: number;
      }>;
    };

    if (!trendingResponse?.tags || trendingResponse.tags.length === 0) {
      return { success: false, engagements: 0 };
    }

    let engagements = 0;

    // Engage with top trending topic
    const topTag = trendingResponse.tags[0];
    if (!topTag) {
      return { success: false, engagements: 0 };
    }
    const postsResponse = (await a2aClient.sendRequest("a2a.getPostsByTag", {
      tag: topTag.name,
      limit: 5,
      offset: 0,
    })) as {
      posts?: Array<{
        id: string;
        content: string;
        authorId: string;
        timestamp: string;
      }>;
    };

    if (postsResponse?.posts && postsResponse.posts.length > 0) {
      // Like first post
      const post = postsResponse.posts[0];
      if (post?.id) {
        await a2aClient.sendRequest("a2a.likePost", {
          postId: post.id,
          userId: agentUserId, // Pass the agent's actual user ID
        });
        engagements++;

        logger.info("A2A engagement completed", {
          agentUserId,
          tag: topTag.name,
          engagements,
        });
      }
    }

    return { success: true, engagements };
  }

  /**
   * Monitor positions via A2A
   */
  async monitorPositions(
    agentUserId: string,
    runtime: IAgentRuntime,
  ): Promise<{ success: boolean; actionsTaken: number }> {
    if (!isFeedRuntime(runtime) || !runtime.a2aClient?.isConnected()) {
      return { success: false, actionsTaken: 0 };
    }

    const agentResult = await db
      .select()
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);
    const agent = agentResult[0];
    const tradingConfig = await getAgentConfig(agentUserId);

    if (!agent?.isAgent || !isAutonomousTradingEnabled(tradingConfig)) {
      return { success: false, actionsTaken: 0 };
    }

    // After type guard, runtime is FeedRuntime and a2aClient is defined
    const a2aClient = runtime.a2aClient;

    // Get positions via A2A
    const positionsResponse = (await a2aClient.sendRequest("a2a.getPositions", {
      userId: agentUserId,
    })) as { perpPositions?: PerpPosition[] };

    let actions = 0;

    // Check perp positions for stop-loss
    if (
      positionsResponse?.perpPositions &&
      positionsResponse.perpPositions.length > 0
    ) {
      for (const position of positionsResponse.perpPositions) {
        const pnlPercent =
          ((position.currentPrice - position.entryPrice) /
            position.entryPrice) *
          100;

        // Close if losing > 25%
        if (position.side === "long" && pnlPercent < -25) {
          await a2aClient.sendRequest("a2a.closePosition", {
            positionId: position.id,
          });
          actions++;

          logger.info("A2A stop-loss triggered", {
            agentUserId,
            positionId: position.id,
            pnlPercent,
          });
        }

        // Take profits if > 100%
        if (position.side === "long" && pnlPercent > 100) {
          await a2aClient.sendRequest("a2a.closePosition", {
            positionId: position.id,
          });
          actions++;

          logger.info("A2A take-profit triggered", {
            agentUserId,
            positionId: position.id,
            pnlPercent,
          });
        }
      }
    }

    return { success: true, actionsTaken: actions };
  }
}

export const autonomousA2AService = new AutonomousA2AService();
