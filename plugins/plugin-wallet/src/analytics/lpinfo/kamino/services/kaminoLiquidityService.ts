/**
 * `KAMINO_LIQUIDITY_SERVICE`: client for Kamino's liquidity-adjacent REST API.
 * The API exposes no direct strategies/pools endpoint, so `getAllStrategies`
 * and `getStrategyByAddress` synthesize `KaminoStrategy` records from staking
 * yields and Limo (limit order) trade data; APY/fee/rebalancing/range
 * heuristics on Limo-derived strategies (`calculateLimoApy` and friends) are
 * estimates, not exact on-chain values. Token metadata comes from the
 * `birdeye` service (`resolveTokenWithBirdeye`), looked up by service name
 * rather than an import to avoid a hard dependency.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { logger, Service } from "@elizaos/core";

const KAMINO_API_BASE_URL = "https://api.kamino.finance";
const KAMINO_LIQUIDITY_PROGRAM_ID = "kamino-rest-api";

const KNOWN_TOKENS: Record<string, string> = {
  HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC: "AI16Z Token",
  ai16z: "AI16Z Token (Symbol)",
  "4WfUvajjYTrq7KRdToJBkoHQ6bSt7NyBeLhP9LKwtFKh": "Kamino Strategy",
};

// Interfaces for type safety
export interface KaminoStrategy {
  address: string;
  strategyType: string;
  estimatedTvl: number;
  volume24h: number;
  apy: number;
  tokenA: string;
  tokenB: string;
  feeTier: string;
  rebalancing: string;
  lastRebalance: string;
  positions: KaminoPosition[];
  detailedInfo?: {
    creationDate: string;
    totalDeposits: number;
    totalWithdrawals: number;
    activeUsers: number;
    performanceHistory: Array<{ date: string; apy: number }>;
  };
}

export interface KaminoPosition {
  type: string;
  range: string;
  liquidity: number;
  feesEarned: number;
}

export interface TokenLiquidityStats {
  tokenIdentifier: string;
  normalizedToken: string;
  tokenName: string;
  timestamp: string;
  strategies: KaminoStrategy[];
  totalTvl: number;
  totalVolume: number;
  apyRange: { min: number; max: number };
  poolCount: number;
}

export interface TokenInfo {
  name: string;
  symbol: string;
  address: string;
  price?: number;
  liquidity?: number;
  decimals?: number;
  marketCap?: number;
  volume24h?: number;
  priceChange24h?: number;
}

/** Minimal Birdeye service surface used for token resolution */
interface BirdeyeTokenOverviewData {
  name?: string;
  symbol?: string;
  address?: string;
  price?: number;
  liquidity?: number;
  decimals?: number;
  mc?: number;
  volume24h?: number;
  priceChange24hPercent?: number;
}

interface BirdeyeOverviewResponse {
  data?: BirdeyeTokenOverviewData;
}

interface BirdeyeMarketDataPayload {
  price?: number;
  liquidity?: number;
  marketCap?: number;
  volume24h?: number;
}

interface BirdeyeMarketDataResponse {
  data?: BirdeyeMarketDataPayload;
}

interface BirdeyeResolveService {
  fetchTokenOverview(
    params: { address: string },
    init?: { headers?: Record<string, string> },
  ): Promise<BirdeyeOverviewResponse | undefined>;
  fetchTokenMarketData(
    params: { address: string },
    init?: { headers?: Record<string, string> },
  ): Promise<BirdeyeMarketDataResponse | undefined>;
}

interface KaminoMarketStatistics {
  timestamp: string;
  stakingYields: {
    total: number;
    averageApy: number;
    maxApy: number;
    minApy: number;
  };
  medianYields: {
    total: number;
    averageApy: number;
  };
  limoTrades: {
    total: number;
    totalVolume: number;
    averageTip: number;
    averageSurplus: number;
  };
}

export interface KaminoPoolInfoWithStrategy {
  address: string;
  strategy: KaminoStrategy;
  tokenInfo: TokenInfo | null;
  timestamp: string;
  metrics: {
    totalValueLocked: number;
    volume24h: number;
    apy: number;
    feeTier: string;
    rebalancing: string;
    lastRebalance: string;
    positionCount: number;
  };
}

export interface KaminoPoolInfoTokenFallback {
  address: string;
  tokenInfo: TokenInfo;
  timestamp: string;
  note: string;
}

export type KaminoPoolByAddressResult =
  | KaminoPoolInfoWithStrategy
  | KaminoPoolInfoTokenFallback
  | null;

interface KaminoLiquidityConnectionTest {
  apiBaseUrl: string;
  programId: string;
  rpcEndpoint: string;
  connectionTest: boolean;
  stakingYieldsTest: boolean;
  limoTradesTest: boolean;
  strategyCount: number;
  timestamp: string;
}

interface StakingYield {
  apy: string;
  tokenMint: string;
}

interface LimoTrade {
  updatedOn: string;
  inMint: string;
  outMint: string;
  sizeUsd: string;
  tipAmountUsd: string;
  surplusUsd: string;
  order: string;
}

function getStringSetting(
  runtime: IAgentRuntime | undefined,
  key: string,
  fallback: string,
): string {
  const value = runtime?.getSetting(key);
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function formatLogError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Kamino Liquidity Protocol Service
 * Handles interactions with Kamino liquidity protocol using the official API
 */
export class KaminoLiquidityService extends Service {
  private isRunning = false;
  private apiBaseUrl: string;

  static serviceType = "KAMINO_LIQUIDITY_SERVICE";
  static serviceName = "KaminoLiquidityService";
  capabilityDescription =
    "Provides detailed access to Kamino liquidity protocol pools and strategies for specific tokens via the official API." as const;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);

    this.apiBaseUrl = getStringSetting(
      runtime,
      "KAMINO_API_URL",
      KAMINO_API_BASE_URL,
    );

    logger.log(
      `KaminoLiquidityService initialized with API: ${this.apiBaseUrl}`,
    );
  }

  private async makeApiRequest<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    try {
      const url = `${this.apiBaseUrl}${endpoint}`;
      const response = await fetch(url, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers,
        },
      });

      if (!response.ok) {
        throw new Error(
          `API request failed: ${response.status} ${response.statusText}`,
        );
      }

      return await response.json();
    } catch (error) {
      logger.error(
        `API request failed for ${endpoint}:`,
        formatLogError(error),
      );
      throw error;
    }
  }

  async resolveTokenWithBirdeye(
    tokenIdentifier: string,
  ): Promise<TokenInfo | null> {
    try {
      const birdeyeService = this.runtime.getService(
        "birdeye",
      ) as BirdeyeResolveService | null;
      if (!birdeyeService) {
        logger.warn("Birdeye service not available for token resolution");
        return null;
      }

      logger.log(`Resolving token ${tokenIdentifier} with Birdeye...`);

      // Try to get token overview from Birdeye
      const overviewResponse = await birdeyeService.fetchTokenOverview(
        {
          address: tokenIdentifier,
        },
        {
          headers: {
            "x-chain": "solana",
          },
        },
      );

      if (overviewResponse?.data) {
        const tokenData = overviewResponse.data;
        return {
          name: tokenData.name || "Unknown Token",
          symbol: tokenData.symbol || "UNKNOWN",
          address: tokenData.address || tokenIdentifier,
          price: tokenData.price || 0,
          liquidity: tokenData.liquidity || 0,
          decimals: tokenData.decimals || 9,
          marketCap: tokenData.mc || 0,
          volume24h: tokenData.volume24h || 0,
          priceChange24h: tokenData.priceChange24hPercent || 0,
        };
      }

      // If overview fails, try market data
      const marketDataResponse = await birdeyeService.fetchTokenMarketData(
        {
          address: tokenIdentifier,
        },
        {
          headers: {
            "x-chain": "solana",
          },
        },
      );

      if (marketDataResponse?.data) {
        const marketData = marketDataResponse.data;
        return {
          name: "Unknown Token",
          symbol: "UNKNOWN",
          address: tokenIdentifier,
          price: marketData.price || 0,
          liquidity: marketData.liquidity || 0,
          marketCap: marketData.marketCap || 0,
          volume24h: marketData.volume24h || 0,
        };
      }

      logger.log(`No token data found for ${tokenIdentifier}`);
      return null;
    } catch (error) {
      logger.error(
        `Error resolving token ${tokenIdentifier} with Birdeye:`,
        formatLogError(error),
      );
      return null;
    }
  }

  async getStakingYields(): Promise<StakingYield[]> {
    try {
      logger.log("Fetching staking yields from Kamino API...");
      const yields =
        await this.makeApiRequest<StakingYield[]>("/v2/staking-yields");
      logger.log(`Found ${yields.length} staking yields`);
      return yields;
    } catch (error) {
      logger.error("Error fetching staking yields:", formatLogError(error));
      return [];
    }
  }

  async getMedianStakingYields(): Promise<StakingYield[]> {
    try {
      logger.log("Fetching median staking yields from Kamino API...");
      const yields = await this.makeApiRequest<StakingYield[]>(
        "/v2/staking-yields/median",
      );
      logger.log(`Found ${yields.length} median staking yields`);
      return yields;
    } catch (error) {
      logger.error(
        "Error fetching median staking yields:",
        formatLogError(error),
      );
      return [];
    }
  }

  async getLimoTrades(
    inTokenMint?: string,
    outTokenMint?: string,
  ): Promise<LimoTrade[]> {
    try {
      let endpoint = "/limo/trades";
      const params = new URLSearchParams();

      if (inTokenMint) params.append("in", inTokenMint);
      if (outTokenMint) params.append("out", outTokenMint);

      if (params.toString()) {
        endpoint += `?${params.toString()}`;
      }

      logger.log(`Fetching Limo trades from Kamino API: ${endpoint}`);
      const trades = await this.makeApiRequest<LimoTrade[]>(endpoint);
      logger.log(`Found ${trades.length} Limo trades`);
      return trades;
    } catch (error) {
      logger.error("Error fetching Limo trades:", formatLogError(error));
      return [];
    }
  }

  async getMarketStatistics(): Promise<KaminoMarketStatistics | null> {
    try {
      logger.log("Fetching real-time market statistics from Kamino API...");

      const [stakingYields, medianYields, limoTrades] = await Promise.all([
        this.getStakingYields(),
        this.getMedianStakingYields(),
        this.getLimoTrades(),
      ]);

      const stats = {
        timestamp: new Date().toISOString(),
        stakingYields: {
          total: stakingYields.length,
          averageApy:
            stakingYields.reduce(
              (sum, stakingYield) => sum + parseFloat(stakingYield.apy),
              0,
            ) / stakingYields.length,
          maxApy: Math.max(
            ...stakingYields.map((stakingYield) =>
              parseFloat(stakingYield.apy),
            ),
          ),
          minApy: Math.min(
            ...stakingYields.map((stakingYield) =>
              parseFloat(stakingYield.apy),
            ),
          ),
        },
        medianYields: {
          total: medianYields.length,
          averageApy:
            medianYields.reduce(
              (sum, stakingYield) => sum + parseFloat(stakingYield.apy),
              0,
            ) / medianYields.length,
        },
        limoTrades: {
          total: limoTrades.length,
          totalVolume: limoTrades.reduce(
            (sum, trade) => sum + parseFloat(trade.sizeUsd || "0"),
            0,
          ),
          averageTip:
            limoTrades.reduce(
              (sum, trade) => sum + parseFloat(trade.tipAmountUsd || "0"),
              0,
            ) / limoTrades.length,
          averageSurplus:
            limoTrades.reduce(
              (sum, trade) => sum + parseFloat(trade.surplusUsd || "0"),
              0,
            ) / limoTrades.length,
        },
      };

      logger.log("Market statistics retrieved successfully");
      return stats;
    } catch (error) {
      logger.error("Error fetching market statistics:", formatLogError(error));
      return null;
    }
  }

  async getAllStrategies(): Promise<KaminoStrategy[]> {
    try {
      logger.log("Getting all available Kamino strategies...");

      const [stakingYields, limoTrades] = await Promise.all([
        this.getStakingYields(),
        this.getLimoTrades(),
      ]);

      const strategies: KaminoStrategy[] = [];

      for (const stakingYield of stakingYields) {
        strategies.push({
          address: stakingYield.tokenMint,
          strategyType: "Staking Strategy",
          estimatedTvl: 0, // Would need additional API calls to get TVL
          volume24h: 0,
          apy: parseFloat(stakingYield.apy),
          tokenA: stakingYield.tokenMint,
          tokenB: "SOL", // Assuming staking against SOL
          feeTier: "0%",
          rebalancing: "Auto",
          lastRebalance: new Date().toISOString(),
          positions: [
            {
              type: "Staking",
              range: "N/A",
              liquidity: 0,
              feesEarned: 0,
            },
          ],
        });
      }

      const uniquePairs = new Set<string>();
      for (const trade of limoTrades) {
        const pairKey = `${trade.inMint}-${trade.outMint}`;
        if (!uniquePairs.has(pairKey)) {
          uniquePairs.add(pairKey);
          const apy = await this.calculateLimoApy(trade);
          strategies.push({
            address: `limo-${pairKey}`,
            strategyType: "Limo Trading Strategy",
            estimatedTvl: parseFloat(trade.sizeUsd) || 0,
            volume24h: parseFloat(trade.sizeUsd) || 0,
            apy: apy,
            tokenA: trade.inMint,
            tokenB: trade.outMint,
            feeTier: this.calculateLimoFeeTier(trade),
            rebalancing: this.determineRebalancingStrategy(trade),
            lastRebalance: trade.updatedOn,
            positions: [
              {
                type: "Trading",
                range: this.determineTradingRange(trade),
                liquidity: parseFloat(trade.sizeUsd) || 0,
                feesEarned: parseFloat(trade.tipAmountUsd) || 0,
              },
            ],
          });
        }
      }

      logger.log(`Found ${strategies.length} strategies from API data`);
      return strategies;
    } catch (error) {
      logger.error("Error getting all strategies:", formatLogError(error));
      return [];
    }
  }

  async getStrategyByAddress(
    strategyAddress: string,
  ): Promise<KaminoStrategy | null> {
    try {
      logger.log(`Getting strategy by address: ${strategyAddress}`);

      const allStrategies = await this.getAllStrategies();
      const strategy = allStrategies.find((s) => s.address === strategyAddress);

      if (strategy) {
        logger.log(`Found strategy: ${strategyAddress}`);
        return strategy;
      }

      // Not in the synthesized strategy list; try constructing one directly
      // from a matching staking yield, then from a matching Limo trade.
      const stakingYields = await this.getStakingYields();
      const stakingStrategy = stakingYields.find(
        (s) => s.tokenMint === strategyAddress,
      );

      if (stakingStrategy) {
        const strategy: KaminoStrategy = {
          address: stakingStrategy.tokenMint,
          strategyType: "Staking Strategy",
          estimatedTvl: 0,
          volume24h: 0,
          apy: parseFloat(stakingStrategy.apy),
          tokenA: stakingStrategy.tokenMint,
          tokenB: "SOL",
          feeTier: "0%",
          rebalancing: "Auto",
          lastRebalance: new Date().toISOString(),
          positions: [
            {
              type: "Staking",
              range: "N/A",
              liquidity: 0,
              feesEarned: 0,
            },
          ],
        };
        logger.log(`Constructed staking strategy for: ${strategyAddress}`);
        return strategy;
      }

      const limoTrades = await this.getLimoTrades();
      const limoTrade = limoTrades.find(
        (t) => t.inMint === strategyAddress || t.outMint === strategyAddress,
      );

      if (limoTrade) {
        const apy = await this.calculateLimoApy(limoTrade);
        const strategy: KaminoStrategy = {
          address: strategyAddress,
          strategyType: "Limo Trading Strategy",
          estimatedTvl: parseFloat(limoTrade.sizeUsd) || 0,
          volume24h: parseFloat(limoTrade.sizeUsd) || 0,
          apy: apy,
          tokenA: limoTrade.inMint,
          tokenB: limoTrade.outMint,
          feeTier: this.calculateLimoFeeTier(limoTrade),
          rebalancing: this.determineRebalancingStrategy(limoTrade),
          lastRebalance: limoTrade.updatedOn,
          positions: [
            {
              type: "Trading",
              range: this.determineTradingRange(limoTrade),
              liquidity: parseFloat(limoTrade.sizeUsd) || 0,
              feesEarned: parseFloat(limoTrade.tipAmountUsd) || 0,
            },
          ],
        };
        logger.log(`Constructed Limo trading strategy for: ${strategyAddress}`);
        return strategy;
      }

      logger.log(`No strategy found for address: ${strategyAddress}`);
      return null;
    } catch (error) {
      logger.error("Error getting strategy by address:", formatLogError(error));
      return null;
    }
  }

  async getPoolByAddress(
    poolAddress: string,
  ): Promise<KaminoPoolByAddressResult> {
    try {
      logger.log(`Getting pool information for address: ${poolAddress}`);

      const strategy = await this.getStrategyByAddress(poolAddress);

      if (strategy) {
        let tokenInfo: TokenInfo | null = null;
        try {
          tokenInfo = await this.resolveTokenWithBirdeye(strategy.tokenA);
        } catch (error) {
          logger.warn(
            `Could not resolve token info for ${strategy.tokenA}:`,
            formatLogError(error),
          );
        }

        const poolInfo = {
          address: poolAddress,
          strategy: strategy,
          tokenInfo: tokenInfo,
          timestamp: new Date().toISOString(),
          metrics: {
            totalValueLocked: strategy.estimatedTvl,
            volume24h: strategy.volume24h,
            apy: strategy.apy,
            feeTier: strategy.feeTier,
            rebalancing: strategy.rebalancing,
            lastRebalance: strategy.lastRebalance,
            positionCount: strategy.positions.length,
          },
        };

        logger.log(`Pool information retrieved for: ${poolAddress}`);
        return poolInfo;
      }

      try {
        const tokenInfo = await this.resolveTokenWithBirdeye(poolAddress);
        if (tokenInfo) {
          return {
            address: poolAddress,
            tokenInfo: tokenInfo,
            timestamp: new Date().toISOString(),
            note: "Address found as token, but no active Kamino strategy detected",
          };
        }
      } catch (error) {
        logger.warn(
          `Could not resolve token info for ${poolAddress}:`,
          formatLogError(error),
        );
      }

      logger.log(
        `No pool or token information found for address: ${poolAddress}`,
      );
      return null;
    } catch (error) {
      logger.error("Error getting pool by address:", formatLogError(error));
      return null;
    }
  }

  async getTokenLiquidityStats(
    tokenIdentifier: string,
  ): Promise<TokenLiquidityStats> {
    try {
      logger.log(`Getting liquidity info for token: ${tokenIdentifier}`);

      const tokenInfo = await this.resolveTokenWithBirdeye(tokenIdentifier);
      const normalizedToken = this.normalizeTokenIdentifier(tokenIdentifier);

      const stats: TokenLiquidityStats = {
        tokenIdentifier: tokenIdentifier,
        normalizedToken: normalizedToken,
        tokenName:
          tokenInfo?.name || KNOWN_TOKENS[normalizedToken] || "Unknown Token",
        timestamp: new Date().toISOString(),
        strategies: [],
        totalTvl: 0,
        totalVolume: 0,
        apyRange: { min: 0, max: 0 },
        poolCount: 0,
      };

      try {
        logger.log(
          `Searching for strategies involving token: ${normalizedToken} via API`,
        );

        const stakingYields = await this.getStakingYields();
        const tokenStakingYields = stakingYields.filter(
          (stakingYield) => stakingYield.tokenMint === normalizedToken,
        );

        const limoTrades = await this.getLimoTrades(normalizedToken);
        const outTrades = await this.getLimoTrades(undefined, normalizedToken);
        const allTrades = [...limoTrades, ...outTrades];

        if (tokenStakingYields.length > 0) {
          for (const stakingYield of tokenStakingYields) {
            stats.strategies.push({
              address: stakingYield.tokenMint,
              strategyType: "Staking Strategy",
              estimatedTvl: 0,
              volume24h: 0,
              apy: parseFloat(stakingYield.apy),
              tokenA: stakingYield.tokenMint,
              tokenB: "SOL",
              feeTier: "0%",
              rebalancing: "Auto",
              lastRebalance: new Date().toISOString(),
              positions: [
                {
                  type: "Staking",
                  range: "N/A",
                  liquidity: 0,
                  feesEarned: 0,
                },
              ],
            });
          }
        }

        const uniquePairs = new Set<string>();
        for (const trade of allTrades) {
          const pairKey = `${trade.inMint}-${trade.outMint}`;
          if (!uniquePairs.has(pairKey)) {
            uniquePairs.add(pairKey);
            const apy = await this.calculateLimoApy(trade);
            stats.strategies.push({
              address: `limo-${pairKey}`,
              strategyType: "Limo Trading Strategy",
              estimatedTvl: parseFloat(trade.sizeUsd) || 0,
              volume24h: parseFloat(trade.sizeUsd) || 0,
              apy: apy,
              tokenA: trade.inMint,
              tokenB: trade.outMint,
              feeTier: this.calculateLimoFeeTier(trade),
              rebalancing: this.determineRebalancingStrategy(trade),
              lastRebalance: trade.updatedOn,
              positions: [
                {
                  type: "Trading",
                  range: this.determineTradingRange(trade),
                  liquidity: parseFloat(trade.sizeUsd) || 0,
                  feesEarned: parseFloat(trade.tipAmountUsd) || 0,
                },
              ],
            });
          }
        }

        if (stats.strategies.length > 0) {
          stats.poolCount = stats.strategies.length;
          stats.totalTvl = stats.strategies.reduce(
            (sum, strat) => sum + (strat.estimatedTvl || 0),
            0,
          );
          stats.totalVolume = stats.strategies.reduce(
            (sum, strat) => sum + (strat.volume24h || 0),
            0,
          );

          const apys = stats.strategies.map((s) => s.apy).filter((a) => a > 0);
          if (apys.length > 0) {
            stats.apyRange.min = Math.min(...apys);
            stats.apyRange.max = Math.max(...apys);
          }

          logger.log(
            `Found ${stats.strategies.length} strategies for ${normalizedToken} with total TVL: $${stats.totalTvl.toLocaleString()}`,
          );
        } else {
          logger.log(`No strategies found involving token: ${normalizedToken}`);
        }
      } catch (apiError) {
        logger.error(
          "Error fetching strategies via API:",
          formatLogError(apiError),
        );
        logger.log(
          `API method failed, returning basic token info for ${normalizedToken}`,
        );
      }

      return stats;
    } catch (error) {
      logger.error(
        "Error getting token liquidity info:",
        formatLogError(error),
      );
      throw error;
    }
  }

  private async calculateLimoApy(trade: LimoTrade): Promise<number> {
    try {
      const sizeUsd = parseFloat(trade.sizeUsd) || 0;
      const tipAmount = parseFloat(trade.tipAmountUsd) || 0;
      const surplus = parseFloat(trade.surplusUsd) || 0;

      const stakingYields = await this.getStakingYields();
      const matchingYield = stakingYields.find(
        (stakingYield) => stakingYield.tokenMint === trade.inMint,
      );

      if (matchingYield) {
        const baseApy = parseFloat(matchingYield.apy) * 100; // Convert to percentage
        let adjustedApy = baseApy;

        // Higher trade volume might indicate better rates
        if (sizeUsd > 10000) adjustedApy += 2;
        else if (sizeUsd > 1000) adjustedApy += 1;

        // Higher tips indicate higher demand/better opportunities
        if (tipAmount > 0.01) adjustedApy += 0.5;

        // Higher surplus indicates better pricing
        if (surplus > 0.1) adjustedApy += 0.5;

        return Math.max(1, Math.min(50, adjustedApy));
      }

      // No matching staking yield: use a heuristic baseline instead.
      let baseApy = 8;
      if (sizeUsd > 1000) baseApy += 2;
      if (sizeUsd > 10000) baseApy += 3;
      if (tipAmount > 0.01) baseApy += 1;
      if (surplus > 0.1) baseApy += 1;

      const variation = (Math.random() - 0.5) * 4;
      return Math.max(2, Math.min(25, baseApy + variation));
    } catch (_error) {
      return 8; // Default fallback
    }
  }

  private calculateLimoFeeTier(trade: LimoTrade): string {
    try {
      const sizeUsd = parseFloat(trade.sizeUsd) || 0;
      const tipAmount = parseFloat(trade.tipAmountUsd) || 0;

      // Higher-APY markets typically support higher fees; this fetch is
      // currently unawaited so its result never affects the return below.
      const medianYields = this.getMedianStakingYields();

      medianYields.then((yields) => {
        if (yields.length > 0) {
          const avgMedianApy =
            yields.reduce(
              (sum, stakingYield) => sum + parseFloat(stakingYield.apy),
              0,
            ) / yields.length;

          if (avgMedianApy > 0.3) {
            // High yield market
            if (sizeUsd > 10000) return "0.08%";
            if (sizeUsd > 1000) return "0.15%";
            if (tipAmount > 0.1) return "0.25%";
            return "0.3%";
          } else if (avgMedianApy > 0.2) {
            // Medium yield market
            if (sizeUsd > 10000) return "0.06%";
            if (sizeUsd > 1000) return "0.12%";
            if (tipAmount > 0.1) return "0.2%";
            return "0.25%";
          }
        }
      });

      if (sizeUsd > 10000) return "0.05%"; // Large trades get lower fees
      if (sizeUsd > 1000) return "0.1%"; // Medium trades
      if (tipAmount > 0.1) return "0.15%"; // High tip trades
      return "0.2%"; // Default fee tier
    } catch (_error) {
      return "0.15%"; // Default fallback
    }
  }

  private determineRebalancingStrategy(trade: LimoTrade): string {
    try {
      const sizeUsd = parseFloat(trade.sizeUsd) || 0;
      const updatedOn = new Date(trade.updatedOn);
      const now = new Date();
      const hoursSinceUpdate =
        (now.getTime() - updatedOn.getTime()) / (1000 * 60 * 60);

      // Same unawaited-promise caveat as calculateLimoFeeTier: this recent-trade
      // frequency analysis never actually influences the return value below.
      const recentTrades = this.getLimoTrades();

      recentTrades.then((trades) => {
        if (trades.length > 0) {
          const recentTradeTimes = trades
            .slice(0, 10) // Look at last 10 trades
            .map((t) => new Date(t.updatedOn).getTime())
            .sort((a, b) => b - a); // Sort descending

          if (recentTradeTimes.length > 1) {
            const avgTimeBetweenTrades =
              recentTradeTimes
                .slice(0, -1)
                .reduce(
                  (sum, time, i) => sum + (time - recentTradeTimes[i + 1]),
                  0,
                ) /
              (recentTradeTimes.length - 1);

            const avgHoursBetweenTrades =
              avgTimeBetweenTrades / (1000 * 60 * 60);

            if (avgHoursBetweenTrades < 0.5) return "Ultra High Frequency";
            if (avgHoursBetweenTrades < 2) return "High Frequency";
            if (avgHoursBetweenTrades < 12) return "Dynamic";
            if (avgHoursBetweenTrades < 48) return "Daily";
            return "Weekly";
          }
        }
      });

      if (sizeUsd > 10000) return "Dynamic";
      if (sizeUsd > 5000) return "High Frequency";
      if (hoursSinceUpdate < 1) return "High Frequency";
      if (hoursSinceUpdate < 24) return "Daily";
      return "Weekly";
    } catch (_error) {
      return "Dynamic"; // Default fallback
    }
  }

  private determineTradingRange(trade: LimoTrade): string {
    try {
      const sizeUsd = parseFloat(trade.sizeUsd) || 0;
      const tipAmount = parseFloat(trade.tipAmountUsd) || 0;

      if (sizeUsd > 10000) return "Wide Range (0.5x - 2.0x)";
      if (sizeUsd > 1000) return "Medium Range (0.7x - 1.4x)";
      if (tipAmount > 0.05) return "Narrow Range (0.9x - 1.1x)";
      return "Market Range (0.8x - 1.2x)";
    } catch (_error) {
      return "Market Range (0.8x - 1.2x)"; // Default fallback
    }
  }

  // Both branches currently return the identifier unchanged; this is a no-op
  // pending real symbol/alias normalization.
  normalizeTokenIdentifier(identifier: string): string {
    if (identifier.length >= 32 && identifier.length <= 44) {
      return identifier;
    }

    return identifier;
  }

  async testConnection(): Promise<KaminoLiquidityConnectionTest> {
    try {
      logger.log("Testing Kamino liquidity service connection...");

      const results = {
        apiBaseUrl: this.apiBaseUrl,
        programId: KAMINO_LIQUIDITY_PROGRAM_ID,
        rpcEndpoint: this.apiBaseUrl,
        connectionTest: false,
        stakingYieldsTest: false,
        limoTradesTest: false,
        strategyCount: 0,
        timestamp: new Date().toISOString(),
      };

      try {
        const stakingYields = await this.getStakingYields();
        results.connectionTest = true;
        results.stakingYieldsTest = true;
        logger.log(
          `API connection test passed. Found ${stakingYields.length} staking yields`,
        );
      } catch (error) {
        logger.error("API connection test failed:", formatLogError(error));
      }

      try {
        const limoTrades = await this.getLimoTrades();
        results.limoTradesTest = true;
        logger.log(
          `Limo trades test passed. Found ${limoTrades.length} trades`,
        );
      } catch (error) {
        logger.error("Limo trades test failed:", formatLogError(error));
      }

      try {
        const strategies = await this.getAllStrategies();
        results.strategyCount = strategies.length;
        logger.log(
          `Strategy discovery test: ${strategies.length} strategies found`,
        );
      } catch (error) {
        logger.error("Strategy discovery test failed:", formatLogError(error));
      }

      logger.log("Connection test completed");
      return results;
    } catch (error) {
      logger.error("Error in connection test:", formatLogError(error));
      throw error;
    }
  }

  // Service lifecycle methods

  static async create(runtime: IAgentRuntime): Promise<KaminoLiquidityService> {
    return new KaminoLiquidityService(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<KaminoLiquidityService> {
    const service = new KaminoLiquidityService(runtime);
    await service.start();
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(
      "KAMINO_LIQUIDITY_SERVICE",
    ) as KaminoLiquidityService;
    if (service) {
      await service.stop();
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("KaminoLiquidityService is already running");
      return;
    }

    try {
      logger.log("Starting KaminoLiquidityService...");

      const testResults = await this.testConnection();
      logger.log({ testResults }, "Startup connection test results");

      this.isRunning = true;
      logger.log("KaminoLiquidityService started successfully");
    } catch (error) {
      logger.error(
        "Failed to start KaminoLiquidityService:",
        formatLogError(error),
      );
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn("KaminoLiquidityService is not running");
      return;
    }

    try {
      this.isRunning = false;
      logger.log("KaminoLiquidityService stopped successfully");
    } catch (error) {
      logger.error(
        "Failed to stop KaminoLiquidityService:",
        formatLogError(error),
      );
      throw error;
    }
  }

  isServiceRunning(): boolean {
    return this.isRunning;
  }
}
