/**
 * Autonomous Trading Service
 *
 * Handles agents making REAL trades on prediction markets and perps.
 * Uses DirectExecutors for actual trade execution (DRY principle).
 */

import { countTokensSync, truncateToTokenLimitSync } from '@babylon/api';
import {
  db,
  desc,
  eq,
  getDbInstance,
  markets,
  perpPositions,
  positions,
  users,
} from '@babylon/db';
import {
  formatRandomContext,
  generateRandomMarketContext,
  StaticDataRegistry,
  shuffleArray,
  WalletService,
} from '@babylon/engine';
import type { IAgentRuntime } from '@elizaos/core';
import { callGroqDirect } from '../llm/direct-groq';
import { getAgentConfig } from '../shared/agent-config';
import { logger } from '../shared/logger';
import { executeDirectTrade } from './DirectExecutors';
import { trackAgentTradeExecuted } from './track-agent-trade';
import { getPredictionMarketPrices } from './utils/prediction-pricing';
import { resolvePerpTicker } from './utils/resolvePerpTicker';

const SUGGESTED_TRADE_PERCENT = 0.25; // 25% of balance for more aggressive trading
const MIN_SUGGESTED_TRADE_SIZE = 25; // $25 minimum per trade
const MAX_SUGGESTED_TRADE_SIZE = 500; // $500 cap per trade

export class AutonomousTradingService {
  /**
   * Evaluate and execute trades for an agent
   *
   * Analyzes market conditions and agent strategy to make trading decisions.
   * Executes trades via DirectExecutors for consistent balance validation.
   */
  async executeTrades(
    agentUserId: string,
    _runtime: IAgentRuntime
  ): Promise<{
    tradesExecuted: number;
    marketId?: string;
    ticker?: string;
    side?: string;
    marketType?: 'prediction' | 'perp';
  }> {
    // Check if this is an NPC (has entry in StaticDataRegistry)
    const npcActor = StaticDataRegistry.getActor(agentUserId);
    const isNpc = !!npcActor;

    // Get agent from User table (will be null for NPCs)
    const agentResult = await db
      .select()
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);
    const agent = agentResult[0];

    // Fallback values for NPCs (who don't have User records)
    const agentDisplayName = isNpc
      ? npcActor.name
      : (agent?.displayName ?? agentUserId);

    // Get agent config (may be null for NPCs)
    const config = await getAgentConfig(agentUserId);

    // Get agent's positions separately
    const positionsResult = await db
      .select()
      .from(positions)
      .where(eq(positions.userId, agentUserId))
      .limit(10);

    // Get perp positions for perp-related info
    const perpPositionsResult = await db
      .select()
      .from(perpPositions)
      .where(eq(perpPositions.userId, agentUserId))
      .limit(10);

    // Get balance - NPCs use ActorState, Users use WalletService
    const balance = isNpc
      ? { balance: 10000, lifetimePnL: 0 }
      : await WalletService.getBalance(agentUserId);

    // Get active prediction markets
    const predictionMarkets = await db
      .select()
      .from(markets)
      .where(eq(markets.resolved, false))
      .orderBy(desc(markets.createdAt))
      .limit(10);

    // Get perp market snapshots via the db instance
    const perpMarkets = await getDbInstance().getOrganizationsByPrice();

    // Get random market context for variety
    const marketContext = await generateRandomMarketContext({
      includeGainers: true,
      includeLosers: true,
      includeQuestions: true,
      includePosts: false,
      includeEvents: false,
    });
    const contextString = formatRandomContext(marketContext);

    // Filter to only companies for perps
    const perpCompanies = perpMarkets.filter((o) => {
      const staticOrg = StaticDataRegistry.getOrganization(o.id);
      return staticOrg?.type === 'company';
    });

    // Format positions and markets for prompt
    const positionsStr =
      positionsResult.length > 0
        ? positionsResult
            .map((p) => `${p.side ? 'YES' : 'NO'} on ${p.marketId}`)
            .join(', ')
        : 'None';

    const perpPositionsStr =
      perpPositionsResult.length > 0
        ? perpPositionsResult.map((p) => `${p.side} ${p.ticker}`).join(', ')
        : 'None';

    const shuffledPredictions = shuffleArray([...predictionMarkets]);
    const shuffledPerps = shuffleArray([...perpCompanies]);

    const predictionMarketsStr = shuffledPredictions
      .slice(0, 5)
      .map((m) => {
        const yesShares = Number(m.yesShares || 1);
        const noShares = Number(m.noShares || 1);
        const { yesPrice } = getPredictionMarketPrices(yesShares, noShares);
        return `- [${m.id}] "${m.question}" (YES: ${(yesPrice * 100).toFixed(1)}%)`;
      })
      .join('\n');

    const perpMarketsStr = shuffledPerps
      .slice(0, 5)
      .map((o) => {
        const staticOrg = StaticDataRegistry.getOrganization(o.id);
        return `- ${staticOrg?.ticker || o.id}: ${staticOrg?.name || 'Unknown'} @ $${o.currentPrice?.toFixed(2) || '?'}`;
      })
      .join('\n');

    const suggestedTradeSize =
      balance.balance > 0
        ? Math.min(
            Math.max(
              balance.balance * SUGGESTED_TRADE_PERCENT,
              MIN_SUGGESTED_TRADE_SIZE
            ),
            MAX_SUGGESTED_TRADE_SIZE,
            balance.balance
          )
        : 0;
    const suggestedTradeSizeText = suggestedTradeSize.toFixed(2);

    // Build trading prompt
    const prompt = `${config?.systemPrompt ?? 'You are an AI trading agent on Babylon.'}

You are ${agentDisplayName}, a trader on Babylon prediction markets and perps.

Current State:
- Balance: $${balance.balance.toFixed(2)}
- Prediction positions: ${positionsStr}
- Perp positions: ${perpPositionsStr}

Available Prediction Markets:
${predictionMarketsStr || 'None available'}

Available Perp Markets (stocks):
${perpMarketsStr || 'None available'}

${contextString}

Strategy: ${config?.tradingStrategy || 'Balanced risk/reward seeking alpha'}

Suggested Trade Size (${SUGGESTED_TRADE_PERCENT * 100}% of balance, min $${MIN_SUGGESTED_TRADE_SIZE}, max $${MAX_SUGGESTED_TRADE_SIZE}): $${suggestedTradeSizeText}
Recommended range: invest roughly 10-50% of your balance per trade.

Task: Decide on ONE trade to make, or hold if nothing looks good.

Output JSON only:
{
  "action": "trade" | "hold",
  "trade": {
    "type": "prediction" | "perp",
    "market": "market_id or ticker",
    "action": "buy_yes" | "buy_no" | "open_long" | "open_short",
    "amount_in_points": 50,
    "reasoning": "Brief reason"
  }
}

IMPORTANT: "amount_in_points" is the number of Babylon Points (1 pt = $1 USD) you want to invest, NOT a share count.

If holding:
{
  "action": "hold",
  "reasoning": "Why you're holding"
}`;

    // Truncate if needed
    const estimatedTokens = countTokensSync(prompt);
    let finalPrompt = prompt;
    if (estimatedTokens > 30000) {
      const truncated = truncateToTokenLimitSync(prompt, 30000, {
        ellipsis: true,
      });
      finalPrompt = truncated.text;
    }

    // Get LLM decision
    const response = await callGroqDirect({
      prompt: finalPrompt,
      system: config?.systemPrompt ?? undefined,
      runtime: _runtime,
      temperature: 0.7,
      maxTokens: 500,
      actionType: 'trading_decision',
      purpose: 'action',
    });

    // Parse response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn(
        `[AutonomousTrading] No JSON in response`,
        { agentUserId },
        'AutonomousTrading'
      );
      return {
        tradesExecuted: 0,
        marketId: undefined,
        ticker: undefined,
        side: undefined,
        marketType: undefined,
      };
    }

    let tradeDecision: {
      action: string;
      trade?: {
        type: 'prediction' | 'perp';
        market: string;
        action: string;
        amount?: number | string;
        amount_in_points?: number | string;
        reasoning?: string;
      };
      reasoning?: string;
    };

    try {
      tradeDecision = JSON.parse(jsonMatch[0]);
    } catch {
      logger.warn(
        `[AutonomousTrading] Failed to parse JSON`,
        { agentUserId },
        'AutonomousTrading'
      );
      return {
        tradesExecuted: 0,
        marketId: undefined,
        ticker: undefined,
        side: undefined,
        marketType: undefined,
      };
    }

    // Check if holding
    if (tradeDecision.action === 'hold' || !tradeDecision.trade) {
      logger.info(
        `Agent ${agentDisplayName} decided to hold: ${tradeDecision.reasoning || 'No reason'}`,
        undefined,
        'AutonomousTrading'
      );
      return {
        tradesExecuted: 0,
        marketId: undefined,
        ticker: undefined,
        side: undefined,
        marketType: undefined,
      };
    }

    const trade = tradeDecision.trade;
    const rawAmount = trade.amount_in_points ?? trade.amount;
    const normalizedAmount =
      typeof rawAmount === 'string' ? Number(rawAmount) : rawAmount;

    if (
      typeof normalizedAmount !== 'number' ||
      Number.isNaN(normalizedAmount) ||
      normalizedAmount <= 0
    ) {
      logger.warn(
        `[AutonomousTrading] Invalid trade amount provided`,
        { agentUserId, rawAmount },
        'AutonomousTrading'
      );
      return {
        tradesExecuted: 0,
        marketId: undefined,
        ticker: undefined,
        side: undefined,
        marketType: undefined,
      };
    }

    // Map LLM decision to DirectExecutor parameters
    let marketId: string | undefined;
    let marketType: 'prediction' | 'perp' = 'prediction';
    let side: 'buy_yes' | 'buy_no' | 'open_long' | 'open_short' = 'buy_yes';

    if (trade.type === 'prediction') {
      // Find matching prediction market
      const market = predictionMarkets.find(
        (m) => m.id === trade.market || m.question.includes(trade.market)
      );
      if (!market) {
        logger.info(
          `[AutonomousTrading] Prediction market not found: ${trade.market}`,
          undefined,
          'AutonomousTrading'
        );
        return {
          tradesExecuted: 0,
          marketId: undefined,
          ticker: undefined,
          side: undefined,
          marketType: undefined,
        };
      }
      marketId = market.id;
      marketType = 'prediction';
      side = trade.action as 'buy_yes' | 'buy_no';
    } else if (trade.type === 'perp') {
      const perpIdentifier = trade.market;
      const resolvedPerp = resolvePerpTicker(perpIdentifier);

      if (!resolvedPerp) {
        logger.info(
          `[AutonomousTrading] Perp market not recognized: ${perpIdentifier}`,
          { agentUserId },
          'AutonomousTrading'
        );
        return {
          tradesExecuted: 0,
          marketId: undefined,
          ticker: undefined,
          side: undefined,
          marketType: undefined,
        };
      }

      marketId = resolvedPerp.ticker;
      marketType = 'perp';
      side = trade.action as 'open_long' | 'open_short';
    }

    if (!marketId) {
      return {
        tradesExecuted: 0,
        marketId: undefined,
        ticker: undefined,
        side: undefined,
        marketType: undefined,
      };
    }

    // Execute via DirectExecutors (handles balance validation, DB updates, etc.)
    const result = await executeDirectTrade({
      agentUserId,
      marketType,
      marketId,
      side,
      amount: normalizedAmount,
      reasoning: trade.reasoning,
      skipPerpResolution: marketType === 'perp',
    });

    if (!result.success) {
      logger.info(
        `[AutonomousTrading] Trade failed: ${result.error}`,
        { agentUserId },
        'AutonomousTrading'
      );
      return {
        tradesExecuted: 0,
        marketId: undefined,
        ticker: undefined,
        side: undefined,
        marketType: undefined,
      };
    }

    logger.info(
      `Agent ${agentDisplayName} executed ${marketType} trade: ${side} on ${marketId}`,
      undefined,
      'AutonomousTrading'
    );

    const ownerId = agent?.managedBy ?? agentUserId;
    trackAgentTradeExecuted(agentUserId, {
      agent_id: agentUserId,
      market_type: marketType,
      action: side,
      market_id: result.marketId,
      ticker: result.ticker,
      side: result.side,
      amount: normalizedAmount,
      owner_id: ownerId,
    });

    return {
      tradesExecuted: 1,
      marketId: result.marketId,
      ticker: result.ticker,
      side: result.side,
      marketType,
    };
  }
}

export const autonomousTradingService = new AutonomousTradingService();
