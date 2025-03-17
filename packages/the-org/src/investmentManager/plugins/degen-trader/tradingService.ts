// Combined DegenTradingService that integrates all functionality

import {
  type IAgentRuntime,
  ModelType,
  Service,
  type Task,
  type UUID,
  composePrompt,
  logger,
  parseJSONObjectFromText,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { REQUIRED_SETTINGS } from './config/config';
import {
  type BuySignalMessage,
  type PriceSignalMessage,
  type SellSignalMessage,
  ServiceType,
} from './types';
import { tradeAnalysisTemplate } from './utils/analyzeTrade';
import { executeTrade, getTokenBalance, getWalletBalance } from './utils/wallet';

/**
 * Interface representing a token signal object.
 * @typedef {Object} TokenSignal
 * @property {string} address - The address of the token.
 * @property {string} symbol - The symbol of the token.
 * @property {number} marketCap - The market capitalization of the token.
 * @property {number} volume24h - The 24-hour trading volume of the token.
 * @property {number} price - The current price of the token.
 * @property {number} liquidity - The liquidity of the token.
 * @property {number} score - The overall score of the token.
 * @property {string[]} reasons - The reasons for the signal.
 * @property {Object} [technicalSignals] - Optional technical signals object.
 * @property {number} technicalSignals.rsi - The Relative Strength Index (RSI) value.
 * @property {Object} technicalSignals.macd - The Moving Average Convergence Divergence (MACD) values.
 * @property {number} technicalSignals.macd.value - The MACD value.
 * @property {number} technicalSignals.macd.signal - The MACD signal line value.
 * @property {number} technicalSignals.macd.histogram - The MACD histogram value.
 * @property {Object} technicalSignals.volumeProfile - The volume profile information.
 * @property {("increasing"|"decreasing"|"stable")} technicalSignals.volumeProfile.trend - The trend of the volume profile.
 * @property {boolean} technicalSignals.volumeProfile.unusualActivity - Indicates if there is unusual volume activity.
 * @property {number} technicalSignals.volatility - The volatility of the token.
 * @property {Object} [socialMetrics] - Optional social metrics object.
 * @property {number} socialMetrics.mentionCount - The number of mentions on social media.
 * @property {number} socialMetrics.sentiment - The sentiment score of the token.
 * @property {number} socialMetrics.influencerMentions - The number of influencer mentions.
 * @property {Object} [cmcMetrics] - Optional CoinMarketCap (CMC) metrics object.
 * @property {number} cmcMetrics.rank - The rank of the token on CoinMarketCap.
 * @property {number} cmcMetrics.priceChange24h - The price change in the last 24 hours.
 * @property {number} cmcMetrics.volumeChange24h - The volume change in the last 24 hours.
 */

interface TokenSignal {
  address: string;
  symbol: string;
  marketCap: number;
  volume24h: number;
  price: number;
  liquidity: number;
  score: number;
  reasons: string[];
  technicalSignals?: {
    rsi: number;
    macd: {
      value: number;
      signal: number;
      histogram: number;
    };
    volumeProfile: {
      trend: 'increasing' | 'decreasing' | 'stable';
      unusualActivity: boolean;
    };
    volatility: number;
  };
  socialMetrics?: {
    mentionCount: number;
    sentiment: number;
    influencerMentions: number;
  };
  cmcMetrics?: {
    rank: number;
    priceChange24h: number;
    volumeChange24h: number;
  };
}

/**
 * Interface representing risk limits for a trading strategy.
 *
 * @typedef {object} RiskLimits
 * @property {number} maxPositionSize - The maximum allowable position size.
 * @property {number} maxDrawdown - The maximum acceptable drawdown.
 * @property {number} stopLossPercentage - The percentage at which to trigger a stop loss.
 * @property {number} takeProfitPercentage - The percentage at which to trigger a take profit.
 */
interface RiskLimits {
  maxPositionSize: number;
  maxDrawdown: number;
  stopLossPercentage: number;
  takeProfitPercentage: number;
}

/**
 * Interface for trading configuration settings.
 * @typedef {Object} TradingConfig
 * @property {Object} intervals - Time intervals for various trading operations
 * @property {number} intervals.priceCheck - Interval for price checking
 * @property {number} intervals.walletSync - Interval for wallet synchronization
 * @property {number} intervals.performanceMonitor - Interval for performance monitoring
 * @property {Object} thresholds - Threshold values for trading parameters
 * @property {number} thresholds.minLiquidity - Minimum liquidity threshold
 * @property {number} thresholds.minVolume - Minimum volume threshold
 * @property {number} thresholds.minScore - Minimum score threshold
 * @property {RiskLimits} riskLimits - Risk limits configuration
 * @property {Object} slippageSettings - Settings for slippage control
 * @property {number} slippageSettings.baseSlippage - Base slippage percentage
 * @property {number} slippageSettings.maxSlippage - Maximum allowed slippage percentage
 * @property {number} slippageSettings.liquidityMultiplier - Multiplier for liquidity-based adjustment
 * @property {number} slippageSettings.volumeMultiplier - Multiplier for volume-based adjustment
 */
interface TradingConfig {
  intervals: {
    priceCheck: number;
    walletSync: number;
    performanceMonitor: number;
  };
  thresholds: {
    minLiquidity: number;
    minVolume: number;
    minScore: number;
  };
  riskLimits: RiskLimits;
  slippageSettings: {
    baseSlippage: number; // Base slippage in percentage (e.g., 0.5 for 0.5%)
    maxSlippage: number; // Maximum slippage allowed in percentage
    liquidityMultiplier: number; // Multiplier for liquidity-based adjustment
    volumeMultiplier: number; // Multiplier for volume-based adjustment
  };
}

/**
 * Represents an entry in a cache.
 * @template T
 * @property { T } value - The value stored in the cache entry.
 * @property { number } timestamp - The timestamp when the entry was created.
 * @property { number } expiry - The expiry timestamp for the entry.
 */
interface CacheEntry<T> {
  value: T;
  timestamp: number;
  expiry: number;
}

/**
 * Interface representing the status of a portfolio.
 * @property {number} totalValue - The total value of the portfolio.
 * @property {Object.<string, { amount: number; value: number }>} positions - The positions in the portfolio, with token addresses as keys and amount and value as values.
 * @property {number} solBalance - The balance of Solana token in the portfolio.
 * @property {number} drawdown - The drawdown percentage of the portfolio.
 */
interface PortfolioStatus {
  totalValue: number;
  positions: { [tokenAddress: string]: { amount: number; value: number } };
  solBalance: number;
  drawdown: number;
}

/**
 * Class representing a service for Degen Trading.
 */
export class DegenTradingService extends Service {
  private isRunning = false;
  private processId: string;

  // For tracking pending sells
  private pendingSells: { [tokenAddress: string]: bigint } = {};

  static serviceType = ServiceType.DEGEN_TRADING;
  capabilityDescription = 'The agent is able to trade on the Solana blockchain';

  private tradingConfig: TradingConfig = {
    intervals: {
      priceCheck: 60000, // 1 minute
      walletSync: 600000, // 10 minutes
      performanceMonitor: 3600000, // 1 hour
    },
    thresholds: {
      minLiquidity: 50000, // $50k minimum liquidity
      minVolume: 100000, // $100k minimum 24h volume
      minScore: 60, // Minimum token score
    },
    riskLimits: {
      maxPositionSize: 0.2,
      maxDrawdown: 0.1,
      stopLossPercentage: 0.05,
      takeProfitPercentage: 0.2,
    },
    slippageSettings: {
      baseSlippage: 0.5, // Base slippage in percentage (e.g., 0.5 for 0.5%)
      maxSlippage: 1.0, // Maximum slippage allowed in percentage
      liquidityMultiplier: 1.0, // Multiplier for liquidity-based adjustment
      volumeMultiplier: 1.0, // Multiplier for volume-based adjustment
    },
  };

  /**
   * Constructor for SolProcess class.
   *
   * @param {IAgentRuntime} runtime - The runtime object for the agent.
   */
  constructor(protected runtime: IAgentRuntime) {
    super(runtime);
    this.processId = `sol-process-${Date.now()}`;
  }

  /**
   * Starts the DegenTradingService with the provided IAgentRuntime.
   *
   * @param {IAgentRuntime} runtime - The runtime object required for degen trader plugin initialization.
   * @returns {Promise<DegenTradingService>} - A promise that resolves with the initialized DegenTradingService.
   * @throws {Error} - If the runtime is not provided or if any required settings are missing.
   */
  static async start(runtime: IAgentRuntime): Promise<DegenTradingService> {
    if (!runtime) {
      throw new Error('Runtime is required for degen trader plugin initialization');
    }
    const service = new DegenTradingService(runtime);

    // Validate settings first
    const missingSettings = Object.entries(REQUIRED_SETTINGS)
      .filter(([key]) => !runtime.getSetting(key))
      .map(([key, desc]) => `${key} (${desc})`);

    if (missingSettings.length > 0) {
      const errorMsg = `Missing required settings: ${missingSettings.join(', ')}`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    try {
      await service.start();
      logger.debug('Trading service initialized successfully', {
        processId: service.processId,
      });
    } catch (error) {
      logger.error('Failed to initialize trading service:', error);
      throw error;
    }

    return service;
  }

  /**
   * Method to stop the specified DEGEN_TRADING service of the given agent runtime.
   *
   * @param {IAgentRuntime} runtime - The agent runtime to work with.
   * @returns {Promise<void>} - A Promise that resolves when the service is successfully stopped.
   */
  static async stop(runtime: IAgentRuntime) {
    const service = runtime.getService(ServiceType.DEGEN_TRADING);
    if (service) {
      await service.stop();
    }
  }

  //
  // DATA LAYER FUNCTIONALITY
  //

  /**
   * Gets token recommendation based on multiple data sources
   */
  /**
   * Asynchronously gets token recommendations based on signals from multiple sources.
   * @returns {Promise<{
   *     recommended_buy: string;
   *     recommend_buy_address: string;
   *     reason: string;
   *     marketcap: number;
   *     buy_amount: number;
   * }>} Object containing recommended token purchase details.
   */
  async getTokenRecommendation(): Promise<{
    recommended_buy: string;
    recommend_buy_address: string;
    reason: string;
    marketcap: number;
    buy_amount: number;
  }> {
    try {
      logger.info('Getting token recommendations from multiple sources');

      // Get signals from different sources
      const [birdeyeSignals, twitterSignals, cmcSignals] = await Promise.all([
        this.getBirdeyeSignals(),
        this.getTwitterSignals(),
        this.getCMCSignals(),
      ]);

      // Combine and score signals
      const scoredTokens = await this.scoreTokenSignals([
        ...birdeyeSignals,
        ...twitterSignals,
        ...cmcSignals,
      ]);

      if (scoredTokens.length === 0) {
        logger.warn('No suitable tokens found, defaulting to SOL');
        return {
          recommended_buy: 'SOL',
          recommend_buy_address: 'So11111111111111111111111111111111111111112',
          reason: 'Fallback to SOL - no other tokens met criteria',
          marketcap: 0,
          buy_amount: 0.1,
        };
      }

      // Get the highest scored token
      const bestToken = scoredTokens[0];

      // Validate token before recommending
      const validation = await this.validateTokenForTrading(bestToken.address);
      if (!validation.isValid) {
        logger.warn('Best token failed validation', validation);
        return this.getDefaultRecommendation();
      }

      return {
        recommended_buy: bestToken.symbol,
        recommend_buy_address: bestToken.address,
        reason: bestToken.reasons.join(', '),
        marketcap: bestToken.marketCap,
        buy_amount: await this.calculateOptimalBuyAmount(bestToken),
      };
    } catch (error) {
      logger.error('Failed to get token recommendation:', error);
      return this.getDefaultRecommendation();
    }
  }

  /**
   * Get signals from Birdeye
   */
  private async getBirdeyeSignals(): Promise<TokenSignal[]> {
    try {
      // Get trending tokens from cache (updated by degen-intel service)
      const trendingTokens = (await this.runtime.getCache<any[]>('birdeye_trending_tokens')) || [];

      return Promise.all(
        trendingTokens.map(async (token) => {
          const marketData = await this.getTokenMarketData(token.address);
          return {
            address: token.address,
            symbol: token.symbol,
            marketCap: marketData.marketCap,
            volume24h: marketData.volume24h,
            price: marketData.price,
            liquidity: marketData.liquidity,
            score: 0, // Will be calculated later
            reasons: [`Trending on Birdeye with ${marketData.volume24h}$ 24h volume`],
            technicalSignals: await this.calculateTechnicalSignals(marketData),
          };
        })
      );
    } catch (error) {
      logger.error('Error getting Birdeye signals:', error);
      return [];
    }
  }

  /**
   * Get signals from Twitter analysis
   */
  private async getTwitterSignals(): Promise<TokenSignal[]> {
    try {
      // Get parsed Twitter signals from cache (updated by degen-intel service)
      const twitterSignals = (await this.runtime.getCache<any[]>('twitter_parsed_signals')) || [];

      return twitterSignals.map((signal) => ({
        address: signal.tokenAddress,
        symbol: signal.symbol,
        marketCap: signal.marketCap,
        volume24h: signal.volume24h,
        price: signal.price,
        liquidity: signal.liquidity,
        score: 0,
        reasons: [`High social activity: ${signal.mentionCount} mentions`],
        socialMetrics: {
          mentionCount: signal.mentionCount,
          sentiment: signal.sentiment,
          influencerMentions: signal.influencerMentions,
        },
      }));
    } catch (error) {
      logger.error('Error getting Twitter signals:', error);
      return [];
    }
  }

  /**
   * Get signals from CoinMarketCap
   */
  private async getCMCSignals(): Promise<TokenSignal[]> {
    try {
      // Get CMC data from cache (updated by degen-intel service)
      const cmcTokens = (await this.runtime.getCache<any[]>('cmc_trending_tokens')) || [];

      return cmcTokens.map((token) => ({
        address: token.address,
        symbol: token.symbol,
        marketCap: token.marketCap,
        volume24h: token.volume24h,
        price: token.price,
        liquidity: token.liquidity,
        score: 0,
        reasons: [`Trending on CMC: ${token.cmcRank} rank`],
        cmcMetrics: {
          rank: token.cmcRank,
          priceChange24h: token.priceChange24h,
          volumeChange24h: token.volumeChange24h,
        },
      }));
    } catch (error) {
      logger.error('Error getting CMC signals:', error);
      return [];
    }
  }

  /**
   * Score and rank token signals
   */
  private async scoreTokenSignals(signals: TokenSignal[]): Promise<TokenSignal[]> {
    // Group signals by token address
    const tokenMap = new Map<string, TokenSignal>();

    for (const signal of signals) {
      if (tokenMap.has(signal.address)) {
        const existing = tokenMap.get(signal.address)!;
        existing.reasons.push(...signal.reasons);
        existing.score += signal.score;
        // Merge other metrics...
      } else {
        tokenMap.set(signal.address, signal);
      }
    }

    // Score each token
    const scoredTokens = Array.from(tokenMap.values()).map((token) => {
      let score = 0;

      // Technical Analysis Score (0-40)
      if (token.technicalSignals) {
        score += this.scoreTechnicalSignals(token.technicalSignals);
      }

      // Social Signal Score (0-30)
      if (token.socialMetrics) {
        score += this.scoreSocialMetrics(token.socialMetrics);
      }

      // Market Metrics Score (0-30)
      score += this.scoreMarketMetrics({
        marketCap: token.marketCap,
        volume24h: token.volume24h,
        liquidity: token.liquidity,
      });

      token.score = score;
      return token;
    });

    // Sort by score and filter minimum requirements
    return scoredTokens
      .filter(
        (token) =>
          token.score >= 60 && // Minimum score requirement
          token.liquidity >= 50000 && // Minimum liquidity $50k
          token.volume24h >= 100000 // Minimum 24h volume $100k
      )
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Validate token for trading
   */
  private async validateTokenForTrading(tokenAddress: string): Promise<{
    isValid: boolean;
    reason?: string;
  }> {
    try {
      // Get token market data
      const marketData = await this.getTokenMarketData(tokenAddress);

      // Check if token has sufficient liquidity
      if (marketData.liquidity < this.tradingConfig.thresholds.minLiquidity) {
        return {
          isValid: false,
          reason: `Insufficient liquidity: ${marketData.liquidity} < ${this.tradingConfig.thresholds.minLiquidity}`,
        };
      }

      // Check if token has sufficient volume
      if (marketData.volume24h < this.tradingConfig.thresholds.minVolume) {
        return {
          isValid: false,
          reason: `Insufficient 24h volume: ${marketData.volume24h} < ${this.tradingConfig.thresholds.minVolume}`,
        };
      }

      // Fetch token metadata from blockchain
      const tokenMetadata = await this.fetchTokenMetadata(tokenAddress);

      // Check if token is verified
      if (!tokenMetadata.verified) {
        return {
          isValid: false,
          reason: 'Token is not verified',
        };
      }

      // Check for suspicious token attributes
      if (tokenMetadata.suspiciousAttributes.length > 0) {
        return {
          isValid: false,
          reason: `Token has suspicious attributes: ${tokenMetadata.suspiciousAttributes.join(
            ', '
          )}`,
        };
      }

      // Check token ownership concentration
      if (tokenMetadata.ownershipConcentration > 50) {
        return {
          isValid: false,
          reason: `High ownership concentration: ${tokenMetadata.ownershipConcentration}%`,
        };
      }

      return { isValid: true };
    } catch (error) {
      logger.error('Error validating token for trading:', error);
      return {
        isValid: false,
        reason: `Validation error: ${error.message}`,
      };
    }
  }

  private async fetchTokenMetadata(tokenAddress: string): Promise<{
    verified: boolean;
    suspiciousAttributes: string[];
    ownershipConcentration: number;
  }> {
    try {
      // Try to get from cache first
      const cacheKey = `token_metadata_${tokenAddress}`;
      const cached = await this.runtime.getCache<any>(cacheKey);
      if (cached) return cached;

      // In a real implementation, this would call the blockchain API
      // For now, we'll implement a basic check using Birdeye API

      const apiKey = process.env.BIRDEYE_API_KEY;
      if (!apiKey) {
        throw new Error('Birdeye API key not found');
      }

      // Fetch token info
      const response = await fetch(`https://api.birdeye.so/v1/token/info?address=${tokenAddress}`, {
        headers: {
          'X-API-KEY': apiKey,
        },
      });

      if (!response.ok) {
        throw new Error(`Birdeye API error: ${response.status}`);
      }

      const data = await response.json();
      if (!data.success) {
        throw new Error(`Birdeye API error: ${data.message || 'Unknown error'}`);
      }

      // Extract relevant data
      const tokenInfo = data.data;
      const suspiciousAttributes: string[] = [];

      // Check for suspicious attributes
      if (tokenInfo.totalSupply > 1_000_000_000_000_000) {
        suspiciousAttributes.push('Extremely high total supply');
      }

      if (tokenInfo.decimals > 18) {
        suspiciousAttributes.push('Unusual decimal places');
      }

      // In a real implementation, we would check contract code for honeypots, etc.
      // For now, we'll use a placeholder
      const ownershipConcentration = Math.random() * 100; // Placeholder
      const verified = tokenInfo.verified || false;

      const result = {
        verified,
        suspiciousAttributes,
        ownershipConcentration,
      };

      // Cache the result
      await this.runtime.setCache(cacheKey, result); // TODO: 5 minute TTL
      return result;
    } catch (error) {
      logger.error('Error fetching token metadata:', error);
      // Return default values if API fails
      return {
        verified: false,
        suspiciousAttributes: ['Unable to verify token'],
        ownershipConcentration: 100,
      };
    }
  }

  /**
   * Calculate optimal buy amount for a token
   */
  private async calculateOptimalBuyAmount(token: TokenSignal): Promise<number> {
    try {
      // Get wallet balance
      const walletBalance = await getWalletBalance(this.runtime);

      // Get portfolio status to check current exposure
      const portfolio = await this.getPortfolioStatus();

      // Calculate available capital based on max drawdown limit
      const availableCapital =
        walletBalance * (1 - portfolio.drawdown / this.tradingConfig.riskLimits.maxDrawdown);

      // Skip if we're already at max drawdown
      if (availableCapital <= 0) {
        logger.warn('Max drawdown reached, skipping trade', {
          drawdown: portfolio.drawdown,
          maxDrawdown: this.tradingConfig.riskLimits.maxDrawdown,
        });
        return 0;
      }

      // Base percentage based on score and max position size limit
      const basePercentage = Math.min(
        token.score / 200, // 0.3 to 0.5 for scores 60-100
        this.tradingConfig.riskLimits.maxPositionSize
      );

      // Apply volatility adjustment
      let adjustedPercentage = basePercentage;
      if (token.technicalSignals?.volatility) {
        // Reduce position size for higher volatility
        const volatilityFactor = Math.max(0.5, 1 - token.technicalSignals.volatility);
        adjustedPercentage *= volatilityFactor;
      }

      // Apply market condition adjustment
      const marketCondition = await this.assessMarketCondition();
      if (marketCondition === 'bearish') {
        adjustedPercentage *= 0.5; // Reduce position size in bearish market
      }

      // Calculate raw position size
      const rawPositionSize = availableCapital * adjustedPercentage;

      // Adjust for liquidity to prevent excessive slippage
      const maxLiquidityImpact = token.liquidity * 0.02; // Max 2% liquidity impact

      // Ensure minimum trade size
      const minTradeSize = 0.05; // Minimum 0.05 SOL

      // Return the final trade amount
      return Math.max(minTradeSize, Math.min(rawPositionSize, maxLiquidityImpact));
    } catch (error) {
      logger.error('Error calculating optimal buy amount:', error);
      return 0; // Default to no trade on error
    }
  }

  /**
   * Assess overall market condition
   * @returns 'bullish', 'neutral', or 'bearish'
   */
  private async assessMarketCondition(): Promise<'bullish' | 'neutral' | 'bearish'> {
    try {
      // Get SOL price data as proxy for overall market condition
      const solData = await this.getTokenMarketData('So11111111111111111111111111111111111111112');

      if (!solData.priceHistory || solData.priceHistory.length < 24) {
        return 'neutral'; // Default to neutral if not enough data
      }

      // Calculate 24h price change
      const currentPrice = solData.price;
      const previousPrice = solData.priceHistory[0];
      const priceChange = ((currentPrice - previousPrice) / previousPrice) * 100;

      // Calculate RSI
      const rsi = this.calculateRSI(solData.priceHistory, 14);

      // Determine market condition
      if (priceChange > 5 && rsi < 70) {
        return 'bullish';
      }
      if (priceChange < -5 || rsi > 70) {
        return 'bearish';
      }
      return 'neutral';
    } catch (error) {
      logger.error('Error assessing market condition:', error);
      return 'neutral'; // Default to neutral on error
    }
  }

  /**
   * Get default recommendation (SOL)
   */
  private getDefaultRecommendation() {
    return {
      recommended_buy: 'SOL',
      recommend_buy_address: 'So11111111111111111111111111111111111111112',
      reason: 'Fallback to SOL - using default recommendation',
      marketcap: 0,
      buy_amount: 0.1,
    };
  }

  //
  // PRICE SERVICE FUNCTIONALITY
  //

  /**
   * Handles price update signals
   */
  async handlePriceSignal(signal: PriceSignalMessage): Promise<void> {
    logger.info('Price update received:', {
      token: signal.tokenAddress,
      initialPrice: signal.initialPrice,
      currentPrice: signal.currentPrice,
      priceChange: `${signal.priceChange}%`,
    });

    // Store price update in cache or state if needed
    await this.runtime.setCache<any>(`price:${signal.tokenAddress}`, {
      initialPrice: signal.initialPrice,
      currentPrice: signal.currentPrice,
      priceChange: signal.priceChange,
      timestamp: new Date().toISOString(),
    });
  }

  //
  // BUY SERVICE FUNCTIONALITY
  //

  /**
   * Analyzes the optimal trading amount
   */
  private async analyzeTradingAmount({
    walletBalance,
    tokenAddress,
    defaultPercentage = 0.1,
  }: {
    walletBalance: number;
    tokenAddress: string;
    defaultPercentage?: number;
  }): Promise<number> {
    try {
      // Log input parameters
      logger.info('Starting trade analysis with:', {
        walletBalance,
        tokenAddress,
        defaultPercentage,
      });

      // Fetch token recommendation
      const tokenRecommendation = await this.getTokenRecommendation();

      const prompt = composePrompt({
        template: tradeAnalysisTemplate,
        state: {
          bio: '',
          lore: '',
          messageDirections: '',
          postDirections: '',
          replyDirections: '',
          systemDirections: '',
          userDirections: '',
          roomId: `trade-0000-0000-0000-${Date.now().toString(16)}`,
          entities: JSON.stringify(['trader']),
          recentMessages: JSON.stringify(['']),
          walletBalance: walletBalance.toString(),
          api_data: JSON.stringify(
            {
              // Format the API data nicely
              recommended_buy: tokenRecommendation.recommended_buy,
              recommend_buy_address: tokenRecommendation.recommend_buy_address,
              reason: tokenRecommendation.reason,
              buy_amount: tokenRecommendation.buy_amount,
              marketcap: tokenRecommendation.marketcap,
            },
            null,
            2
          ),
        },
      });

      // Log context
      logger.info('Generated prompt:', { prompt });

      // Generate analysis
      const content = await this.runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
      });

      // Log generated content
      logger.info('Generated analysis content:', { content });

      if (!content) {
        logger.warn('No analysis generated, using default percentage');
        return walletBalance * defaultPercentage;
      }

      // Log parsed recommendation
      const recommendation = parseJSONObjectFromText(content);
      logger.info('Parsed recommendation:', { recommendation });

      const suggestedAmount = recommendation.suggestedAmount || walletBalance * defaultPercentage;
      logger.info('Final suggested amount:', { suggestedAmount });

      return Math.min(suggestedAmount, walletBalance);
    } catch (error) {
      logger.error('Trade analysis failed:', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      return walletBalance * defaultPercentage;
    }
  }

  /**
   * Handles buy signal processing
   */
  async handleBuySignal(signal: BuySignalMessage): Promise<{
    success: boolean;
    signature?: string;
    error?: string;
    outAmount?: string;
    swapUsdValue?: string;
    entityId?: string;
  }> {
    logger.info('Processing buy signal:', signal);

    const TRADER_KUMA = this.runtime.getSetting('TRADER_KUMA');
    if (TRADER_KUMA) {
      fetch(TRADER_KUMA).catch((e) => {
        console.error('TRADER_KUMA err', e);
      });
    }

    try {
      // Get current wallet balance
      const walletBalance = await getWalletBalance(this.runtime);
      logger.info('Current wallet balance:', { walletBalance });

      // Analyze and determine trade amount based on wallet balance
      const tradeAmount = await this.analyzeTradingAmount({
        walletBalance,
        tokenAddress: signal.tokenAddress,
        defaultPercentage: 0.1,
      });

      // Add retry logic for quote
      let quoteData;
      const maxRetries = 3;
      for (let i = 0; i < maxRetries; i++) {
        try {
          // Calculate dynamic slippage based on token metrics and trade size
          const slippageBps = this.calculateDynamicSlippage(signal.tokenAddress, tradeAmount);

          logger.info(`Attempting to get quote (attempt ${i + 1}):`, {
            inputMint: 'So11111111111111111111111111111111111111112',
            outputMint: signal.tokenAddress,
            amount: tradeAmount * 1e9,
            slippageBps,
            dynamicSlippageApplied: true,
          });

          const quoteResponse = await fetch(
            `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${
              signal.tokenAddress
            }&amount=${Math.round(tradeAmount * 1e9)}&slippageBps=${slippageBps}`
          );

          if (!quoteResponse.ok) {
            const errorText = await quoteResponse.text();
            logger.error('Quote API error response:', {
              status: quoteResponse.status,
              statusText: quoteResponse.statusText,
            });
            throw new Error(`Quote API returned ${quoteResponse.status}: ${errorText}`);
          }

          quoteData = await quoteResponse.json();
          logger.info('Raw quote response:', quoteData);

          if (!quoteData.outAmount || !quoteData.routePlan) {
            throw new Error(`Invalid quote response: ${JSON.stringify(quoteData)}`);
          }

          logger.info('Quote received successfully:', quoteData);
          break;
        } catch (error) {
          logger.error(`Quote attempt ${i + 1} failed:`, {
            error: error instanceof Error ? error.message : error,
            stack: error instanceof Error ? error.stack : undefined,
          });
          if (i === maxRetries - 1) {
            throw new Error(
              `Failed to get quote after ${maxRetries} attempts: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
          // Wait before retry (exponential backoff)
          await new Promise((resolve) => setTimeout(resolve, 2 ** i * 1000));
        }
      }

      // Execute the trade
      const tradeResult = await executeTrade(this.runtime, {
        tokenAddress: signal.tokenAddress,
        amount: tradeAmount,
        slippage: Number(this.calculateDynamicSlippage(signal.tokenAddress, tradeAmount)) / 10000, // Convert basis points to decimal
        dex: 'jupiter',
        action: 'BUY',
      });

      // Define an extended type that includes the additional properties we need
      type ExtendedTradeResult = {
        success: boolean;
        signature?: string;
        error?: string;
        outAmount?: string;
        swapUsdValue?: string;
      };

      // Cast the result to our extended type
      const extendedResult = tradeResult as ExtendedTradeResult;

      if (extendedResult.success && extendedResult.signature) {
        logger.info('Buy successful', {
          signature: extendedResult.signature,
          outAmount: extendedResult.outAmount || 'unknown',
        });

        // Track this trade for position management
        if (extendedResult.outAmount) {
          await this.trackPosition({
            positionId: signal.positionId,
            tokenAddress: signal.tokenAddress,
            buyAmount: tradeAmount,
            tokenAmount: extendedResult.outAmount,
            buySignature: extendedResult.signature,
            buyTimestamp: Date.now(),
          });
        }

        return {
          success: true,
          signature: extendedResult.signature,
          outAmount: extendedResult.outAmount,
          swapUsdValue: extendedResult.swapUsdValue,
          entityId: signal.entityId,
        };
      }
      logger.error('Buy failed', {
        error: extendedResult.error,
      });
      return {
        success: false,
        error: extendedResult.error,
      };
    } catch (error) {
      logger.error('Failed to process buy signal:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Execute sell task
   */
  private async executeSellTask(options: any) {
    try {
      logger.info('Execute sell task', options);

      const { signal } = options;

      if (!signal) {
        logger.error('No signal data in sell task');
        return { success: false, error: 'Missing signal data' };
      }

      // Validate amounts before executing sell
      if (!signal.amount || Number(signal.amount) <= 0) {
        logger.warn('Invalid sell amount:', {
          amount: signal.amount,
          currentBalance: signal.currentBalance,
        });
        return { success: false, error: 'Invalid sell amount' };
      }

      // Verify we have enough balance
      if (signal.currentBalance && Number(signal.amount) > Number(signal.currentBalance)) {
        logger.warn('Insufficient balance for sell:', {
          sellAmount: signal.amount,
          currentBalance: signal.currentBalance,
        });
        return { success: false, error: 'Insufficient balance' };
      }

      const result = await this.handleSellSignal(signal);

      if (result.success) {
        // Log the success
        logger.info('Sell successful', {
          signature: result.signature,
          receivedAmount: result.receivedAmount,
        });

        // Track slippage impact if we have expected and actual amounts
        if (result.receivedAmount && options.expectedReceiveAmount) {
          await this.trackSlippageImpact(
            signal.tokenAddress,
            options.expectedReceiveAmount,
            result.receivedAmount,
            options.slippageBps || 0,
            true // is a sell
          );
        }
      } else {
        logger.error('Sell failed', {
          error: result.error,
        });
      }

      return result;
    } catch (error) {
      logger.error('Error executing sell task', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Syncs wallet information
   */
  private async syncWallet() {
    try {
      logger.info('Syncing wallet information');
      const walletBalance = await getWalletBalance(this.runtime);
      logger.info('Wallet balance synced', { balance: walletBalance });

      // Store wallet balance in cache
      await this.runtime.setCache<any>('wallet_balance', {
        balance: walletBalance,
        timestamp: new Date().toISOString(),
      });

      return { success: true };
    } catch (error) {
      logger.error('Failed to sync wallet:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Registers tasks with the runtime
   */
  async registerTasks() {
    // Register BUY_SIGNAL task worker
    this.runtime.registerTaskWorker({
      name: 'BUY_SIGNAL',
      execute: async (_runtime: IAgentRuntime, _options: any, task: Task) => {
        logger.debug('*** BUY_SIGNAL ***');
        try {
          await this.executeBuyTask();
        } catch (error) {
          logger.error('Failed to execute buy task', error);
          logger.warn('BUY_SIGNAL task has been cancelled');
          await _runtime.deleteTask(task.id);
        }
      },
      validate: async () => true,
    });

    // Register EXECUTE_BUY_SIGNAL task worker
    this.runtime.registerTaskWorker({
      name: 'EXECUTE_BUY_SIGNAL',
      execute: async (_runtime: IAgentRuntime, options: any, task: Task) => {
        logger.info('*** EXECUTE_BUY_SIGNAL ***', options);

        const { signal, tradeAmount, reason } = options.metadata || {};

        if (!signal || !signal.tokenAddress) {
          logger.error('Invalid buy signal data', { options });
          return;
        }

        logger.info('Executing buy signal', {
          token: signal.tokenAddress,
          tradeAmount,
          reason,
        });

        const result = await this.handleBuySignal(signal);

        if (result.success) {
          logger.info('Buy successful', {
            signature: result.signature,
            outAmount: result.outAmount,
            swapUsdValue: result.swapUsdValue,
          });
        } else {
          logger.error('Buy failed', { error: result.error });
          await _runtime.deleteTask(task.id);
        }
      },
      validate: async () => true,
    });

    // Register SELL_SIGNAL task worker
    this.runtime.registerTaskWorker({
      name: 'SELL_SIGNAL',
      execute: async (_runtime: IAgentRuntime, options: any, task: Task) => {
        logger.info('*** SELL_SIGNAL ***');
        try {
          await this.executeSellTask(options);
        } catch (error) {
          logger.error('Failed to execute sell task', error);
          logger.warn('SELL_SIGNAL task has been cancelled');
          await _runtime.deleteTask(task.id);
        }
      },
      validate: async () => true,
    });

    // Register MONITOR_TOKEN task worker
    this.runtime.registerTaskWorker({
      name: 'MONITOR_TOKEN',
      execute: async (_runtime: IAgentRuntime, options: any, task: Task) => {
        logger.info('*** MONITOR_TOKEN ***');
        try {
          await this.monitorToken(options);
        } catch (error) {
          logger.error('Failed to monitor token', error);
          logger.warn('MONITOR_TOKEN task has been cancelled');
          await _runtime.deleteTask(task.id);
        }
      },
      validate: async () => true,
    });

    // Register MONITOR_TRAILING_STOP task worker
    this.runtime.registerTaskWorker({
      name: 'MONITOR_TRAILING_STOP',
      execute: async (_runtime: IAgentRuntime, options: any, task: Task) => {
        logger.debug('*** MONITOR_TRAILING_STOP ***');
        try {
          await this.monitorTrailingStop(options);
        } catch (error) {
          logger.error('Failed to monitor trailing stop', error);
          logger.warn('MONITOR_TRAILING_STOP task has been cancelled');
          await _runtime.deleteTask(task.id);
        }
      },
      validate: async () => true,
    });

    // Register VALIDATE_DATA_SOURCES task worker
    this.runtime.registerTaskWorker({
      name: 'VALIDATE_DATA_SOURCES',
      execute: async (_runtime: IAgentRuntime, _options, task: Task) => {
        logger.debug('*** VALIDATE_DATA_SOURCES ***');
        try {
          await this.validateDataSources();
        } catch (error) {
          logger.error('Failed to validate data sources', error);
          logger.warn('VALIDATE_DATA_SOURCES task has been cancelled');
          await _runtime.deleteTask(task.id);
        }
      },
      validate: async () => true,
    });

    // Register CIRCUIT_BREAKER_CHECK task worker
    this.runtime.registerTaskWorker({
      name: 'CIRCUIT_BREAKER_CHECK',
      execute: async (_runtime: IAgentRuntime, _options, task: Task) => {
        logger.debug('*** CIRCUIT_BREAKER_CHECK ***');
        try {
          await this.checkCircuitBreaker();
        } catch (error) {
          logger.error('Failed to check circuit breaker', error);
          logger.warn('CIRCUIT_BREAKER_CHECK task has been cancelled');
          await _runtime.deleteTask(task.id);
        }
      },
      validate: async () => true,
    });
  }

  /**
   * Creates scheduled tasks
   */
  private async createScheduledTasks() {
    logger.info('Creating scheduled tasks...');

    const tasks = await this.runtime.getTasks({
      tags: ['queue', 'repeat', ServiceType.DEGEN_TRADING],
    });

    if (!tasks.find((task) => task.name === 'BUY_SIGNAL')) {
      await this.runtime.createTask({
        id: uuidv4() as UUID,
        roomId: this.runtime.agentId,
        name: 'BUY_SIGNAL',
        description: 'Generate buy signals',
        tags: ['queue', 'repeat', ServiceType.DEGEN_TRADING],
        metadata: {
          updatedAt: Date.now(),
          updateInterval: this.tradingConfig.intervals.priceCheck,
          repeat: true,
        },
      });
    }

    if (!tasks.find((task) => task.name === 'VALIDATE_DATA_SOURCES')) {
      await this.runtime.createTask({
        id: uuidv4() as UUID,
        roomId: this.runtime.agentId,
        name: 'VALIDATE_DATA_SOURCES',
        description: 'Validate data sources quality',
        tags: ['queue', 'repeat', ServiceType.DEGEN_TRADING],
        metadata: {
          updatedAt: Date.now(),
          updateInterval: 900000, // Check every 15 minutes
          repeat: true,
        },
      });
    }

    if (!tasks.find((task) => task.name === 'CIRCUIT_BREAKER_CHECK')) {
      await this.runtime.createTask({
        id: uuidv4() as UUID,
        roomId: this.runtime.agentId,
        name: 'CIRCUIT_BREAKER_CHECK',
        description: 'Check for circuit breaker conditions',
        tags: ['queue', 'repeat', ServiceType.DEGEN_TRADING],
        metadata: {
          updatedAt: Date.now(),
          updateInterval: 300000, // Check every 5 minutes
          repeat: true,
        },
      });
    }

    logger.info('Scheduled tasks created successfully');
  }

  //
  // START/STOP SERVICE
  //

  /**
   * Starts the trading service
   */
  async start(): Promise<void> {
    logger.info('Starting trading service...');

    if (this.isRunning) {
      logger.warn('Trading service is already running');
      return;
    }

    try {
      // Validate configuration
      this.validateConfiguration();

      // Generate a unique process ID
      this.processId = uuidv4() as UUID;

      // Set running flag
      logger.info('Setting isRunning flag to true');
      this.isRunning = true;

      // Register task workers
      await this.registerTasks();

      // Create scheduled tasks
      await this.createScheduledTasks();

      // Sync wallet initially
      await this.syncWallet();

      // Monitor portfolio performance initially
      await this.monitorPerformance();

      logger.info('Trading service started successfully');
    } catch (error) {
      logger.error('Error starting trading service:', error);
      this.isRunning = false;
      throw error;
    }
  }

  private validateConfiguration(): void {
    // Validate intervals
    if (this.tradingConfig.intervals.priceCheck < 10000) {
      logger.warn('Price check interval too low, setting to 10 seconds minimum');
      this.tradingConfig.intervals.priceCheck = 10000;
    }

    if (this.tradingConfig.intervals.walletSync < 60000) {
      logger.warn('Wallet sync interval too low, setting to 60 seconds minimum');
      this.tradingConfig.intervals.walletSync = 60000;
    }

    // Validate thresholds
    if (this.tradingConfig.thresholds.minLiquidity <= 0) {
      logger.warn('Minimum liquidity must be positive, setting to default');
      this.tradingConfig.thresholds.minLiquidity = 10000;
    }

    if (this.tradingConfig.thresholds.minVolume <= 0) {
      logger.warn('Minimum volume must be positive, setting to default');
      this.tradingConfig.thresholds.minVolume = 5000;
    }

    // Validate risk limits
    if (
      this.tradingConfig.riskLimits.maxPositionSize <= 0 ||
      this.tradingConfig.riskLimits.maxPositionSize > 0.5
    ) {
      logger.warn('Max position size must be between 0 and 0.5, setting to default');
      this.tradingConfig.riskLimits.maxPositionSize = 0.1;
    }

    if (
      this.tradingConfig.riskLimits.maxDrawdown <= 0 ||
      this.tradingConfig.riskLimits.maxDrawdown > 0.5
    ) {
      logger.warn('Max drawdown must be between 0 and 0.5, setting to default');
      this.tradingConfig.riskLimits.maxDrawdown = 0.2;
    }

    if (
      this.tradingConfig.riskLimits.stopLossPercentage <= 0 ||
      this.tradingConfig.riskLimits.stopLossPercentage > 50
    ) {
      logger.warn('Stop loss percentage must be between 0 and 50, setting to default');
      this.tradingConfig.riskLimits.stopLossPercentage = 10;
    }

    if (this.tradingConfig.riskLimits.takeProfitPercentage <= 0) {
      logger.warn('Take profit percentage must be positive, setting to default');
      this.tradingConfig.riskLimits.takeProfitPercentage = 20;
    }

    logger.info('Configuration validated', { config: this.tradingConfig });
  }

  async stop(): Promise<void> {
    logger.info('Stopping trading service...');

    if (!this.isRunning) {
      logger.warn('Trading service is not running');
      return;
    }

    try {
      // Set running flag to false
      this.isRunning = false;

      // Clean up scheduled tasks
      const tasks = await this.runtime.getTasks({
        tags: ['queue', 'repeat', ServiceType.DEGEN_TRADING],
      });

      for (const task of tasks) {
        await this.runtime.deleteTask(task.id!);
      }

      // Close any open positions if emergency stop
      const portfolio = await this.getPortfolioStatus();
      const positions = Object.entries(portfolio.positions);

      for (const [tokenAddress, position] of positions) {
        logger.info(`Closing position on service stop: ${tokenAddress}`);

        await this.createSellTask({
          tokenAddress,
          amount: position.amount.toString(),
          positionId: uuidv4() as UUID,
          reason: 'Service shutdown',
        });
      }

      logger.info('Trading service stopped successfully');
    } catch (error) {
      logger.error('Error stopping trading service:', error);
      throw error;
    }
  }

  /**
   * Checks if service is running
   */
  isServiceRunning(): boolean {
    return this.isRunning;
  }

  //
  // TRADE PERFORMANCE TRACKING & API METHODS
  //

  /**
   * Gets quote for a trade
   */
  async getQuote(params: {
    inputMint: string;
    outputMint: string;
    amount: string;
    walletAddress: string;
    slippageBps: number;
  }): Promise<any> {
    try {
      // Implement quote retrieval from Jupiter API
      const response = await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=${params.inputMint}&outputMint=${params.outputMint}&amount=${params.amount}&slippageBps=${params.slippageBps}`
      );

      if (!response.ok) {
        throw new Error(`Jupiter API returned ${response.status}`);
      }

      const quoteData = await response.json();

      // Get swap transaction from the Jupiter API
      const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          quoteResponse: quoteData,
          userPublicKey: params.walletAddress,
        }),
      });

      if (!swapResponse.ok) {
        throw new Error(`Jupiter swap API returned ${swapResponse.status}`);
      }

      const swapData = await swapResponse.json();

      return {
        quoteData,
        swapTransaction: swapData.swapTransaction,
      };
    } catch (error) {
      logger.error('Error getting quote:', error);
      throw error;
    }
  }

  /**
   * Starts monitoring process for a token
   */
  async startDegenProcess(data: {
    id: string;
    tokenAddress: string;
    balance: string;
    isSimulation: boolean;
    initialMarketCap: string;
    initialPrice: string;
    entityId: string;
    walletAddress: string;
    txHash: string;
  }): Promise<void> {
    try {
      logger.info(`Starting degen process for token ${data.tokenAddress}`);

      // Store process data
      this.processId = data.id;

      // Add transaction to database
      await this.addDegenTransaction({
        id: data.id,
        address: data.tokenAddress,
        amount: data.balance,
        walletAddress: data.walletAddress,
        isSimulation: data.isSimulation,
        marketCap: Number.parseFloat(data.initialMarketCap),
        entityId: data.entityId,
        txHash: data.txHash,
      });

      // Calculate stop loss and take profit prices
      const initialPrice = Number.parseFloat(data.initialPrice);
      const stopLossPrice =
        initialPrice * (1 - this.tradingConfig.riskLimits.stopLossPercentage / 100);
      const takeProfitPrice =
        initialPrice * (1 + this.tradingConfig.riskLimits.takeProfitPercentage / 100);

      // Store monitoring data
      await this.runtime.setCache(`token_monitor:${data.tokenAddress}`, {
        id: data.id,
        initialPrice,
        initialMarketCap: Number.parseFloat(data.initialMarketCap),
        stopLossPrice,
        takeProfitPrice,
        amount: data.balance,
        entityId: data.entityId,
        startTime: Date.now(),
      });

      // Schedule monitoring task
      await this.runtime.createTask({
        id: uuidv4() as UUID,
        roomId: this.runtime.agentId,
        name: 'MONITOR_TOKEN',
        description: `Monitor token ${data.tokenAddress}`,
        tags: ['queue', 'repeat', ServiceType.DEGEN_TRADING],
        metadata: {
          tokenAddress: data.tokenAddress,
          initialPrice,
          initialMarketCap: Number.parseFloat(data.initialMarketCap),
          stopLossPrice,
          takeProfitPrice,
          amount: data.balance,
          entityId: data.entityId,
          updatedAt: Date.now(),
          updateInterval: 60000, // 1 minute
          repeat: true,
        },
      });

      logger.info(`Degen process started for token ${data.tokenAddress}`, {
        initialPrice,
        stopLossPrice,
        takeProfitPrice,
      });
    } catch (error) {
      logger.error(`Error starting degen process for token ${data.tokenAddress}:`, error);
      throw error;
    }
  }

  /**
   * Stops monitoring process for a token
   */
  async stopDegenProcess(processId: string): Promise<void> {
    try {
      // Find monitoring tasks for this process
      const tasks = await this.runtime.getTasks({
        tags: ['queue', 'repeat', ServiceType.DEGEN_TRADING],
      });

      // Delete all related monitoring tasks
      for (const task of tasks) {
        await this.runtime.deleteTask(task.id!);
      }

      logger.info('Token monitoring process stopped', { processId });
    } catch (error) {
      logger.error('Error stopping token monitoring process:', error);
      throw error;
    }
  }

  /**
   * Monitor token for stop loss and take profit conditions
   * This should be called at regular intervals for each token position
   */
  async monitorToken(options: {
    tokenAddress: string;
    initialPrice?: number;
    stopLossPrice?: number;
    takeProfitPrice?: number;
    amount?: string;
    entityId?: string;
    updatedAt?: number;
    updateInterval?: number;
    repeat?: boolean;
  }): Promise<any> {
    try {
      const { tokenAddress } = options;

      // Get current token balance
      const currentBalance = await getTokenBalance(this.runtime, tokenAddress);

      // Skip if no position
      if (!currentBalance || BigInt(currentBalance.toString()) <= BigInt(0)) {
        logger.info('No position to monitor', { tokenAddress });
        return;
      }

      logger.info('Monitoring token position', {
        tokenAddress,
        initialPrice: options.initialPrice,
        currentBalance: currentBalance.toString(),
      });

      // Get current token price and market data
      const marketData = await this.getTokenMarketData(tokenAddress);

      if (!marketData.price) {
        logger.warn('Unable to get current price for token', { tokenAddress });
        return;
      }

      // Calculate price change percentage
      const priceChangePercent = options.initialPrice
        ? ((marketData.price - options.initialPrice) / options.initialPrice) * 100
        : 0;

      // Get token performance data
      const _performance = await this.getLatestTradePerformance(
        tokenAddress,
        'default', // Use default recommender for monitoring
        false // Not simulation
      );

      // Log current position status
      logger.info('Position status', {
        tokenAddress,
        initialPrice: options.initialPrice,
        currentPrice: marketData.price,
        changePercent: `${priceChangePercent.toFixed(2)}%`,
        stopLossThreshold: -this.tradingConfig.riskLimits.stopLossPercentage,
        takeProfitThreshold: this.tradingConfig.riskLimits.takeProfitPercentage,
      });

      // Check stop loss condition if stopLossPrice is provided or can be calculated
      const stopLossPrice =
        options.stopLossPrice ||
        (options.initialPrice
          ? options.initialPrice * (1 - this.tradingConfig.riskLimits.stopLossPercentage / 100)
          : null);

      if (stopLossPrice && marketData.price <= stopLossPrice) {
        logger.warn('Stop loss triggered', {
          tokenAddress,
          currentPrice: marketData.price,
          stopLossPrice,
          priceChangePercent: `${priceChangePercent.toFixed(2)}%`,
          threshold: `-${this.tradingConfig.riskLimits.stopLossPercentage}%`,
        });

        // Create sell signal for entire position
        await this.createSellSignal(tokenAddress, currentBalance.toString(), 'Stop loss triggered');
        return;
      }

      // Check take profit condition if takeProfitPrice is provided or can be calculated
      const takeProfitPrice =
        options.takeProfitPrice ||
        (options.initialPrice
          ? options.initialPrice * (1 + this.tradingConfig.riskLimits.takeProfitPercentage / 100)
          : null);

      if (takeProfitPrice && marketData.price >= takeProfitPrice) {
        logger.info('Take profit condition met', {
          tokenAddress,
          currentPrice: marketData.price,
          takeProfitPrice,
          priceChangePercent: `${priceChangePercent.toFixed(2)}%`,
          threshold: `${this.tradingConfig.riskLimits.takeProfitPercentage}%`,
        });

        // Sell half the position to lock in profits (partial take profit strategy)
        const halfPosition = BigInt(currentBalance.toString()) / BigInt(2);
        await this.createSellSignal(
          tokenAddress,
          halfPosition.toString(),
          'Take profit - selling half position'
        );

        // Implement trailing stop for remaining position
        await this.setTrailingStop(
          tokenAddress,
          marketData.price,
          (BigInt(currentBalance.toString()) / BigInt(2)).toString()
        );

        return;
      }

      // Check for negative momentum signals that might indicate selling
      if (priceChangePercent > 0) {
        const technicalSignals = await this.calculateTechnicalSignals(marketData);

        // Create analysis object for trading decision
        const analysis = {
          technical: {
            rsi: technicalSignals.rsi,
            macd: technicalSignals.macd,
            volumeProfile: technicalSignals.volumeProfile,
            volatility: technicalSignals.volatility,
          },
          price: {
            current: marketData.price,
            change: priceChangePercent,
            history: marketData.priceHistory,
          },
          market: {
            marketCap: marketData.marketCap,
            volume: marketData.volume24h,
            liquidity: marketData.liquidity,
          },
        };

        // Get trading decision based on comprehensive analysis
        const decision = await this.getTradingDecision(analysis);

        if (decision.shouldAct && decision.action === 'SELL') {
          logger.info('Trading decision recommends selling', {
            tokenAddress,
            reason: decision.reason,
            confidence: decision.confidence,
          });

          // Calculate sell amount based on confidence level and market context
          const sellAmount = await this.calculateSellAmountWithMarketContext(
            currentBalance.toString(),
            decision.confidence,
            tokenAddress
          );

          await this.createSellSignal(
            tokenAddress,
            sellAmount,
            `Trading decision: ${decision.reason}`
          );
        } else if (
          technicalSignals &&
          technicalSignals.macd.histogram < 0 &&
          technicalSignals.macd.value < technicalSignals.macd.signal
        ) {
          logger.info('Negative momentum detected while in profit', {
            tokenAddress,
            macdHistogram: technicalSignals.macd.histogram,
            priceChangePercent,
          });

          // Sell a portion of the position
          const sellAmount = (
            (BigInt(currentBalance.toString()) * BigInt(3)) /
            BigInt(4)
          ).toString(); // Sell 75%
          await this.createSellSignal(
            tokenAddress,
            sellAmount,
            'Negative momentum while in profit'
          );
        }
      }

      return {
        tokenAddress,
        currentPrice: marketData.price,
        priceChangePercent,
        technicalSignals: await this.calculateTechnicalSignals(marketData),
      };
    } catch (error) {
      logger.error('Error monitoring token', {
        tokenAddress: options.tokenAddress,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        error: true,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Set a trailing stop for a token position
   */
  async setTrailingStop(
    tokenAddress: string,
    activationPrice: number,
    amount: string
  ): Promise<void> {
    try {
      const trailingStopPercentage = 5; // 5% trailing stop

      // Store trailing stop data
      await this.runtime.setCache(`trailing_stop:${tokenAddress}`, {
        tokenAddress,
        highestPrice: activationPrice,
        activationPrice,
        trailingStopPercentage,
        amount,
        createdAt: new Date().toISOString(),
      });

      // Create a monitoring task
      await this.runtime.createTask({
        id: uuidv4() as UUID,
        roomId: this.runtime.agentId,
        name: 'MONITOR_TRAILING_STOP',
        description: `Monitor trailing stop for ${tokenAddress}`,
        tags: ['queue', 'repeat', ServiceType.DEGEN_TRADING],
        metadata: {
          tokenAddress,
          updatedAt: Date.now(),
          updateInterval: 60000, // Check every minute
          repeat: true,
        },
      });

      logger.info('Trailing stop set', {
        tokenAddress,
        activationPrice,
        trailingStopPercentage,
        amount,
      });
    } catch (error) {
      logger.error('Error setting trailing stop', {
        tokenAddress,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Monitor trailing stop for a token
   */
  async monitorTrailingStop(options: { tokenAddress: string }): Promise<void> {
    try {
      const { tokenAddress } = options;

      // Get trailing stop data
      const trailingStop = await this.runtime.getCache<{
        tokenAddress: string;
        highestPrice: number;
        activationPrice: number;
        trailingStopPercentage: number;
        amount: string;
        createdAt: string;
      }>(`trailing_stop:${tokenAddress}`);

      if (!trailingStop) {
        logger.warn('Trailing stop data not found', { tokenAddress });
        return;
      }

      // Get current token balance
      const currentBalance = await getTokenBalance(this.runtime, tokenAddress);

      // Skip if no position
      if (!currentBalance || BigInt(currentBalance.toString()) <= BigInt(0)) {
        logger.info('No position, removing trailing stop', { tokenAddress });
        await this.runtime.deleteCache(`trailing_stop:${tokenAddress}`);
        return;
      }

      // Get current price
      const marketData = await this.getTokenMarketData(tokenAddress);

      if (!marketData.price) {
        logger.warn('Unable to get current price for trailing stop', {
          tokenAddress,
        });
        return;
      }

      // Update highest price if current price is higher
      if (marketData.price > trailingStop.highestPrice) {
        trailingStop.highestPrice = marketData.price;
        await this.runtime.setCache(`trailing_stop:${tokenAddress}`, trailingStop);
        logger.info('Updated trailing stop highest price', {
          tokenAddress,
          highestPrice: trailingStop.highestPrice,
        });
      }

      // Calculate trailing stop price
      const stopPrice = trailingStop.highestPrice * (1 - trailingStop.trailingStopPercentage / 100);

      // Check if current price is below stop price
      if (marketData.price <= stopPrice) {
        logger.info('Trailing stop triggered', {
          tokenAddress,
          highestPrice: trailingStop.highestPrice,
          currentPrice: marketData.price,
          stopPrice,
        });

        // Create sell signal for the specified amount
        await this.createSellSignal(tokenAddress, trailingStop.amount, 'Trailing stop triggered');

        // Remove trailing stop
        await this.runtime.deleteCache(`trailing_stop:${tokenAddress}`);
      }
    } catch (error) {
      logger.error('Error monitoring trailing stop', {
        tokenAddress: options.tokenAddress,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Create a sell signal and schedule it
   */
  async createSellSignal(tokenAddress: string, amount: string, reason: string): Promise<void> {
    try {
      const tokenBalance = await getTokenBalance(this.runtime, tokenAddress);

      const signal: SellSignalMessage = {
        tokenAddress,
        amount,
        positionId: uuidv4() as UUID,
        currentBalance: tokenBalance.toString(),
        walletAddress: this.runtime.getSetting('SOLANA_PUBLIC_KEY'),
        isSimulation: false,
        sellRecommenderId: 'default',
        reason,
      };

      await this.createSellTask(signal);

      logger.info('Sell signal created', {
        tokenAddress,
        amount,
        reason,
      });
    } catch (error) {
      logger.error('Error creating sell signal', {
        tokenAddress,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Monitor portfolio performance and manage risk
   */
  private async monitorPerformance(): Promise<void> {
    try {
      logger.info('Monitoring portfolio performance');

      // Get current portfolio status
      const portfolio = await this.getPortfolioStatus();

      // Log portfolio status
      logger.info('Portfolio status', {
        totalValue: portfolio.totalValue,
        solBalance: portfolio.solBalance,
        numPositions: Object.keys(portfolio.positions).length,
        drawdown: `${(portfolio.drawdown * 100).toFixed(2)}%`,
      });

      // Check if drawdown exceeds threshold
      if (portfolio.drawdown > this.tradingConfig.riskLimits.maxDrawdown) {
        logger.warn('Maximum drawdown exceeded', {
          drawdown: portfolio.drawdown,
          maxDrawdown: this.tradingConfig.riskLimits.maxDrawdown,
        });

        // Implement emergency risk reduction - sell a portion of all positions
        await this.reduceRisk(portfolio);
      }

      // Store performance history
      await this.storePerformanceSnapshot(portfolio);

      // Update open positions with current market data
      for (const [tokenAddress, position] of Object.entries(portfolio.positions)) {
        await this.updatePositionData(tokenAddress, position.amount);
      }
    } catch (error) {
      logger.error('Error monitoring portfolio performance:', error);
    }
  }

  /**
   * Reduce risk by selling worst-performing positions
   */
  private async reduceRisk(portfolio: PortfolioStatus): Promise<void> {
    try {
      // Skip if no positions
      if (Object.keys(portfolio.positions).length === 0) {
        return;
      }

      logger.info('Initiating risk reduction');

      // Calculate performance for each position
      const positionPerformance: Array<{
        tokenAddress: string;
        amount: number;
        value: number;
        performance: number;
      }> = [];

      for (const [tokenAddress, position] of Object.entries(portfolio.positions)) {
        // Get purchase data
        const trades = await this.getTradesForToken(tokenAddress);
        if (trades.length === 0) continue;

        // Calculate average purchase price
        const avgPurchasePrice =
          trades.reduce((sum, trade) => sum + trade.buy_price * trade.buy_amount, 0) /
          trades.reduce((sum, trade) => sum + trade.buy_amount, 0);

        // Get current price
        const marketData = await this.getTokenMarketData(tokenAddress);

        // Calculate performance
        const performance =
          marketData.price > 0 ? (marketData.price - avgPurchasePrice) / avgPurchasePrice : -1;

        positionPerformance.push({
          tokenAddress,
          amount: position.amount,
          value: position.value,
          performance,
        });
      }

      // Sort by performance (worst first)
      positionPerformance.sort((a, b) => a.performance - b.performance);

      // Sell worst-performing positions until drawdown is manageable
      let remainingDrawdown = portfolio.drawdown;
      for (const position of positionPerformance) {
        if (remainingDrawdown <= this.tradingConfig.riskLimits.maxDrawdown * 0.8) {
          break; // Stop once we've reduced drawdown to 80% of max
        }

        // Sell entire position
        await this.createSellSignal(
          position.tokenAddress,
          position.amount.toString(),
          'Risk reduction - drawdown exceeded'
        );

        // Update remaining drawdown calculation
        remainingDrawdown -= (position.value / portfolio.totalValue) * portfolio.drawdown;

        logger.info('Position sold for risk reduction', {
          tokenAddress: position.tokenAddress,
          amount: position.amount,
          value: position.value,
          performance: `${(position.performance * 100).toFixed(2)}%`,
        });
      }
    } catch (error) {
      logger.error('Error reducing risk:', error);
    }
  }

  /**
   * Store performance snapshot for historical analysis
   */
  private async storePerformanceSnapshot(portfolio: PortfolioStatus): Promise<void> {
    try {
      const snapshot = {
        timestamp: new Date().toISOString(),
        totalValue: portfolio.totalValue,
        solBalance: portfolio.solBalance,
        numPositions: Object.keys(portfolio.positions).length,
        drawdown: portfolio.drawdown,
        positions: portfolio.positions,
      };

      // Store snapshot in database
      await this.runtime.setCache(`performance_snapshot:${snapshot.timestamp}`, snapshot);

      // Update snapshot index
      const snapshotIndex =
        (await this.runtime.getCache<string[]>('performance_snapshot_index')) || [];
      snapshotIndex.push(snapshot.timestamp);

      // Limit index size to last 100 snapshots
      if (snapshotIndex.length > 100) {
        snapshotIndex.shift();
      }

      await this.runtime.setCache('performance_snapshot_index', snapshotIndex);
    } catch (error) {
      logger.error('Error storing performance snapshot:', error);
    }
  }

  /**
   * Update position data with current market information
   */
  private async updatePositionData(tokenAddress: string, amount: number): Promise<void> {
    try {
      // Get token market data
      const marketData = await this.getTokenMarketData(tokenAddress);

      // Calculate position value
      const value = amount * marketData.price;

      // Store updated position data
      await this.runtime.setCache(`position:${tokenAddress}`, {
        tokenAddress,
        amount,
        price: marketData.price,
        value,
        marketCap: marketData.marketCap,
        volume24h: marketData.volume24h,
        liquidity: marketData.liquidity,
        updatedAt: Date.now(),
      });

      // Create monitoring task for this token if it doesn't exist
      const existingTasks = await this.runtime.getTasks({
        tags: ['monitor', tokenAddress],
      });

      if (existingTasks.length === 0) {
        // Get purchase data to determine buy price
        const trades = await this.getTradesForToken(tokenAddress);
        const buyPrice = trades.length > 0 ? trades[0].buy_price : marketData.price;

        await this.runtime.createTask({
          id: uuidv4() as UUID,
          roomId: this.runtime.agentId,
          name: 'MONITOR_TOKEN',
          description: `Monitor token ${tokenAddress}`,
          tags: ['queue', 'repeat', ServiceType.DEGEN_TRADING, 'monitor', tokenAddress],
          metadata: {
            tokenAddress,
            buyPrice,
            currentBalance: amount.toString(),
            updatedAt: Date.now(),
            updateInterval: 60000, // Check every minute
            repeat: true,
          },
        });
      }
    } catch (error) {
      logger.error('Error updating position data:', error);
    }
  }

  /**
   * Get all trades for a specific token
   */
  private async getTradesForToken(tokenAddress: string): Promise<any[]> {
    try {
      // Get all trades
      const allTradesKey = 'all_trades';
      const allTrades = (await this.runtime.getCache<string[]>(allTradesKey)) || [];

      // Filter trades for this token
      const tokenTrades = [];
      for (const tradeKey of allTrades) {
        if (tradeKey.startsWith(tokenAddress)) {
          const trade = await this.runtime.getCache<any>(`trade_performance:${tradeKey}`);
          if (trade) {
            tokenTrades.push(trade);
          }
        }
      }

      // Sort by buy timestamp (newest first)
      return tokenTrades.sort(
        (a, b) => new Date(b.buy_timeStamp).getTime() - new Date(a.buy_timeStamp).getTime()
      );
    } catch (error) {
      logger.error('Error getting trades for token:', error);
      return [];
    }
  }

  async addTradePerformance(
    data: {
      token_address: string;
      recommender_id: string;
      buy_price: number;
      buy_timeStamp: string;
      buy_amount: number;
      buy_value_usd: number;
      buy_market_cap: number;
      buy_liquidity: number;
      last_updated: string;
      sell_price: number;
      sell_timeStamp: string;
      sell_amount: number;
      received_sol: number;
      sell_value_usd: number;
      sell_market_cap: number;
      sell_liquidity: number;
      profit_usd: number;
      profit_percent: number;
      market_cap_change: number;
      liquidity_change: number;
      rapidDump: boolean;
    },
    isSimulation: boolean
  ): Promise<any> {
    try {
      // Create a unique ID for this trade performance record
      const id = uuidv4();

      // Prepare the data for storage
      const tradeData = {
        id,
        ...data,
        isSimulation,
        created_at: new Date().toISOString(),
      };

      // Store in database
      await this.runtime.setCache(
        `trade_performance:${data.token_address}:${data.buy_timeStamp}`,
        tradeData
      );

      // Also store in a list of all trades for easy retrieval
      const allTradesKey = isSimulation ? 'all_simulation_trades' : 'all_trades';
      const allTrades = (await this.runtime.getCache<string[]>(allTradesKey)) || [];

      allTrades.push(`${data.token_address}:${data.buy_timeStamp}`);

      await this.runtime.setCache(allTradesKey, allTrades);

      // Update token statistics
      await this.updateTokenStatistics(data.token_address, {
        profit_usd: data.profit_usd,
        profit_percent: data.profit_percent,
        rapidDump: data.rapidDump,
      });

      logger.info('Trade performance added', {
        token_address: data.token_address,
        profit_percent: `${data.profit_percent.toFixed(2)}%`,
        profit_usd: data.profit_usd,
      });

      return tradeData;
    } catch (error) {
      logger.error('Error adding trade performance:', error);
      throw error;
    }
  }

  private async updateTokenStatistics(
    tokenAddress: string,
    data: {
      profit_usd: number;
      profit_percent: number;
      rapidDump: boolean;
    }
  ): Promise<void> {
    try {
      // Get existing statistics
      const stats = (await this.runtime.getCache<any>(`token_stats:${tokenAddress}`)) || {
        trades: 0,
        total_profit_usd: 0,
        average_profit_percent: 0,
        rapid_dumps: 0,
      };

      // Update statistics
      stats.trades += 1;
      stats.total_profit_usd += data.profit_usd;
      stats.average_profit_percent =
        (stats.average_profit_percent * (stats.trades - 1) + data.profit_percent) / stats.trades;

      if (data.rapidDump) {
        stats.rapid_dumps += 1;
      }

      // Store updated statistics
      await this.runtime.setCache(`token_stats:${tokenAddress}`, stats);
    } catch (error) {
      logger.error('Error updating token statistics:', error);
    }
  }

  async updateTradePerformanceOnSell(
    tokenAddress: string,
    _recommenderId: string,
    buyTimestamp: string,
    sellData: {
      sell_price: number;
      sell_timeStamp: string;
      sell_amount: number;
      received_sol: number;
      sell_value_usd: number;
      sell_market_cap: number;
      market_cap_change: number;
      sell_liquidity: number;
      liquidity_change: number;
      profit_usd: number;
      profit_percent: number;
      rapidDump: boolean;
      sell_recommender_id: string;
    },
    _isSimulation: boolean
  ): Promise<void> {
    try {
      // Get the existing trade performance record
      const tradeKey = `trade_performance:${tokenAddress}:${buyTimestamp}`;
      const existingTrade = await this.runtime.getCache<any>(tradeKey);

      if (!existingTrade) {
        logger.warn('Trade performance record not found for update', {
          tokenAddress,
          buyTimestamp,
        });
        return;
      }

      // Update the record with sell data
      const updatedTrade = {
        ...existingTrade,
        ...sellData,
        last_updated: new Date().toISOString(),
      };

      // Store the updated record
      await this.runtime.setCache(tradeKey, updatedTrade);

      // Update token statistics
      await this.updateTokenStatistics(tokenAddress, {
        profit_usd: sellData.profit_usd,
        profit_percent: sellData.profit_percent,
        rapidDump: sellData.rapidDump,
      });

      logger.info('Trade performance updated on sell', {
        tokenAddress,
        profit_percent: `${sellData.profit_percent.toFixed(2)}%`,
        profit_usd: sellData.profit_usd,
      });
    } catch (error) {
      logger.error('Error updating trade performance on sell:', error);
      throw error;
    }
  }

  /**
   * Calculate Relative Strength Index
   */
  private calculateRSI(prices: number[], period: number): number {
    if (prices.length < period + 1) {
      return 50; // Default neutral value
    }

    let gains = 0;
    let losses = 0;

    // Calculate initial average gain and loss
    for (let i = 1; i <= period; i++) {
      const change = prices[i] - prices[i - 1];
      if (change >= 0) {
        gains += change;
      } else {
        losses -= change;
      }
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    // Calculate RSI using smoothed averages
    for (let i = period + 1; i < prices.length; i++) {
      const change = prices[i] - prices[i - 1];
      if (change >= 0) {
        avgGain = (avgGain * (period - 1) + change) / period;
        avgLoss = (avgLoss * (period - 1)) / period;
      } else {
        avgGain = (avgGain * (period - 1)) / period;
        avgLoss = (avgLoss * (period - 1) - change) / period;
      }
    }

    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  /**
   * Calculate Moving Average Convergence Divergence
   */
  private calculateMACD(prices: number[]): {
    macd: number;
    signal: number;
    histogram: number;
  } {
    const shortPeriod = 12;
    const longPeriod = 26;
    const signalPeriod = 9;

    if (prices.length < longPeriod) {
      return { macd: 0, signal: 0, histogram: 0 };
    }

    // Calculate EMAs
    const shortEMA = this.calculateEMA(prices, shortPeriod);
    const longEMA = this.calculateEMA(prices, longPeriod);

    // Calculate MACD line
    const macdLine = shortEMA - longEMA;

    // Calculate signal line (9-day EMA of MACD line)
    const signalLine = this.calculateEMA([macdLine], signalPeriod);

    // Calculate histogram
    const histogram = macdLine - signalLine;

    return {
      macd: macdLine,
      signal: signalLine,
      histogram,
    };
  }

  /**
   * Calculate Exponential Moving Average
   */
  private calculateEMA(prices: number[], period: number): number {
    if (prices.length < period) {
      return prices[prices.length - 1];
    }

    const multiplier = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((sum, price) => sum + price, 0) / period;

    for (let i = period; i < prices.length; i++) {
      ema = (prices[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  /**
   * Analyze volume profile
   */
  private analyzeVolumeProfile(volumes: number[]): {
    trend: 'increasing' | 'decreasing' | 'stable';
    unusualActivity: boolean;
    confidence: number;
  } {
    if (volumes.length < 2) {
      return { trend: 'stable', unusualActivity: false, confidence: 0 };
    }

    // Calculate volume moving average
    const volumeMA = volumes.reduce((sum, vol) => sum + vol, 0) / volumes.length;

    // Calculate volume trend
    const recentVolume = volumes[volumes.length - 1];
    const volumeChange = ((recentVolume - volumeMA) / volumeMA) * 100;

    // Check for unusual activity (volume spike)
    const volumeStdDev = Math.sqrt(
      volumes.reduce((sum, vol) => sum + (vol - volumeMA) ** 2, 0) / volumes.length
    );
    const unusualActivity = Math.abs(recentVolume - volumeMA) > volumeStdDev * 2;

    // Determine trend
    let trend: 'increasing' | 'decreasing' | 'stable';
    if (volumeChange > 20) {
      trend = 'increasing';
    } else if (volumeChange < -20) {
      trend = 'decreasing';
    } else {
      trend = 'stable';
    }

    // Calculate confidence based on volume consistency
    const confidence = Math.min(100, Math.abs(volumeChange));

    return { trend, unusualActivity, confidence };
  }

  /**
   * Calculate price volatility
   */
  private calculateVolatility(prices: number[]): number {
    if (prices.length < 2) {
      return 0;
    }

    // Calculate daily returns
    const returns = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    }

    // Calculate standard deviation of returns
    const mean = returns.reduce((sum, ret) => sum + ret, 0) / returns.length;
    const variance = returns.reduce((sum, ret) => sum + (ret - mean) ** 2, 0) / returns.length;

    return Math.sqrt(variance);
  }

  /**
   * Get trading decision based on market analysis
   */
  private async getTradingDecision(analysis: any): Promise<{
    shouldAct: boolean;
    action: 'BUY' | 'SELL' | 'HOLD';
    confidence: 'low' | 'medium' | 'high';
    reason: string;
  }> {
    type Decision = {
      shouldAct: boolean;
      action: 'BUY' | 'SELL' | 'HOLD';
      confidence: 'low' | 'medium' | 'high';
      reason: string;
    };

    // Default to hold
    let decision: Decision = {
      shouldAct: false,
      action: 'HOLD',
      confidence: 'low',
      reason: 'No clear signals',
    };

    try {
      // Extract technical indicators
      const rsi = analysis.technical?.rsi || 50;
      const macd = analysis.technical?.macd || {
        value: 0,
        signal: 0,
        histogram: 0,
      };
      const volumeProfile = analysis.technical?.volumeProfile || {
        trend: 'stable',
        unusualActivity: false,
      };
      const volatility = analysis.technical?.volatility || 0;

      // Extract price data
      const _currentPrice = analysis.price?.current || 0;
      const priceChange = analysis.price?.change || 0;

      // Extract market data
      const marketCap = analysis.market?.marketCap || 0;
      const _volume = analysis.market?.volume || 0;
      const liquidity = analysis.market?.liquidity || 0;

      // Check if this is a buy or sell decision
      const isBuyAnalysis = !!analysis.recommendation;

      if (isBuyAnalysis) {
        // BUY DECISION LOGIC
        let buySignals = 0;
        let buyConfidence = 0;
        const reasons: string[] = [];

        // RSI indicates oversold (buy opportunity)
        if (rsi < 30) {
          buySignals++;
          buyConfidence += 30;
          reasons.push('RSI indicates oversold condition');
        }

        // MACD shows positive momentum
        if (macd.histogram > 0 && macd.value > macd.signal) {
          buySignals++;
          buyConfidence += 25;
          reasons.push('MACD shows positive momentum');
        }

        // Volume is increasing
        if (volumeProfile.trend === 'increasing') {
          buySignals++;
          buyConfidence += 20;
          reasons.push('Volume is increasing');
        }

        // Recommendation score is high
        if (analysis.recommendation?.score > 50) {
          buySignals++;
          buyConfidence += 25;
          reasons.push('Token has strong recommendation score');
        }

        // Market cap and liquidity checks
        if (marketCap > this.tradingConfig.thresholds.minLiquidity * 3) {
          buySignals++;
          buyConfidence += 15;
          reasons.push('Market cap is sufficient');
        }

        if (liquidity > this.tradingConfig.thresholds.minLiquidity) {
          buySignals++;
          buyConfidence += 15;
          reasons.push('Liquidity is sufficient');
        }

        // Make buy decision based on signals and confidence
        if (buySignals >= 3 && buyConfidence >= 60) {
          let confidenceLevel: 'low' | 'medium' | 'high' = 'low';

          if (buyConfidence > 90) {
            confidenceLevel = 'high';
          } else if (buyConfidence > 75) {
            confidenceLevel = 'medium';
          }

          decision = {
            shouldAct: true,
            action: 'BUY',
            confidence: confidenceLevel,
            reason: reasons.join('; '),
          };
        }
      } else {
        // SELL DECISION LOGIC
        let sellSignals = 0;
        let sellConfidence = 0;
        const reasons: string[] = [];

        // RSI indicates overbought (sell opportunity)
        if (rsi > 70) {
          sellSignals++;
          sellConfidence += 30;
          reasons.push('RSI indicates overbought condition');
        }

        // MACD shows negative momentum
        if (macd.histogram < 0 && macd.value < macd.signal) {
          sellSignals++;
          sellConfidence += 25;
          reasons.push('MACD shows negative momentum');
        }

        // Volume is decreasing
        if (volumeProfile.trend === 'decreasing') {
          sellSignals++;
          sellConfidence += 20;
          reasons.push('Volume is decreasing');
        }

        // High volatility
        if (volatility > 0.1) {
          sellSignals++;
          sellConfidence += 15;
          reasons.push('High volatility detected');
        }

        // Price has increased significantly
        if (priceChange > 20) {
          sellSignals++;
          sellConfidence += 25;
          reasons.push('Price has increased significantly');
        }

        // Make sell decision based on signals and confidence
        if (sellSignals >= 2 && sellConfidence >= 50) {
          let confidenceLevel: 'low' | 'medium' | 'high' = 'low';

          if (sellConfidence > 80) {
            confidenceLevel = 'high';
          } else if (sellConfidence > 65) {
            confidenceLevel = 'medium';
          }

          decision = {
            shouldAct: true,
            action: 'SELL',
            confidence: confidenceLevel,
            reason: reasons.join('; '),
          };
        }
      }

      return decision;
    } catch (error) {
      logger.error('Error in trading decision logic', error);
      return decision;
    }
  }

  /**
   * Calculate sell amount based on confidence level and market conditions
   */
  private async calculateSellAmountWithMarketContext(
    balance: string,
    confidence: 'low' | 'medium' | 'high',
    tokenAddress: string
  ): Promise<string> {
    try {
      const balanceNum = BigInt(balance);
      let sellPercentage: number;

      // Base percentage based on confidence
      switch (confidence) {
        case 'high':
          sellPercentage = 0.9; // Sell 90% by default for high confidence
          break;
        case 'medium':
          sellPercentage = 0.5; // Sell 50% by default for medium confidence
          break;
        case 'low':
          sellPercentage = 0.25; // Sell 25% by default for low confidence
          break;
        default:
          sellPercentage = 0.1; // Default to 10%
      }

      // Adjust for market condition
      const marketCondition = await this.assessMarketCondition();
      if (marketCondition === 'bearish') {
        // In bearish markets, sell more aggressively
        sellPercentage = Math.min(1.0, sellPercentage * 1.5);
        logger.info('Adjusting sell amount for bearish market', {
          tokenAddress,
          originalPercentage: sellPercentage / 1.5,
          adjustedPercentage: sellPercentage,
        });
      } else if (marketCondition === 'bullish') {
        // In bullish markets, sell more conservatively
        sellPercentage = sellPercentage * 0.8;
        logger.info('Adjusting sell amount for bullish market', {
          tokenAddress,
          originalPercentage: sellPercentage / 0.8,
          adjustedPercentage: sellPercentage,
        });
      }

      // Get token market data to check for unusual conditions
      const marketData = await this.getTokenMarketData(tokenAddress);

      // If token has high volatility, adjust sell percentage
      if (marketData?.priceHistory && marketData.priceHistory.length > 0) {
        const volatility = this.calculateVolatility(marketData.priceHistory);
        if (volatility > 0.2) {
          // High volatility - sell more aggressively
          sellPercentage = Math.min(1.0, sellPercentage * 1.2);
          logger.info('Adjusting sell amount for high volatility', {
            tokenAddress,
            volatility,
            adjustedPercentage: sellPercentage,
          });
        }
      }

      // Ensure we don't sell more than available
      const sellAmount = (balanceNum * BigInt(Math.floor(sellPercentage * 100))) / BigInt(100);

      // Log the calculation
      logger.info('Calculated sell amount with market context', {
        balance: balance.toString(),
        confidence,
        marketCondition,
        sellPercentage,
        sellAmount: sellAmount.toString(),
      });

      return sellAmount.toString();
    } catch (error) {
      logger.error('Error calculating sell amount with market context', error);
      // Fall back to the basic calculation
      return this.calculateSellAmount(balance, confidence);
    }
  }

  /**
   * Add transaction to tracking
   */
  async addDegenTransaction(data: {
    id: string;
    address: string;
    amount: string;
    walletAddress: string;
    isSimulation: boolean;
    marketCap: number;
    entityId: string;
    txHash: string;
  }): Promise<void> {
    try {
      const transactionData = {
        id: data.id,
        tokenAddress: data.address,
        amount: data.amount,
        walletAddress: data.walletAddress,
        isSimulation: data.isSimulation,
        marketCap: data.marketCap,
        entityId: data.entityId,
        txHash: data.txHash,
        timestamp: new Date().toISOString(),
      };

      // Store transaction in cache
      this.runtime.setCache<any>(data.id, transactionData);

      // Store in the runtime cache
      await this.runtime.setCache<any>(`transaction:${data.id}`, transactionData);

      // Create a memory for transaction tracking
      await this.runtime.createMemory(
        {
          content: {
            data: transactionData,
            tokenAddress: data.address,
          },
          agentId: this.runtime.agentId,
          roomId: this.runtime.agentId,
          entityId: this.runtime.agentId,
          unique: true,
          metadata: {
            type: 'transaction',
          },
        },
        'transaction'
      );

      logger.info('Transaction added to tracking', {
        id: data.id,
        tokenAddress: data.address,
        txHash: data.txHash,
      });
    } catch (error) {
      logger.error('Error adding transaction to tracking:', error);
      throw error;
    }
  }

  /**
   * Get latest trade performance for a token
   */
  async getLatestTradePerformance(
    tokenAddress: string,
    recommenderId: string,
    isSimulation: boolean
  ): Promise<any> {
    try {
      // Check local cache first
      const cacheKey = `${tokenAddress}:${recommenderId}`;
      if (this.runtime.getCache<any>(cacheKey)) {
        const cached = await this.runtime.getCache<any>(cacheKey);
        if (cached.isSimulation === isSimulation) {
          return cached;
        }
      }

      // Get performance index from cache
      const performanceIndex =
        (await this.runtime.getCache<any[]>('trade_performance_index')) || [];

      // Filter and sort by buy timestamp (descending)
      const filtered = performanceIndex
        .filter(
          (entry) => entry.token_address === tokenAddress && entry.recommender_id === recommenderId
        )
        .sort((a, b) => new Date(b.buy_timeStamp).getTime() - new Date(a.buy_timeStamp).getTime());

      if (filtered.length > 0) {
        // Get full record from cache for the most recent entry
        const latestEntry = filtered[0];
        const fullRecord = await this.runtime.getCache<any>(`trade_performance:${latestEntry.id}`);

        if (fullRecord) {
          // Update local cache
          this.runtime.setCache<any>(cacheKey, fullRecord);
          return fullRecord;
        }
      }

      return null;
    } catch (error) {
      logger.error('Error getting latest trade performance:', error);
      throw error;
    }
  }

  /**
   * Calculate current drawdown based on portfolio high water mark
   */
  private async calculateDrawdown(portfolio: {
    totalValue: number;
    positions: { [tokenAddress: string]: { amount: number; value: number } };
    solBalance: number;
  }): Promise<number> {
    try {
      // Get high water mark from cache
      const hwm = (await this.runtime.getCache<number>('portfolio_hwm')) || portfolio.totalValue;

      // Update high water mark if current value is higher
      if (portfolio.totalValue > hwm) {
        await this.runtime.setCache('portfolio_hwm', portfolio.totalValue);
        return 0;
      }

      // Calculate drawdown as percentage from high water mark
      return (hwm - portfolio.totalValue) / hwm;
    } catch (error) {
      logger.error('Error calculating drawdown:', error);
      return 0;
    }
  }

  private async getTokenMarketData(tokenAddress: string): Promise<{
    price: number;
    marketCap: number;
    liquidity: number;
    volume24h: number;
    priceHistory: number[];
    volumeHistory: number[];
  }> {
    const cacheKey = `market_data_${tokenAddress}`;
    const cached = await this.runtime.getCache<any>(cacheKey);
    if (cached) return cached;

    try {
      // Get API key from environment variables instead of secretsManager
      const apiKey = process.env.BIRDEYE_API_KEY;
      if (!apiKey) {
        throw new Error('Birdeye API key not found');
      }

      // Fetch token price and market data
      const response = await fetch(
        `https://api.birdeye.so/v1/token/price?address=${tokenAddress}`,
        {
          headers: {
            'X-API-KEY': apiKey,
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Birdeye API error: ${response.status}`);
      }

      const data = await response.json();
      if (!data.success) {
        throw new Error(`Birdeye API error: ${data.message || 'Unknown error'}`);
      }

      // Fetch token price history
      const historyResponse = await fetch(
        `https://api.birdeye.so/v1/token/price_history?address=${tokenAddress}&type=hour&limit=24`,
        {
          headers: {
            'X-API-KEY': apiKey,
          },
        }
      );

      if (!historyResponse.ok) {
        throw new Error(`Birdeye API error for price history: ${historyResponse.status}`);
      }

      const historyData = await historyResponse.json();
      if (!historyData.success) {
        throw new Error(`Birdeye API error: ${historyData.message || 'Unknown error'}`);
      }

      const priceHistory = historyData.data.items.map((item: any) => item.value);
      const volumeHistory = historyData.data.items.map((item: any) => item.volume || 0);

      const result = {
        price: data.data.value,
        marketCap: data.data.marketCap || 0,
        liquidity: data.data.liquidity || 0, // Fixed: removed .usd
        volume24h: data.data.volume24h || 0,
        priceHistory,
        volumeHistory,
      };

      // Cache the result
      await this.runtime.setCache(cacheKey, result); // 1 minute TTL
      return result;
    } catch (error) {
      logger.error('Error fetching token market data:', error);
      // Return placeholder data if API fails
      return {
        price: 0,
        marketCap: 0,
        liquidity: 0,
        volume24h: 0,
        priceHistory: [],
        volumeHistory: [],
      };
    }
  }

  private async calculateTechnicalSignals(marketData: {
    price: number;
    marketCap: number;
    liquidity: number;
    volume24h: number;
    priceHistory: number[];
    volumeHistory: number[];
  }): Promise<TokenSignal['technicalSignals']> {
    if (!marketData.priceHistory.length) {
      return {
        rsi: 50,
        macd: { value: 0, signal: 0, histogram: 0 },
        volumeProfile: { trend: 'stable', unusualActivity: false },
        volatility: 0,
      };
    }

    const rsi = this.calculateRSI(marketData.priceHistory, 14);
    const macdResult = this.calculateMACD(marketData.priceHistory);
    const volumeProfile = this.analyzeVolumeProfile(marketData.volumeHistory);
    const volatility = this.calculateVolatility(marketData.priceHistory);

    return {
      rsi,
      macd: {
        value: macdResult.macd,
        signal: macdResult.signal,
        histogram: macdResult.histogram,
      },
      volumeProfile: {
        trend: volumeProfile.trend,
        unusualActivity: volumeProfile.unusualActivity,
      },
      volatility,
    };
  }

  // Add missing methods for scoring metrics
  private scoreSocialMetrics(metrics: TokenSignal['socialMetrics']): number {
    if (!metrics) return 0;

    let score = 0;

    // Score based on mention count (0-10)
    if (metrics.mentionCount > 1000) score += 10;
    else if (metrics.mentionCount > 500) score += 8;
    else if (metrics.mentionCount > 200) score += 6;
    else if (metrics.mentionCount > 100) score += 4;
    else if (metrics.mentionCount > 50) score += 2;

    // Score based on sentiment (0-10)
    if (metrics.sentiment > 0.8) score += 10;
    else if (metrics.sentiment > 0.6) score += 8;
    else if (metrics.sentiment > 0.4) score += 6;
    else if (metrics.sentiment > 0.2) score += 4;
    else if (metrics.sentiment > 0) score += 2;

    // Score based on influencer mentions (0-10)
    if (metrics.influencerMentions > 10) score += 10;
    else if (metrics.influencerMentions > 5) score += 8;
    else if (metrics.influencerMentions > 3) score += 6;
    else if (metrics.influencerMentions > 1) score += 4;
    else if (metrics.influencerMentions > 0) score += 2;

    return score;
  }

  private scoreMarketMetrics(metrics: {
    marketCap: number;
    volume24h: number;
    liquidity: number;
  }): number {
    let score = 0;

    // Score based on market cap (0-10)
    // Lower market cap = higher score (more room to grow)
    if (metrics.marketCap < 100000) score += 10;
    else if (metrics.marketCap < 500000) score += 8;
    else if (metrics.marketCap < 1000000) score += 6;
    else if (metrics.marketCap < 5000000) score += 4;
    else if (metrics.marketCap < 10000000) score += 2;

    // Score based on 24h volume (0-10)
    if (metrics.volume24h > 1000000) score += 10;
    else if (metrics.volume24h > 500000) score += 8;
    else if (metrics.volume24h > 100000) score += 6;
    else if (metrics.volume24h > 50000) score += 4;
    else if (metrics.volume24h > 10000) score += 2;

    // Score based on liquidity (0-10)
    if (metrics.liquidity > 500000) score += 10;
    else if (metrics.liquidity > 100000) score += 8;
    else if (metrics.liquidity > 50000) score += 6;
    else if (metrics.liquidity > 10000) score += 4;
    else if (metrics.liquidity > 5000) score += 2;

    return score;
  }

  /**
   * Get current portfolio status including total value and positions
   */
  private async getPortfolioStatus(): Promise<PortfolioStatus> {
    try {
      const solBalance = await getWalletBalance(this.runtime);
      const positions: {
        [tokenAddress: string]: { amount: number; value: number };
      } = {};
      let totalValue = solBalance;

      // Get monitored tokens
      const monitoredTokens = await this.getMonitoredTokens();

      // Calculate total value including token positions
      for (const token of monitoredTokens) {
        const balance = await getTokenBalance(this.runtime, token.address);
        const { price } = await this.getTokenPrice(token.address);
        const value = Number(balance) * price;

        if (value > 0) {
          positions[token.address] = {
            amount: Number(balance),
            value,
          };
          totalValue += value;
        }
      }

      // Calculate drawdown
      const highWaterMark = await this.getHighWaterMark();
      const drawdown = highWaterMark > 0 ? (highWaterMark - totalValue) / highWaterMark : 0;

      return {
        totalValue,
        positions,
        solBalance,
        drawdown,
      };
    } catch (error) {
      logger.error('Error getting portfolio status:', error);
      return {
        totalValue: 0,
        positions: {},
        solBalance: 0,
        drawdown: 0,
      };
    }
  }

  /**
   * Get high water mark from cache
   */
  private async getHighWaterMark(): Promise<number> {
    const key = 'portfolio_high_water_mark';
    const cached = await this.runtime.getCache<number>(key);
    return cached || 0;
  }

  /**
   * Get list of monitored tokens
   */
  private async getMonitoredTokens(): Promise<Array<{ address: string; symbol: string }>> {
    try {
      return (await this.runtime.getCache('monitored_tokens')) || [];
    } catch (error) {
      logger.error('Error getting monitored tokens:', error);
      return [];
    }
  }

  private async getTokenPrice(tokenAddress: string): Promise<{
    price: number;
    marketCap: number;
    liquidity: number;
    volume24h: number;
  }> {
    const cacheKey = `price:${tokenAddress}`;
    const cached = await this.runtime.getCache<{
      price: number;
      marketCap: number;
      liquidity: number;
      volume24h: number;
    }>(cacheKey);

    if (cached) return cached;

    const response = await fetch(
      `https://public-api.birdeye.so/defi/v3/token/market-data?address=${tokenAddress}`,
      {
        headers: {
          'X-API-KEY': this.runtime.getSetting('BIRDEYE_API_KEY') || '',
        },
      }
    );

    const data = await response.json();
    const result = {
      price: data?.data?.price || 0,
      marketCap: data?.data?.marketCap || 0,
      liquidity: data?.data?.liquidity?.usd || 0,
      volume24h: data?.data?.volume24h || 0,
    };

    await this.runtime.setCache(cacheKey, result);
    return result;
  }

  private async retryWithExponentialBackoff<T>(
    operation: () => Promise<T>,
    maxRetries = 3,
    baseDelay = 1000
  ): Promise<T> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await operation();
      } catch (error) {
        if (i === maxRetries - 1) throw error;
        const delay = baseDelay * 2 ** i;
        logger.warn(`Retry ${i + 1}/${maxRetries} after ${delay}ms`, { error });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error('Retry failed');
  }

  private scoreTechnicalSignals(signals: TokenSignal['technicalSignals']): number {
    if (!signals) return 0;

    let score = 0;

    // RSI scoring (0-10)
    if (signals.rsi < 30)
      score += 10; // Oversold
    else if (signals.rsi > 70)
      score -= 5; // Overbought
    else score += 5; // Neutral

    // MACD scoring (0-10)
    if (signals.macd.value > 0 && signals.macd.value > signals.macd.signal) {
      score += 10; // Strong uptrend
    } else if (
      signals.macd.value < 0 &&
      Math.abs(signals.macd.value) > Math.abs(signals.macd.signal)
    ) {
      score -= 5; // Strong downtrend
    }

    // Volume profile scoring (0-10)
    if (signals.volumeProfile?.trend === 'increasing' && !signals.volumeProfile.unusualActivity) {
      score += 10;
    }

    // Volatility scoring (0-10)
    if (signals.volatility < 0.2) score += 10;
    else if (signals.volatility > 0.5) score -= 5;

    return score;
  }

  /**
   * Validate data sources to ensure quality
   */
  async validateDataSources(): Promise<void> {
    try {
      logger.debug('Validating data sources');

      // Check Birdeye API
      const birdeyeStatus = await this.checkBirdeyeAPI();

      // Check Twitter data quality
      const twitterStatus = await this.checkTwitterData();

      // Check CMC data quality
      const cmcStatus = await this.checkCMCData();

      // Log validation results
      logger.debug('Data source validation results', {
        birdeye: birdeyeStatus,
        twitter: twitterStatus,
        cmc: cmcStatus,
      });

      // Update global data quality flag
      const dataQuality =
        birdeyeStatus.valid && twitterStatus.valid && cmcStatus.valid ? 'good' : 'degraded';

      await this.runtime.setCache('data_quality', {
        status: dataQuality,
        birdeye: birdeyeStatus,
        twitter: twitterStatus,
        cmc: cmcStatus,
        updatedAt: Date.now(),
      });

      // Take action if data quality is poor
      if (dataQuality === 'degraded') {
        await this.handleDegradedDataQuality({
          birdeye: birdeyeStatus,
          twitter: twitterStatus,
          cmc: cmcStatus,
        });
      }
    } catch (error) {
      logger.error('Error validating data sources:', error);
    }
  }

  /**
   * Check Birdeye API status
   */
  private async checkBirdeyeAPI(): Promise<{
    valid: boolean;
    issues: string[];
  }> {
    try {
      // Get API key
      const apiKey = process.env.BIRDEYE_API_KEY;
      if (!apiKey) {
        return {
          valid: false,
          issues: ['Birdeye API key not found'],
        };
      }

      // Try to fetch SOL data as test
      const response = await fetch(
        'https://api.birdeye.so/v1/token/price?address=So11111111111111111111111111111111111111112',
        {
          headers: {
            'X-API-KEY': apiKey,
          },
        }
      );

      if (!response.ok) {
        return {
          valid: false,
          issues: [`API response status: ${response.status}`],
        };
      }

      const data = await response.json();
      if (!data.success) {
        return {
          valid: false,
          issues: [`API error: ${data.message || 'Unknown error'}`],
        };
      }

      return {
        valid: true,
        issues: [],
      };
    } catch (error) {
      return {
        valid: false,
        issues: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  /**
   * Check Twitter data quality
   */
  private async checkTwitterData(): Promise<{
    valid: boolean;
    issues: string[];
  }> {
    try {
      // Get Twitter signals from cache
      const twitterSignals = (await this.runtime.getCache<any[]>('twitter_parsed_signals')) || [];

      const issues = [];

      // Check if data exists
      if (twitterSignals.length === 0) {
        issues.push('No Twitter signals available');
      }

      // Check data freshness
      const cacheMetadata = await this.runtime.getCache<any>('twitter_signals_metadata');
      if (!cacheMetadata || !cacheMetadata.updatedAt) {
        issues.push('Twitter signal metadata missing');
      } else {
        const lastUpdate = new Date(cacheMetadata.updatedAt).getTime();
        const now = Date.now();
        const hoursSinceUpdate = (now - lastUpdate) / (1000 * 60 * 60);

        if (hoursSinceUpdate > 6) {
          issues.push(`Twitter data is ${hoursSinceUpdate.toFixed(1)} hours old`);
        }
      }

      return {
        valid: issues.length === 0,
        issues,
      };
    } catch (error) {
      return {
        valid: false,
        issues: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  /**
   * Check CMC data quality
   */
  private async checkCMCData(): Promise<{ valid: boolean; issues: string[] }> {
    try {
      // Get CMC tokens from cache
      const cmcTokens = (await this.runtime.getCache<any[]>('cmc_trending_tokens')) || [];

      const issues = [];

      // Check if data exists
      if (cmcTokens.length === 0) {
        issues.push('No CMC tokens available');
      }

      // Check data freshness
      const cacheMetadata = await this.runtime.getCache<any>('cmc_tokens_metadata');
      if (!cacheMetadata || !cacheMetadata.updatedAt) {
        issues.push('CMC token metadata missing');
      } else {
        const lastUpdate = new Date(cacheMetadata.updatedAt).getTime();
        const now = Date.now();
        const hoursSinceUpdate = (now - lastUpdate) / (1000 * 60 * 60);

        if (hoursSinceUpdate > 12) {
          issues.push(`CMC data is ${hoursSinceUpdate.toFixed(1)} hours old`);
        }
      }

      return {
        valid: issues.length === 0,
        issues,
      };
    } catch (error) {
      return {
        valid: false,
        issues: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  /**
   * Handle degraded data quality
   */
  private async handleDegradedDataQuality(status: {
    birdeye: { valid: boolean; issues: string[] };
    twitter: { valid: boolean; issues: string[] };
    cmc: { valid: boolean; issues: string[] };
  }): Promise<void> {
    try {
      logger.debug('Handling degraded data quality', status);

      // Adjust trading behavior based on which data sources are degraded

      // If price data (Birdeye) is unreliable, pause new trades
      if (!status.birdeye.valid) {
        logger.warn('Pausing new trades due to Birdeye API issues');
        await this.runtime.setCache('trading_paused', {
          paused: true,
          reason: 'Birdeye API issues',
          issues: status.birdeye.issues,
          timestamp: new Date().toISOString(),
        });

        // Consider reducing risk if price data is unreliable
        const portfolio = await this.getPortfolioStatus();
        await this.reduceRisk(portfolio);
      }

      // If Twitter data is stale, adjust scoring weights
      if (!status.twitter.valid) {
        logger.warn('Reducing social metrics weight due to stale Twitter data');
        await this.runtime.setCache('scoring_weights', {
          market: 0.6,
          technical: 0.35,
          social: 0.05, // Reduce social weight significantly
        });
      }

      // If CMC data is missing, focus on technical analysis
      if (!status.cmc.valid) {
        logger.warn('CMC data issues detected, focusing on technical analysis');
        await this.runtime.setCache('cmc_data_valid', false);
      }
    } catch (error) {
      logger.error('Error handling degraded data quality:', error);
    }
  }

  /**
   * Check for market-wide circuit breaker conditions
   */
  async checkCircuitBreaker(): Promise<void> {
    try {
      logger.debug('Checking circuit breaker conditions');

      // Get SOL price data as main market indicator
      const solData = await this.getTokenMarketData('So11111111111111111111111111111111111111112');

      if (!solData.priceHistory || solData.priceHistory.length < 24) {
        logger.warn('Insufficient price history for circuit breaker check');
        return;
      }

      // Calculate 1h price change
      const currentPrice = solData.price;
      const priorPrice = solData.priceHistory[6]; // Assuming 10-minute intervals
      const priceChangePercent = ((currentPrice - priorPrice) / priorPrice) * 100;

      // Calculate volatility
      const volatility = this.calculateVolatility(solData.priceHistory);

      // Log market conditions
      logger.info('Market conditions', {
        currentPrice,
        priceChangePercent: `${priceChangePercent.toFixed(2)}%`,
        volatility,
      });

      // Check for circuit breaker triggers
      const circuitBreakerTriggered =
        Math.abs(priceChangePercent) > 15 || // More than 15% move in 1 hour
        volatility > 0.6; // Extremely high volatility

      if (circuitBreakerTriggered) {
        logger.warn('Circuit breaker triggered', {
          priceChangePercent,
          volatility,
          actions: ['pausing_trades'],
        });

        // Pause trading
        await this.runtime.setCache('circuit_breaker', {
          triggered: true,
          reason: Math.abs(priceChangePercent) > 15 ? 'extreme_price_movement' : 'high_volatility',
          timestamp: new Date().toISOString(),
          details: {
            priceChangePercent,
            volatility,
          },
        });

        // Update trading status
        await this.runtime.setCache('trading_paused', {
          paused: true,
          reason: 'Circuit breaker triggered',
          timestamp: new Date().toISOString(),
          expiryTime: new Date(Date.now() + 3600000).toISOString(), // 1 hour pause
        });
      }
    } catch (error) {
      logger.error('Error checking circuit breaker conditions:', error);
    }
  }

  /**
   * Calculate dynamic slippage based on token metrics and trade size
   * @param tokenAddress The token address
   * @param tradeAmount The amount to trade in SOL or token units
   * @param isSell Whether this is a sell trade
   * @returns The slippage in basis points (1% = 100 basis points)
   */
  private async calculateDynamicSlippage(
    tokenAddress: string,
    tradeAmount: number,
    isSell = false
  ): Promise<number> {
    try {
      // Get token market data
      const tokenData = await this.getTokenPrice(tokenAddress);

      // Start with base slippage from config
      let slippage = this.tradingConfig.slippageSettings.baseSlippage;

      // Calculate relative trade size as percentage of token liquidity
      const tradeValue = isSell
        ? tradeAmount * tokenData.price // For selling, convert token amount to SOL value
        : tradeAmount; // For buying, already in SOL

      const liquidityPercentage = (tradeValue / tokenData.liquidity) * 100;

      // Liquidity adjustment: Increase slippage as trade size approaches significant % of liquidity
      if (liquidityPercentage > 0.1) {
        // If trade is more than 0.1% of liquidity, start increasing slippage
        const liquidityFactor =
          liquidityPercentage ** 1.5 * this.tradingConfig.slippageSettings.liquidityMultiplier;
        slippage += liquidityFactor * 0.01; // Scale appropriately

        logger.info('Liquidity-based slippage adjustment', {
          tokenAddress,
          liquidityPercentage: `${liquidityPercentage.toFixed(2)}%`,
          liquidityFactor,
          adjustedSlippage: slippage,
        });
      }

      // Volume adjustment: Lower slippage for tokens with higher volume relative to market cap
      const volumeToMcapRatio = tokenData.volume24h / tokenData.marketCap;
      if (volumeToMcapRatio > 0.05) {
        // High volume tokens can handle lower slippage
        const volumeDiscount =
          Math.min(volumeToMcapRatio * 5, 0.5) *
          this.tradingConfig.slippageSettings.volumeMultiplier;
        slippage = Math.max(
          slippage - volumeDiscount,
          this.tradingConfig.slippageSettings.baseSlippage * 0.5
        );

        logger.info('Volume-based slippage adjustment', {
          tokenAddress,
          volumeToMcapRatio,
          volumeDiscount,
          adjustedSlippage: slippage,
        });
      }

      // Apply token-specific adjustments for known tokens with special characteristics
      if (await this.hasSpecialSlippageRequirement(tokenAddress)) {
        // Some tokens need special handling due to specific tokenomics (e.g., tax tokens)
        const specialAdjustment = await this.getSpecialSlippageAdjustment(tokenAddress);
        slippage += specialAdjustment;

        logger.info('Special token slippage adjustment', {
          tokenAddress,
          specialAdjustment,
          adjustedSlippage: slippage,
        });
      }

      // Cap slippage at maximum allowed value
      const finalSlippage = Math.min(slippage, this.tradingConfig.slippageSettings.maxSlippage);

      // Convert percentage to basis points
      const slippageBps = Math.floor(finalSlippage * 100);

      logger.info('Calculated dynamic slippage', {
        tokenAddress,
        tradeAmount,
        isSell,
        liquidityPercentage: `${liquidityPercentage.toFixed(2)}%`,
        baseSlippage: this.tradingConfig.slippageSettings.baseSlippage,
        finalSlippage,
        slippageBps,
      });

      return slippageBps;
    } catch (error) {
      logger.error('Error calculating dynamic slippage', {
        tokenAddress,
        error: error instanceof Error ? error.message : String(error),
      });

      // Fall back to a safe default slippage in case of error
      return 100; // 1% as fallback
    }
  }

  /**
   * Check if token has special slippage requirements
   */
  private async hasSpecialSlippageRequirement(tokenAddress: string): Promise<boolean> {
    // Check cache for known special tokens
    const specialTokens = (await this.runtime.getCache<string[]>('special_slippage_tokens')) || [];
    return specialTokens.includes(tokenAddress);
  }

  /**
   * Get special slippage adjustment for a token with unique characteristics
   */
  private async getSpecialSlippageAdjustment(tokenAddress: string): Promise<number> {
    try {
      // Get token-specific data from cache
      const tokenData = await this.runtime.getCache<{
        slippageAdjustment: number;
        reason: string;
      }>(`token_slippage:${tokenAddress}`);

      if (tokenData) {
        return tokenData.slippageAdjustment;
      }

      // For tax tokens, you might need higher slippage
      // This would require knowledge of token tax rates from external sources
      const taxInfo = await this.fetchTokenTaxInfo(tokenAddress);
      if (taxInfo?.hasTax) {
        return taxInfo.taxPercentage * 1.5; // Add buffer above tax rate
      }

      return 0;
    } catch (error) {
      logger.error('Error getting special slippage adjustment', {
        tokenAddress,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Fetch information about token taxes
   */
  private async fetchTokenTaxInfo(tokenAddress: string): Promise<{
    hasTax: boolean;
    taxPercentage: number;
  } | null> {
    try {
      // This would typically call an external API or service that tracks token taxes
      // For now, we'll implement a simple cache-based approach

      const cachedInfo = await this.runtime.getCache<{
        hasTax: boolean;
        taxPercentage: number;
      }>(`token_tax:${tokenAddress}`);

      if (cachedInfo) {
        return cachedInfo;
      }

      // Default to no tax if we don't have data
      return { hasTax: false, taxPercentage: 0 };
    } catch (error) {
      logger.error('Error fetching token tax info', {
        tokenAddress,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Track and analyze slippage impact on completed trades
   */
  private async trackSlippageImpact(
    tokenAddress: string,
    expectedAmount: string,
    actualAmount: string,
    slippageBpsUsed: number,
    isSell: boolean
  ): Promise<void> {
    try {
      // Convert amounts to numbers for calculation
      const expected = Number(expectedAmount);
      const actual = Number(actualAmount);

      if (expected <= 0 || actual <= 0) {
        logger.warn('Invalid amounts for slippage tracking', {
          tokenAddress,
          expectedAmount,
          actualAmount,
        });
        return;
      }

      // Calculate actual slippage as percentage
      // For buys: (expected - actual) / expected
      // For sells: (expected - actual) / expected
      const actualSlippage = ((expected - actual) / expected) * 100;
      const actualSlippageBps = Math.floor(actualSlippage * 100);

      // Get token data for context
      const tokenData = await this.getTokenPrice(tokenAddress);

      // Store slippage data for this trade
      await this.runtime.setCache(`slippage_impact:${tokenAddress}:${Date.now()}`, {
        tokenAddress,
        timestamp: new Date().toISOString(),
        expectedAmount,
        actualAmount,
        slippageBpsUsed,
        actualSlippageBps,
        isSell,
        price: tokenData.price,
        liquidity: tokenData.liquidity,
        volume24h: tokenData.volume24h,
      });

      // Log slippage impact
      logger.info('Trade slippage impact', {
        tokenAddress,
        slippageBpsUsed,
        actualSlippageBps,
        slippageEfficiency: actualSlippageBps / slippageBpsUsed,
        isSell,
      });

      // Periodically optimize slippage parameters based on historical data
      await this.maybeOptimizeSlippageParameters();
    } catch (error) {
      logger.error('Error tracking slippage impact', {
        tokenAddress,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Optimize slippage parameters based on historical trade data
   */
  private async maybeOptimizeSlippageParameters(): Promise<void> {
    try {
      // Only run this occasionally to avoid excessive processing
      const lastOptimizationTime = await this.runtime.getCache<number>(
        'last_slippage_optimization'
      );
      const now = Date.now();

      if (lastOptimizationTime && now - lastOptimizationTime < 24 * 60 * 60 * 1000) {
        // Don't optimize more than once per day
        return;
      }

      // Get all slippage impact records from the last 7 days
      const cutoffTime = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

      // Get all keys with the slippage_impact prefix
      // Note: This assumes the database adapter has a method to get keys by prefix
      // If not available, we can use a different approach like storing an index of all slippage records
      const slippageKeys = (await this.runtime.getCache<string[]>('slippage_impact_keys')) || [];

      // Get all records
      const allRecords: Array<{ key: string; value: any }> = [];
      for (const key of slippageKeys) {
        const value = await this.runtime.getCache<any>(key);
        if (value) {
          allRecords.push({ key, value });
        }
      }

      if (allRecords.length < 10) {
        // Need more data for meaningful optimization
        return;
      }

      // Filter recent records
      const recentRecords = allRecords.filter((record) => {
        const data = record.value;
        return data.timestamp >= cutoffTime;
      });

      if (recentRecords.length < 10) {
        return;
      }

      // Analyze records to find optimal parameters
      const liquidityBuckets: Record<string, Array<any>> = {
        low: [], // Low liquidity tokens
        medium: [], // Medium liquidity tokens
        high: [], // High liquidity tokens
      };

      // Group records by liquidity level
      for (const record of recentRecords) {
        const data = record.value;

        if (data.liquidity < 10000) {
          liquidityBuckets.low.push(data);
        } else if (data.liquidity < 100000) {
          liquidityBuckets.medium.push(data);
        } else {
          liquidityBuckets.high.push(data);
        }
      }

      // Calculate optimal slippage multipliers for each bucket
      const optimizedSettings = {
        baseSlippage: this.tradingConfig.slippageSettings.baseSlippage,
        maxSlippage: this.tradingConfig.slippageSettings.maxSlippage,
        liquidityMultiplier: this.tradingConfig.slippageSettings.liquidityMultiplier,
        volumeMultiplier: this.tradingConfig.slippageSettings.volumeMultiplier,
      };

      // Adjust liquidity multiplier based on low liquidity token performance
      if (liquidityBuckets.low.length >= 5) {
        const lowLiquidityEfficiency = this.calculateAverageSlippageEfficiency(
          liquidityBuckets.low
        );

        if (lowLiquidityEfficiency > 0.9) {
          // We're using too much slippage, can decrease
          optimizedSettings.liquidityMultiplier = Math.max(
            0.5,
            optimizedSettings.liquidityMultiplier * 0.9
          );
        } else if (lowLiquidityEfficiency < 0.7) {
          // Not enough slippage, increase
          optimizedSettings.liquidityMultiplier = Math.min(
            2.0,
            optimizedSettings.liquidityMultiplier * 1.1
          );
        }
      }

      // Adjust volume multiplier based on high volume token performance
      const highVolumeRecords = recentRecords.filter((record) => {
        const data = record.value;
        return data.volume24h / data.liquidity > 0.3; // High volume relative to liquidity
      });

      if (highVolumeRecords.length >= 5) {
        const highVolumeEfficiency = this.calculateAverageSlippageEfficiency(highVolumeRecords);

        if (highVolumeEfficiency > 0.9) {
          // We're using too much slippage for high volume tokens
          optimizedSettings.volumeMultiplier = Math.max(
            0.5,
            optimizedSettings.volumeMultiplier * 0.9
          );
        } else if (highVolumeEfficiency < 0.7) {
          // Not enough slippage discount for high volume tokens
          optimizedSettings.volumeMultiplier = Math.min(
            2.0,
            optimizedSettings.volumeMultiplier * 1.1
          );
        }
      }

      // Update slippage settings if changed
      if (
        optimizedSettings.liquidityMultiplier !==
          this.tradingConfig.slippageSettings.liquidityMultiplier ||
        optimizedSettings.volumeMultiplier !== this.tradingConfig.slippageSettings.volumeMultiplier
      ) {
        this.tradingConfig.slippageSettings = optimizedSettings;

        // Store updated settings
        await this.runtime.setCache('slippage_settings', optimizedSettings);

        logger.info('Optimized slippage parameters', {
          previousSettings: {
            liquidityMultiplier: this.tradingConfig.slippageSettings.liquidityMultiplier,
            volumeMultiplier: this.tradingConfig.slippageSettings.volumeMultiplier,
          },
          optimizedSettings,
        });
      }

      // Update last optimization time
      await this.runtime.setCache('last_slippage_optimization', now);
    } catch (error) {
      logger.error('Error optimizing slippage parameters', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Calculate average slippage efficiency for a set of trade records
   */
  private calculateAverageSlippageEfficiency(records: any[]): number {
    if (records.length === 0) return 0;

    const efficiencies = records.map((record) => {
      // Efficiency = actual slippage / configured slippage
      // Lower value is better (used less of allowed slippage)
      return record.actualSlippageBps / record.slippageBpsUsed;
    });

    // Remove outliers
    const sortedEfficiencies = [...efficiencies].sort((a, b) => a - b);
    const q1Index = Math.floor(sortedEfficiencies.length * 0.25);
    const q3Index = Math.floor(sortedEfficiencies.length * 0.75);
    const q1 = sortedEfficiencies[q1Index];
    const q3 = sortedEfficiencies[q3Index];
    const iqr = q3 - q1;
    const lowerBound = q1 - 1.5 * iqr;
    const upperBound = q3 + 1.5 * iqr;

    const filteredEfficiencies = efficiencies.filter((e) => e >= lowerBound && e <= upperBound);

    // Calculate average of non-outlier values
    return filteredEfficiencies.reduce((sum, val) => sum + val, 0) / filteredEfficiencies.length;
  }

  /**
   * Gets the wallet instance for trading
   */
  private async getWallet() {
    try {
      // This would typically get a wallet from a wallet service or create one
      // For now, we'll assume there's a wallet implementation available
      const privateKey = this.runtime.getSetting('SOLANA_PRIVATE_KEY');
      if (!privateKey) {
        logger.error('No private key available for wallet');
        return null;
      }

      // Create and return wallet instance
      // This is a placeholder - actual implementation would depend on your wallet structure
      return {
        buy: async ({ tokenAddress, amountInSol, slippageBps }) => {
          try {
            // Execute the trade using Jupiter or other DEX
            const result = await executeTrade(this.runtime, {
              tokenAddress,
              amount: amountInSol,
              slippage: slippageBps / 10000, // Convert basis points to decimal
              dex: 'jupiter',
              action: 'BUY',
            });

            return result;
          } catch (error) {
            logger.error('Error executing buy in wallet', error);
            return { success: false, error: error.message };
          }
        },
        sell: async ({ tokenAddress, tokenAmount, slippageBps }) => {
          try {
            // Execute the trade using Jupiter or other DEX
            const result = await executeTrade(this.runtime, {
              tokenAddress,
              amount: tokenAmount,
              slippage: slippageBps / 10000, // Convert basis points to decimal
              dex: 'jupiter',
              action: 'SELL',
            });

            return result;
          } catch (error) {
            logger.error('Error executing sell in wallet', error);
            return { success: false, error: error.message };
          }
        },
      };
    } catch (error) {
      logger.error('Error getting wallet', error);
      return null;
    }
  }

  /**
   * Tracks a position for later management
   */
  private async trackPosition(position: {
    positionId: string;
    tokenAddress: string;
    buyAmount: number;
    tokenAmount: string;
    buySignature: string;
    buyTimestamp: number;
  }) {
    try {
      // Store position in database for tracking
      await this.runtime.createMemory(
        {
          content: {
            data: position,
          },
          metadata: {
            type: 'position',
          },
          agentId: this.runtime.agentId,
          roomId: this.runtime.agentId,
          entityId: this.runtime.agentId,
        },
        'positions'
      );

      logger.info('Position tracked successfully', {
        positionId: position.positionId,
      });
      return true;
    } catch (error) {
      logger.error('Error tracking position', error);
      return false;
    }
  }

  /**
   * Handles sell signal processing
   */
  async handleSellSignal(signal: SellSignalMessage): Promise<{
    success: boolean;
    signature?: string;
    error?: string;
    receivedAmount?: string;
    receivedValue?: string;
  }> {
    const tokenAddress = signal.tokenAddress;

    try {
      // If amount is not specified or is 'auto', calculate it based on confidence
      let sellAmount: bigint;
      if (!signal.amount || signal.amount === 'auto') {
        // Get token balance
        const tokenBalance = await getTokenBalance(this.runtime, tokenAddress);
        if (!tokenBalance || BigInt(tokenBalance.toString()) <= BigInt(0)) {
          return { success: false, error: 'No token balance available' };
        }

        // Calculate sell amount based on confidence (default to medium if not specified)
        const confidence = signal.confidence || 'medium';
        const calculatedAmount = await this.calculateSellAmountWithMarketContext(
          tokenBalance.toString(),
          confidence,
          tokenAddress
        );
        sellAmount = BigInt(calculatedAmount);

        logger.info('Calculated sell amount based on confidence', {
          tokenAddress,
          confidence,
          calculatedAmount: sellAmount.toString(),
        });
      } else {
        sellAmount = BigInt(signal.amount);
      }

      try {
        // Record pending sell
        this.pendingSells[tokenAddress] =
          (this.pendingSells[tokenAddress] || BigInt(0)) + sellAmount;

        // Convert token amount to number for calculations
        const sellAmountNum = Number(sellAmount);

        // Calculate dynamic slippage based on token metrics and trade size
        const slippageBps = Number(
          await this.calculateDynamicSlippage(tokenAddress, sellAmountNum)
        );

        logger.info('Getting quote for sell with dynamic slippage', {
          tokenAddress,
          inputAmount: sellAmount,
          slippageBps,
          dynamicSlippageApplied: true,
        });

        // Get quote
        const _quoteResponse = await this.getQuote({
          inputMint: tokenAddress,
          outputMint: 'So11111111111111111111111111111111111111112',
          amount: sellAmount.toString(),
          walletAddress: signal.walletAddress,
          slippageBps: slippageBps,
        });

        // Get the wallet
        const wallet = await this.getWallet();
        if (!wallet) {
          logger.error('No wallet available for trading');
          return { success: false, error: 'No wallet available' };
        }

        // Execute the sell with type safety
        interface SellResult {
          success: boolean;
          signature?: string;
          error?: string;
          receivedAmount?: string;
          receivedValue?: string;
        }

        const result = (await wallet.sell({
          tokenAddress: tokenAddress,
          tokenAmount: sellAmount.toString(),
          slippageBps: slippageBps,
        })) as SellResult;

        if (result.success && result.signature) {
          logger.info('Sell successful', {
            signature: result.signature,
            receivedAmount: result.receivedAmount || 'unknown',
          });

          return {
            success: true,
            signature: result.signature,
            receivedAmount: result.receivedAmount,
            receivedValue: result.receivedValue,
          };
        }
        logger.error('Sell failed', {
          error: result.error,
        });
        return { success: false, error: result.error };
      } finally {
        // Remove from pending sells whether successful or not
        this.pendingSells[tokenAddress] =
          (this.pendingSells[tokenAddress] || BigInt(0)) - sellAmount;
        if (this.pendingSells[tokenAddress] <= BigInt(0)) {
          delete this.pendingSells[tokenAddress];
        }
      }
    } catch (error) {
      logger.error('Failed to process sell signal:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Creates a task for buying
   */
  async createBuyTask(signal: BuySignalMessage, tradeAmount?: number) {
    try {
      logger.info('Creating buy task:', { signal, tradeAmount });

      // Add expected out amount based on quote
      let expectedOutAmount = null;

      // Only try to get expected amount if we have a trade amount
      if (tradeAmount) {
        try {
          // Get a quote to determine expected amount
          const quoteResponse = await fetch(
            `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${
              signal.tokenAddress
            }&amount=${Math.round(tradeAmount * 1e9)}&slippageBps=0`
          );

          if (quoteResponse.ok) {
            const quoteData = await quoteResponse.json();
            expectedOutAmount = quoteData.outAmount;
          }
        } catch (error) {
          logger.warn('Failed to get expected out amount for buy', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      await this.runtime.createTask({
        id: uuidv4() as UUID,
        roomId: this.runtime.agentId,
        name: 'BUY_SIGNAL',
        description: `Buy token ${signal.tokenAddress}`,
        tags: ['queue', ServiceType.DEGEN_TRADING],
        metadata: {
          signal,
          tradeAmount,
          expectedOutAmount,
          updatedAt: Date.now(),
        },
      });

      logger.info('Buy task created');
    } catch (error) {
      logger.error('Error creating buy task:', error);
    }
  }

  /**
   * Executes a buy task
   */
  private async executeBuyTask() {
    try {
      logger.debug('Executing buy task');

      // Fetch pending buy tasks
      const pendingTasks = await this.runtime.getTasks({
        roomId: this.runtime.agentId,
        tags: [ServiceType.DEGEN_TRADING, 'queue'],
        // We can't filter by name in the getTasks query, so we'll filter manually
      });

      // Find BUY_SIGNAL tasks
      const buyTasks = pendingTasks.filter((task) => task.name === 'BUY_SIGNAL');

      if (buyTasks.length === 0) {
        logger.info('No pending buy tasks found');
        return;
      }

      // Process the first task
      const task = buyTasks[0];

      if (!task.metadata) {
        logger.error('Task metadata is missing');
        return;
      }

      const { signal, tradeAmount, expectedOutAmount } = task.metadata;

      if (!signal || typeof signal !== 'object') {
        logger.error('No valid signal data in buy task');
        return;
      }

      if (!tradeAmount || typeof tradeAmount !== 'number' || tradeAmount <= 0) {
        logger.warn('Invalid trade amount in buy task:', { tradeAmount });
        return;
      }

      // Calculate dynamic slippage based on token metrics and trade size
      const tokenAddress = (signal as BuySignalMessage).tokenAddress;
      if (!tokenAddress) {
        logger.error('Missing token address in signal');
        return;
      }

      const slippageBps = await this.calculateDynamicSlippage(tokenAddress, tradeAmount);

      // Create a complete buy signal with the trade amount
      const buySignal: BuySignalMessage = {
        ...(signal as BuySignalMessage),
      };

      // Execute the buy
      logger.info('Executing buy signal', {
        tokenAddress,
        tradeAmount,
        slippageBps,
        expectedOutAmount,
      });

      const result = await this.handleBuySignal(buySignal);

      if (result.success) {
        // Log the success
        logger.info('Buy successful', {
          signature: result.signature,
          outAmount: result.outAmount,
          swapUsdValue: result.swapUsdValue,
        });

        // Track slippage impact if we have expected and actual amounts
        if (result.outAmount && expectedOutAmount) {
          await this.trackSlippageImpact(
            tokenAddress,
            String(expectedOutAmount),
            result.outAmount,
            slippageBps || 0,
            false // not a sell
          );
        }
      } else {
        // Log the failure
        logger.error('Buy failed', {
          error: result.error,
        });
      }
    } catch (error) {
      logger.error(
        'Error executing buy task:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Creates a task for selling
   */
  async createSellTask(signal: SellSignalMessage) {
    try {
      logger.info('Creating sell task', {
        tokenAddress: signal.tokenAddress,
        amount: signal.amount,
        currentBalance: signal.currentBalance,
      });

      // Fetch expected receive amount (USDC) for this sell
      let expectedReceiveAmount = '0';
      try {
        // Get a quote for the expected amount we'll receive in USDC (So11... is SOL mint)
        const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${signal.tokenAddress}&outputMint=So11111111111111111111111111111111111111112&amount=${Math.round(Number(signal.amount) * 1e9)}&slippageBps=0`;
        const quoteResponse = await fetch(quoteUrl);
        const quoteData = await quoteResponse.json();

        if (quoteData?.outAmount) {
          expectedReceiveAmount = quoteData.outAmount;
          logger.info('Expected receive amount for sell', {
            expectedReceiveAmount,
            tokenAddress: signal.tokenAddress,
          });
        }
      } catch (error) {
        logger.warn('Failed to fetch expected receive amount for sell', error);
      }

      // Calculate slippage synchronously
      const slippage = await this.calculateDynamicSlippage(
        signal.tokenAddress,
        Number(signal.amount)
      );

      const taskId = uuidv4() as UUID;
      await this.runtime.createTask({
        id: taskId,
        name: 'EXECUTE_SELL',
        description: `Execute sell for ${signal.tokenAddress}`,
        tags: ['queue', 'repeat', ServiceType.DEGEN_TRADING],
        metadata: {
          signal,
          expectedReceiveAmount,
          slippageBps: Number(slippage),
        },
      });

      logger.info('Sell task created', { taskId });
      return { success: true, taskId };
    } catch (error) {
      logger.error('Error creating sell task', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Calculate sell amount based on confidence
   */
  private calculateSellAmount(balance: string, confidence: 'low' | 'medium' | 'high'): string {
    try {
      const balanceNum = BigInt(balance);
      let sellPercentage: number;

      // Base percentage based on confidence
      switch (confidence) {
        case 'high':
          sellPercentage = 0.9; // Sell 90% by default for high confidence
          break;
        case 'medium':
          sellPercentage = 0.5; // Sell 50% by default for medium confidence
          break;
        case 'low':
          sellPercentage = 0.25; // Sell 25% by default for low confidence
          break;
        default:
          sellPercentage = 0.1; // Default to 10%
      }

      // Ensure we don't sell more than available
      const sellAmount = (balanceNum * BigInt(Math.floor(sellPercentage * 100))) / BigInt(100);

      // Log the calculation
      logger.info('Calculated sell amount', {
        balance: balance.toString(),
        confidence,
        sellPercentage,
        sellAmount: sellAmount.toString(),
      });

      return sellAmount.toString();
    } catch (error) {
      logger.error('Error calculating sell amount', error);
      // Default to 10% if there's an error
      return ((BigInt(balance) * BigInt(10)) / BigInt(100)).toString();
    }
  }
}
