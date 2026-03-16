import { type IAgentRuntime, logger, ModelType, parseJSONObjectFromText } from "@elizaos/core";
import type { TokenValidationService } from "../services/TokenValidationService.ts";
import type {
  AgentState,
  PortfolioSnapshot,
  StrategyContextMarketData,
  TradeOrder,
  TradingStrategy,
} from "../types.ts";
import { OrderType, TradeType } from "../types.ts";

/**
 * Token data from Birdeye trending API
 */
interface TrendingToken {
  address: string;
  symbol: string;
  name: string;
  price: number;
  priceChange24h: number;
  volume24h: number;
  liquidity: number;
  marketCap: number;
  logoURI?: string;
}

/**
 * LLM trading decision response
 */
interface LLMTradingDecision {
  marketAssessment: string;
  pickedNothing: boolean;
  recommendBuyIndex: number | null;
  reason: string;
  opportunityScore: number;
  riskScore: number;
  buyAmountPercent: number;
  tokenStrengths: string;
  tokenWeaknesses: string;
  exitConditions: string;
  exitLiquidityThreshold: number;
  exitVolumeThreshold: number;
  currentPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  stopLossReasoning: string;
  takeProfitReasoning: string;
}

/**
 * Configuration for LLM Strategy
 */
export interface LLMStrategyConfig {
  maxBuyAmountPercent: number;
  minOpportunityScore: number;
  maxRiskScore: number;
  minLiquidity: number;
  minVolume24h: number;
  trendingTokensCount: number;
  birdeyeApiKey?: string;
}

const DEFAULT_CONFIG: LLMStrategyConfig = {
  maxBuyAmountPercent: 15,
  minOpportunityScore: 60,
  maxRiskScore: 70,
  minLiquidity: 50000,
  minVolume24h: 100000,
  trendingTokensCount: 25,
};

/**
 * LLM-based trading prompt template
 */
const TRADING_DECISION_PROMPT = `You are an expert cryptocurrency trader analyzing trending Solana tokens for trading opportunities.

TASK: Analyze the trending tokens below and decide whether to buy any of them.

RULES:
1. Only recommend a buy if you see a genuine opportunity with good risk/reward
2. Buy amount should be between 1-15% of available balance
3. Stop loss must be BELOW current price
4. Take profit must be ABOVE current price
5. Consider liquidity and volume - avoid illiquid tokens
6. It's perfectly acceptable to pick nothing if no good opportunities exist

PREVIOUS PICKS:
{{previousPicks}}

TRENDING TOKENS (Solana):
{{trendingTokens}}

CURRENT PORTFOLIO VALUE: $PORTFOLIO_VALUE_PLACEHOLDER

Respond ONLY with a JSON object in this exact format:
{
  "marketAssessment": "Brief overall market assessment without mentioning specific tokens",
  "pickedNothing": true/false,
  "recommendBuyIndex": number or null (1-based index from the trending list),
  "reason": "Detailed reasoning for your decision",
  "opportunityScore": number 0-100,
  "riskScore": number 0-100,
  "buyAmountPercent": number 1-15,
  "tokenStrengths": "Why this token is strong (if buying)",
  "tokenWeaknesses": "What's weak about this token (if buying)",
  "exitConditions": "Conditions that would trigger an exit",
  "exitLiquidityThreshold": number (minimum liquidity in USD),
  "exitVolumeThreshold": number (minimum 24h volume in USD),
  "currentPrice": number (current token price in USD),
  "stopLossPrice": number (absolute price for stop loss, must be < currentPrice),
  "takeProfitPrice": number (absolute price for take profit, must be > currentPrice),
  "stopLossReasoning": "Why this stop loss level",
  "takeProfitReasoning": "Why this take profit level"
}`;

/**
 * LLMStrategy - AI-powered trading strategy using language models
 *
 * This strategy:
 * 1. Fetches trending tokens from Birdeye
 * 2. Uses an LLM to analyze opportunities
 * 3. Validates tokens via RugCheck
 * 4. Generates buy signals with proper exit conditions
 */
export class LLMStrategy implements TradingStrategy {
  public readonly id = "llm";
  public readonly name = "LLM Trading Strategy";
  public readonly description =
    "AI-powered trading using language models to analyze trending tokens";

  private runtime: IAgentRuntime | null = null;
  private config: LLMStrategyConfig;
  private previousPicks: Array<{
    timestamp: number;
    token: string;
    reason: string;
  }> = [];
  private trendingTokensCache: TrendingToken[] = [];
  private lastTrendingFetch = 0;
  private readonly TRENDING_CACHE_TTL = 60000; // 1 minute

  constructor(config: Partial<LLMStrategyConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  public async initialize(runtime?: IAgentRuntime): Promise<void> {
    if (runtime) {
      this.runtime = runtime;

      const birdeyeKey = runtime.getSetting("BIRDEYE_API_KEY");
      if (birdeyeKey && typeof birdeyeKey === "string") {
        this.config.birdeyeApiKey = birdeyeKey;
      }

      const maxBuy = runtime.getSetting("MAX_PORTFOLIO_ALLOCATION");
      if (maxBuy) {
        this.config.maxBuyAmountPercent = Number(maxBuy) * 100;
      }

      const minLiquidity = runtime.getSetting("MIN_LIQUIDITY_USD");
      if (minLiquidity) {
        this.config.minLiquidity = Number(minLiquidity);
      }

      logger.info(
        `[${this.name}] Initialized: maxBuy=${this.config.maxBuyAmountPercent}% minOpportunity=${this.config.minOpportunityScore} maxRisk=${this.config.maxRiskScore}`,
      );
    }
  }

  public isReady(): boolean {
    return this.runtime !== null && !!this.config.birdeyeApiKey;
  }

  public configure(params: Partial<LLMStrategyConfig>): void {
    this.config = { ...this.config, ...params };
  }

  /**
   * Main decision function called by the trading loop
   */
  public async decide(params: {
    marketData: StrategyContextMarketData;
    agentState: AgentState;
    portfolioSnapshot: PortfolioSnapshot;
    agentRuntime?: IAgentRuntime;
  }): Promise<TradeOrder | null> {
    const runtime = params.agentRuntime || this.runtime;
    if (!runtime) {
      logger.warn(`[${this.name}] Runtime not available`);
      return null;
    }

    // Fetch trending tokens (pre-filtered by basic criteria)
    const trendingTokens = await this.fetchTrendingTokens(runtime);
    if (trendingTokens.length === 0) {
      logger.info(`[${this.name}] No trending tokens available`);
      return null;
    }

    // Pre-validate tokens to filter out obvious scams/honeypots BEFORE LLM analysis
    const validationService = runtime.getService("TokenValidationService") as
      | TokenValidationService
      | undefined;
    let validTokens = trendingTokens;

    if (validationService) {
      const validationResults = await Promise.all(
        trendingTokens.map(async (token) => ({
          token,
          validation: await validationService.validateToken(token.address),
        })),
      );

      validTokens = validationResults.filter((r) => r.validation.isValid).map((r) => r.token);

      const rejected = validationResults.filter((r) => !r.validation.isValid);
      if (rejected.length > 0) {
        logger.info(
          `[${this.name}] Pre-filtered ${rejected.length} tokens (honeypot/scam indicators)`,
        );
        rejected.slice(0, 3).forEach((r) => {
          logger.debug(
            `[${this.name}] Rejected ${r.token.symbol}: ${r.validation.rejectionReasons.join(", ")}`,
          );
        });
      }
    }

    if (validTokens.length === 0) {
      logger.info(`[${this.name}] All trending tokens failed safety validation`);
      return null;
    }

    // Get LLM decision from pre-validated tokens only
    const decision = await this.getLLMDecision(
      runtime,
      validTokens,
      params.portfolioSnapshot.totalValue,
    );

    if (!decision || decision.pickedNothing || decision.recommendBuyIndex === null) {
      logger.info(`[${this.name}] LLM decided not to trade:`, decision?.marketAssessment);
      return null;
    }

    // Validate the decision
    const tokenIndex = decision.recommendBuyIndex - 1;
    if (tokenIndex < 0 || tokenIndex >= validTokens.length) {
      logger.warn(`[${this.name}] Invalid token index from LLM: ${decision.recommendBuyIndex}`);
      return null;
    }

    const selectedToken = validTokens[tokenIndex];

    // Validate opportunity and risk scores
    if (decision.opportunityScore < this.config.minOpportunityScore) {
      logger.info(`[${this.name}] Opportunity score too low: ${decision.opportunityScore}`);
      return null;
    }

    if (decision.riskScore > this.config.maxRiskScore) {
      logger.info(`[${this.name}] Risk score too high: ${decision.riskScore}`);
      return null;
    }

    // Validate exit prices
    if (decision.stopLossPrice >= selectedToken.price) {
      logger.warn(`[${this.name}] Invalid stop loss price - must be below current price`);
      return null;
    }

    if (decision.takeProfitPrice <= selectedToken.price) {
      logger.warn(`[${this.name}] Invalid take profit price - must be above current price`);
      return null;
    }

    // Calculate trade amount
    const buyPercent = Math.min(decision.buyAmountPercent, this.config.maxBuyAmountPercent);
    const tradeValueUsd = params.portfolioSnapshot.totalValue * (buyPercent / 100);
    const tradeQuantity = tradeValueUsd / selectedToken.price;

    // Record this pick
    this.previousPicks.push({
      timestamp: Date.now(),
      token: selectedToken.symbol,
      reason: decision.reason,
    });

    // Keep only last 10 picks
    if (this.previousPicks.length > 10) {
      this.previousPicks = this.previousPicks.slice(-10);
    }

    logger.info(
      `[${this.name}] Generating buy signal: ${selectedToken.symbol} price=$${selectedToken.price.toFixed(6)} buyPercent=${buyPercent}% opportunity=${decision.opportunityScore} risk=${decision.riskScore}`,
    );

    return {
      pair: `${selectedToken.address}/SOL`,
      action: TradeType.BUY,
      quantity: tradeQuantity,
      orderType: OrderType.MARKET,
      price: selectedToken.price,
      timestamp: Date.now(),
      reason: `LLM Strategy: ${decision.reason} | Stop: $${decision.stopLossPrice.toFixed(6)} | Target: $${decision.takeProfitPrice.toFixed(6)}`,
    };
  }

  /**
   * Fetch trending tokens from Birdeye API
   */
  private async fetchTrendingTokens(runtime: IAgentRuntime): Promise<TrendingToken[]> {
    // Check cache
    if (
      Date.now() - this.lastTrendingFetch < this.TRENDING_CACHE_TTL &&
      this.trendingTokensCache.length > 0
    ) {
      return this.trendingTokensCache;
    }

    const settingKey = runtime.getSetting("BIRDEYE_API_KEY");
    const apiKey = this.config.birdeyeApiKey || (typeof settingKey === "string" ? settingKey : null);
    if (!apiKey) {
      logger.error(`[${this.name}] Birdeye API key not configured`);
      return [];
    }

    const response = await fetch(
      `https://public-api.birdeye.so/defi/tokenlist?sort_by=v24hUSD&sort_type=desc&offset=0&limit=${this.config.trendingTokensCount}`,
      {
        headers: {
          "X-API-KEY": apiKey,
          "x-chain": "solana",
        },
      },
    );

    if (!response.ok) {
      logger.error(`[${this.name}] Birdeye API error: ${response.status}`);
      return [];
    }

    const data = (await response.json()) as {
      success: boolean;
      data: {
        tokens: Array<{
          address: string;
          symbol: string;
          name: string;
          price: number;
          priceChange24hPercent: number;
          v24hUSD: number;
          liquidity: number;
          mc: number;
          logoURI?: string;
        }>;
      };
    };

    if (!data.success || !data.data?.tokens) {
      logger.warn(`[${this.name}] Invalid Birdeye response`);
      return [];
    }

    // Filter tokens by liquidity and volume
    const filteredTokens = data.data.tokens
      .filter(
        (t) => t.liquidity >= this.config.minLiquidity && t.v24hUSD >= this.config.minVolume24h,
      )
      .map((t) => ({
        address: t.address,
        symbol: t.symbol,
        name: t.name,
        price: t.price,
        priceChange24h: t.priceChange24hPercent,
        volume24h: t.v24hUSD,
        liquidity: t.liquidity,
        marketCap: t.mc,
        logoURI: t.logoURI,
      }));

    this.trendingTokensCache = filteredTokens;
    this.lastTrendingFetch = Date.now();

    logger.info(`[${this.name}] Fetched ${filteredTokens.length} trending tokens`);
    return filteredTokens;
  }

  /**
   * Get trading decision from LLM
   */
  private async getLLMDecision(
    runtime: IAgentRuntime,
    trendingTokens: TrendingToken[],
    portfolioValue: number,
  ): Promise<LLMTradingDecision | null> {
    // Format trending tokens for prompt
    const tokensText = trendingTokens
      .map(
        (t, i) =>
          `${i + 1}. ${t.symbol}: $${t.price.toFixed(6)} | 24h: ${t.priceChange24h.toFixed(2)}% | Vol: $${(t.volume24h / 1e6).toFixed(2)}M | Liq: $${(t.liquidity / 1e6).toFixed(2)}M | MCap: $${(t.marketCap / 1e6).toFixed(2)}M`,
      )
      .join("\n");

    // Format previous picks
    const previousPicksText =
      this.previousPicks.length > 0
        ? this.previousPicks
            .map((p) => `${new Date(p.timestamp).toISOString()}: ${p.token} - ${p.reason}`)
            .join("\n")
        : "No previous picks in this session.";

    const systemPrompt =
      "You are an expert cryptocurrency trading analyst. Respond only with valid JSON.";
    const userPrompt = TRADING_DECISION_PROMPT.replace("{{trendingTokens}}", tokensText)
      .replace("{{previousPicks}}", previousPicksText)
      .replace("PORTFOLIO_VALUE_PLACEHOLDER", portfolioValue.toFixed(2));

    const response = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: `${systemPrompt}\n\n${userPrompt}`,
    });

    if (!response) {
      logger.warn(`[${this.name}] No response from LLM`);
      return null;
    }

    const parsed = parseJSONObjectFromText(response) as Record<string, unknown> | null;
    if (!parsed) {
      logger.warn(`[${this.name}] Failed to parse LLM response`);
      return null;
    }

    // Validate and normalize the response
    const decision: LLMTradingDecision = {
      marketAssessment: String(parsed.marketAssessment || ""),
      pickedNothing: Boolean(parsed.pickedNothing),
      recommendBuyIndex:
        parsed.recommendBuyIndex !== null ? Number(parsed.recommendBuyIndex) : null,
      reason: String(parsed.reason || ""),
      opportunityScore: Number(parsed.opportunityScore || 0),
      riskScore: Number(parsed.riskScore || 100),
      buyAmountPercent: Math.min(
        Number(parsed.buyAmountPercent || 0),
        this.config.maxBuyAmountPercent,
      ),
      tokenStrengths: String(parsed.tokenStrengths || ""),
      tokenWeaknesses: String(parsed.tokenWeaknesses || ""),
      exitConditions: String(parsed.exitConditions || ""),
      exitLiquidityThreshold: Number(parsed.exitLiquidityThreshold || this.config.minLiquidity),
      exitVolumeThreshold: Number(parsed.exitVolumeThreshold || this.config.minVolume24h),
      currentPrice: Number(parsed.currentPrice || 0),
      stopLossPrice: Number(parsed.stopLossPrice || 0),
      takeProfitPrice: Number(parsed.takeProfitPrice || 0),
      stopLossReasoning: String(parsed.stopLossReasoning || ""),
      takeProfitReasoning: String(parsed.takeProfitReasoning || ""),
    };

    logger.debug(
      `[${this.name}] LLM decision: pickedNothing=${decision.pickedNothing} buyIndex=${decision.recommendBuyIndex} opportunity=${decision.opportunityScore} risk=${decision.riskScore}`,
    );

    return decision;
  }

  /**
   * Get recent picks for display
   */
  public getPreviousPicks(): Array<{
    timestamp: number;
    token: string;
    reason: string;
  }> {
    return [...this.previousPicks];
  }

  /**
   * Clear the picks history
   */
  public clearPicks(): void {
    this.previousPicks = [];
  }
}
