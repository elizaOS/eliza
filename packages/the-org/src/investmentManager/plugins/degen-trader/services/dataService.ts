import { type AgentRuntime, logger } from '@elizaos/core';
import { CacheManager } from '../utils/cacheManager';
import { PortfolioStatus, TokenSignal } from '../types/trading';
import { getTokenBalance, getWalletBalance } from '../utils/wallet';
import { AnalyticsService } from './analyticsService';
import { BirdeyeService } from './calculation/birdeye';
import { TechnicalAnalysisService } from './calculation/technicalAnalysis';
import { ScoringService } from './calculation/scoring';
import { TokenSecurityService } from './validation/tokenSecurity';
import { TradeCalculationService } from './calculation/tradeCalculation';

export class DataService {
  private cacheManager: CacheManager;
  private birdeyeService: BirdeyeService;
  private analyticsService: AnalyticsService;
  private technicalAnalysisService: TechnicalAnalysisService;
  private scoringService: ScoringService;
  private tokenSecurityService: TokenSecurityService;
  private tradeCalculationService: TradeCalculationService;

  constructor(private runtime: AgentRuntime) {
    this.cacheManager = new CacheManager();
    this.analyticsService = new AnalyticsService(runtime);
    this.technicalAnalysisService = new TechnicalAnalysisService(runtime, this);
    this.scoringService = new ScoringService(runtime, this);
    this.tokenSecurityService = new TokenSecurityService(runtime, this);
    this.tradeCalculationService = new TradeCalculationService(runtime, this);
  }

  async initialize(): Promise<void> {
    logger.info('Initializing data service');
    const apiKey = process.env.BIRDEYE_API_KEY;
    if (!apiKey) {
      throw new Error('Birdeye API key not found');
    }
    this.birdeyeService = new BirdeyeService(apiKey);
  }

  async stop(): Promise<void> {
    await this.cacheManager.clear();
  }

  async getBirdeyeSignals(): Promise<TokenSignal[]> {
    try {
      const trendingTokens = (await this.cacheManager.get<any[]>('birdeye_trending_tokens')) || [];
      return Promise.all(
        trendingTokens.map(async (token) => {
          const marketData = await this.getTokenMarketData(token.address);
          const technicalSignals =
            await this.technicalAnalysisService.calculateTechnicalSignals(marketData);
          return {
            address: token.address,
            symbol: token.symbol,
            marketCap: marketData.marketCap,
            volume24h: marketData.volume24h,
            price: marketData.price,
            liquidity: marketData.liquidity,
            score: 0,
            reasons: [`Trending on Birdeye with ${marketData.volume24h}$ 24h volume`],
            technicalSignals: {
              ...technicalSignals,
              macd: {
                value: technicalSignals.macd.macd,
                signal: technicalSignals.macd.signal,
                histogram: technicalSignals.macd.histogram,
              },
            },
          };
        })
      );
    } catch (error) {
      logger.error('Error getting Birdeye signals:', error);
      return [];
    }
  }

  async getTwitterSignals(): Promise<TokenSignal[]> {
    try {
      const twitterSignals = (await this.cacheManager.get<any[]>('twitter_parsed_signals')) || [];
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

  async getCMCSignals(): Promise<TokenSignal[]> {
    try {
      const cmcTokens = (await this.cacheManager.get<any[]>('cmc_trending_tokens')) || [];
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

  async getTokenMarketData(tokenAddress: string): Promise<{
    price: number;
    marketCap: number;
    liquidity: number;
    volume24h: number;
    priceHistory: number[];
    volumeHistory: number[];
  }> {
    const cacheKey = `market_data_${tokenAddress}`;
    const cached = await this.cacheManager.get<any>(cacheKey);
    if (cached) return cached;

    const result = await this.birdeyeService.getTokenMarketData(tokenAddress);
    await this.cacheManager.set(cacheKey, result, 10 * 60 * 1000);
    return { ...result, volumeHistory: [] };
  }

  async getTokensMarketData(tokenAddresses: string[]): Promise<any> {
    const missing: string[] = [];
    const tokenDb: Record<string, any> = {};

    // Check cache first
    for (const ca of tokenAddresses) {
      const cached = await this.cacheManager.get<any>(`market_data_${ca}`);
      if (!cached) {
        missing.push(ca);
      } else {
        tokenDb[ca] = cached;
      }
    }

    if (missing.length) {
      const newData = await this.birdeyeService.getTokensMarketData(missing);

      // Update cache and tokenDb
      for (const [address, data] of Object.entries(newData)) {
        const cacheKey = `market_data_${address}`;
        await this.cacheManager.set(cacheKey, data, 10 * 60 * 1000);
        tokenDb[address] = data;
      }
    }

    return tokenDb;
  }

  async getMonitoredTokens(): Promise<string[]> {
    try {
      const tasks = await this.runtime.getTasks({
        tags: ['degen_trader', 'EXECUTE_SELL'],
      });

      const tokenAddresses = new Set<string>();
      tasks.forEach((task) => {
        const metadata = task.metadata as { [key: string]: any };
        if (metadata?.signal?.tokenAddress) {
          tokenAddresses.add(metadata.signal.tokenAddress);
        }
      });

      return Array.from(tokenAddresses);
    } catch (error) {
      logger.error('Error getting monitored tokens:', error);
      return [];
    }
  }

  async getPositions(): Promise<any[]> {
    try {
      const monitoredTokens = await this.getMonitoredTokens();

      if (!monitoredTokens.length) {
        return [];
      }

      const positions = await Promise.all(
        monitoredTokens.map(async (tokenAddress) => {
          try {
            const balance = await getTokenBalance(this.runtime, tokenAddress);
            const marketData = await this.getTokenMarketData(tokenAddress);

            return {
              tokenAddress,
              balance,
              currentPrice: marketData.price,
              value: Number(balance?.balance) * marketData.price,
              lastUpdated: new Date().toISOString(),
            };
          } catch (error) {
            logger.error(`Error getting position for token ${tokenAddress}:`, error);
            return null;
          }
        })
      );

      return positions.filter((position) => position !== null);
    } catch (error) {
      logger.error('Error getting positions:', error);
      return [];
    }
  }

  private getDefaultRecommendation() {
    return {
      recommended_buy: 'SOL',
      recommend_buy_address: 'So11111111111111111111111111111111111111112',
      reason: 'Default recommendation',
      marketcap: 0,
      buy_amount: 0.1,
    };
  }
}
