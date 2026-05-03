// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import { Service, IAgentRuntime } from "@elizaos/core";
import {
  cloudServiceApisBaseUrl,
  toRuntimeSettings,
} from "@elizaos/cloud-routing";
import axios, { AxiosInstance } from "axios";
import {
  DexScreenerPair,
  DexScreenerProfile,
  DexScreenerSearchParams,
  DexScreenerTokenParams,
  DexScreenerPairParams,
  DexScreenerTrendingParams,
  DexScreenerChainParams,
  DexScreenerNewPairsParams,
  DexScreenerServiceResponse,
  DexScreenerConfig,
} from "./types";

export class DexScreenerService extends Service {
  static serviceType = "dexscreener" as const;
  private api!: AxiosInstance;
  private dexConfig!: DexScreenerConfig;
  private lastRequestTime = 0;
  public capabilityDescription =
    "Provides DEX analytics and token information from DexScreener";

  /**
   * Start the DexScreenerService with the given runtime.
   * @param {IAgentRuntime} runtime - The runtime for the DexScreenerService.
   * @returns {Promise<Service>} A promise that resolves with the DexScreenerService instance.
   */
  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new DexScreenerService(runtime);

    const customBase = String(
      runtime.getSetting("DEXSCREENER_API_URL") ?? "",
    ).trim();
    const delayRaw = runtime.getSetting("DEXSCREENER_RATE_LIMIT_DELAY");
    const delayParsed = Number.parseInt(
      typeof delayRaw === "number"
        ? String(delayRaw)
        : String(delayRaw ?? "100"),
      10,
    );
    const rateLimitDelay = Number.isFinite(delayParsed) ? delayParsed : 100;

    let apiUrl: string;
    const authHeaders: Record<string, string> = {};

    if (customBase.length > 0) {
      apiUrl = customBase.replace(/\/+$/, "");
    } else {
      const cloud = cloudServiceApisBaseUrl(
        toRuntimeSettings(runtime),
        "dexscreener",
      );
      if (cloud !== null) {
        apiUrl = cloud.baseUrl;
        Object.assign(authHeaders, cloud.headers);
      } else {
        apiUrl = "https://api.dexscreener.com";
      }
    }

    service.dexConfig = {
      apiUrl,
      rateLimitDelay,
    };

    service.api = axios.create({
      baseURL: apiUrl,
      timeout: 10000,
      headers: {
        Accept: "application/json",
        "User-Agent": "ElizaOS-DexScreener-Plugin/1.0",
        ...authHeaders,
      },
    });

    return service;
  }

  async stop(): Promise<void> {
    // Cleanup if needed
    console.log("DexScreener service stopped");
  }

  /**
   * Ensure rate limiting between requests
   */
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.dexConfig.rateLimitDelay!) {
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          this.dexConfig.rateLimitDelay! - timeSinceLastRequest,
        ),
      );
    }
    this.lastRequestTime = Date.now();
  }

  /**
   * Search for tokens/pairs
   */
  async search(
    params: DexScreenerSearchParams,
  ): Promise<DexScreenerServiceResponse<DexScreenerPair[]>> {
    try {
      await this.rateLimit();
      const response = await this.api.get(`/latest/dex/search`, {
        params: { q: params.query },
      });

      return {
        success: true,
        data: response.data.pairs || [],
      };
    } catch (error: any) {
      console.error("DexScreener search error:", error);
      return {
        success: false,
        error:
          error.response?.data?.message ||
          error.message ||
          "Failed to search tokens",
      };
    }
  }

  /**
   * Get token pairs by token address
   */
  async getTokenPairs(
    params: DexScreenerTokenParams,
  ): Promise<DexScreenerServiceResponse<DexScreenerPair[]>> {
    try {
      await this.rateLimit();
      const response = await this.api.get(
        `/latest/dex/tokens/${params.tokenAddress}`,
      );

      return {
        success: true,
        data: response.data.pairs || [],
      };
    } catch (error: any) {
      console.error("DexScreener getTokenPairs error:", error);
      return {
        success: false,
        error:
          error.response?.data?.message ||
          error.message ||
          "Failed to get token pairs",
      };
    }
  }

  /**
   * Get pair by address
   */
  async getPair(
    params: DexScreenerPairParams,
  ): Promise<DexScreenerServiceResponse<DexScreenerPair>> {
    try {
      await this.rateLimit();
      const response = await this.api.get(
        `/latest/dex/pairs/${params.pairAddress}`,
      );

      if (!response.data.pair) {
        return {
          success: false,
          error: "Pair not found",
        };
      }

      return {
        success: true,
        data: response.data.pair,
      };
    } catch (error: any) {
      console.error("DexScreener getPair error:", error);
      return {
        success: false,
        error:
          error.response?.data?.message ||
          error.message ||
          "Failed to get pair",
      };
    }
  }

  /**
   * Get trending pairs
   */
  async getTrending(
    params: DexScreenerTrendingParams = {},
  ): Promise<DexScreenerServiceResponse<DexScreenerPair[]>> {
    try {
      await this.rateLimit();

      // DexScreener doesn't have a direct trending endpoint
      // We'll use the boosted tokens endpoint as a proxy for trending
      const response = await this.api.get(`/token-boosts/top/v1`);

      // The boosted tokens response is an array of boosted tokens
      const boostedTokens = Array.isArray(response.data)
        ? response.data
        : [response.data];

      // For each boosted token, we need to get the actual pair data
      const pairPromises = boostedTokens
        .slice(0, params.limit || 10)
        .map(async (token) => {
          try {
            const pairResponse = await this.api.get(
              `/tokens/v1/${token.chainId}/${token.tokenAddress}`,
            );
            return Array.isArray(pairResponse.data)
              ? pairResponse.data[0]
              : null;
          } catch (error) {
            console.error(
              `Failed to get pair data for ${token.tokenAddress}:`,
              error,
            );
            return null;
          }
        });

      const pairs = (await Promise.all(pairPromises)).filter(
        (pair) => pair !== null,
      );

      return {
        success: true,
        data: pairs,
      };
    } catch (error: any) {
      console.error("DexScreener getTrending error:", error);
      return {
        success: false,
        error:
          error.response?.data?.message ||
          error.message ||
          "Failed to get trending pairs",
      };
    }
  }

  /**
   * Get pairs by chain
   */
  async getPairsByChain(
    params: DexScreenerChainParams,
  ): Promise<DexScreenerServiceResponse<DexScreenerPair[]>> {
    try {
      await this.rateLimit();

      // Use search API with chain filter
      const response = await this.api.get(`/latest/dex/search`, {
        params: {
          q: params.chain, // Search by chain name
        },
      });

      let pairs: DexScreenerPair[] = response.data.pairs || [];

      // Filter to only include pairs from the specified chain
      pairs = pairs.filter(
        (pair) => pair.chainId.toLowerCase() === params.chain.toLowerCase(),
      );

      // Sort by specified criteria
      if (params.sortBy) {
        pairs.sort((a, b) => {
          switch (params.sortBy) {
            case "volume":
              return (b.volume?.h24 || 0) - (a.volume?.h24 || 0);
            case "liquidity":
              return (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0);
            case "priceChange":
              return (b.priceChange?.h24 || 0) - (a.priceChange?.h24 || 0);
            case "txns":
              return (
                (b.txns?.h24.buys + b.txns?.h24.sells || 0) -
                (a.txns?.h24.buys + a.txns?.h24.sells || 0)
              );
            default:
              return 0;
          }
        });
      }

      // Limit results
      const limitedPairs = params.limit
        ? pairs.slice(0, params.limit)
        : pairs.slice(0, 20);

      return {
        success: true,
        data: limitedPairs,
      };
    } catch (error: any) {
      console.error("DexScreener getPairsByChain error:", error);
      return {
        success: false,
        error:
          error.response?.data?.message ||
          error.message ||
          "Failed to get pairs by chain",
      };
    }
  }

  /**
   * Get new pairs
   */
  async getNewPairs(
    params: DexScreenerNewPairsParams = {},
  ): Promise<DexScreenerServiceResponse<DexScreenerPair[]>> {
    try {
      await this.rateLimit();

      // DexScreener doesn't have a direct new pairs endpoint
      // We'll use the latest token profiles as a proxy for new tokens
      const response = await this.api.get(`/token-profiles/latest/v1`);

      // The latest token profiles response is an array of profiles
      const profiles = Array.isArray(response.data)
        ? response.data
        : [response.data];

      // Filter by chain if specified
      const filteredProfiles = params.chain
        ? profiles.filter(
            (p) => p.chainId?.toLowerCase() === params.chain?.toLowerCase(),
          )
        : profiles;

      // For each profile, we need to get the actual pair data
      const pairPromises = filteredProfiles
        .slice(0, params.limit || 10)
        .map(async (profile) => {
          try {
            const pairResponse = await this.api.get(
              `/tokens/v1/${profile.chainId}/${profile.tokenAddress}`,
            );
            const pairs = Array.isArray(pairResponse.data)
              ? pairResponse.data
              : [];
            // Return the first pair with 'new' label
            if (pairs.length > 0) {
              return {
                ...pairs[0],
                labels: pairs[0].labels?.includes("new")
                  ? pairs[0].labels
                  : [...(pairs[0].labels || []), "new"],
              };
            }
            return null;
          } catch (error) {
            console.error(
              `Failed to get pair data for ${profile.tokenAddress}:`,
              error,
            );
            return null;
          }
        });

      const pairs = (await Promise.all(pairPromises)).filter(
        (pair) => pair !== null,
      );

      return {
        success: true,
        data: pairs,
      };
    } catch (error: any) {
      console.error("DexScreener getNewPairs error:", error);
      return {
        success: false,
        error:
          error.response?.data?.message ||
          error.message ||
          "Failed to get new pairs",
      };
    }
  }

  /**
   * Get token profile
   */
  async getTokenProfile(
    tokenAddress: string,
  ): Promise<DexScreenerServiceResponse<DexScreenerProfile>> {
    try {
      await this.rateLimit();
      // Token profiles are available through the latest profiles endpoint
      // We need to fetch all and find the matching one
      const response = await this.api.get(`/token-profiles/latest/v1`);
      const profiles = Array.isArray(response.data)
        ? response.data
        : [response.data];

      const profile = profiles.find(
        (p) => p.tokenAddress?.toLowerCase() === tokenAddress.toLowerCase(),
      );

      if (!profile) {
        return {
          success: false,
          error: "Token profile not found",
        };
      }

      return {
        success: true,
        data: profile,
      };
    } catch (error: any) {
      console.error("DexScreener getTokenProfile error:", error);
      return {
        success: false,
        error:
          error.response?.data?.message ||
          error.message ||
          "Failed to get token profile",
      };
    }
  }

  /**
   * Format price with appropriate decimals
   */
  formatPrice(price: string | number): string {
    const numPrice = typeof price === "string" ? parseFloat(price) : price;
    if (numPrice >= 1) {
      return numPrice.toFixed(2);
    } else if (numPrice >= 0.01) {
      return numPrice.toFixed(4);
    } else {
      return numPrice.toFixed(8);
    }
  }

  /**
   * Format percentage change
   */
  formatPriceChange(change: number): string {
    const sign = change >= 0 ? "+" : "";
    return `${sign}${change.toFixed(2)}%`;
  }

  /**
   * Format volume/liquidity numbers
   */
  formatUsdValue(value: number): string {
    if (value >= 1000000) {
      return `$${(value / 1000000).toFixed(2)}M`;
    } else if (value >= 1000) {
      return `$${(value / 1000).toFixed(2)}K`;
    } else {
      return `$${value.toFixed(2)}`;
    }
  }

  /**
   * Get multiple tokens by addresses (up to 30)
   */
  async getMultipleTokens(
    chainId: string,
    tokenAddresses: string[],
  ): Promise<DexScreenerServiceResponse<DexScreenerPair[]>> {
    try {
      if (tokenAddresses.length > 30) {
        return {
          success: false,
          error: "Maximum 30 token addresses allowed",
        };
      }

      await this.rateLimit();
      const addresses = tokenAddresses.join(",");
      const response = await this.api.get(`/tokens/v1/${chainId}/${addresses}`);

      return {
        success: true,
        data: response.data || [],
      };
    } catch (error: any) {
      console.error("DexScreener getMultipleTokens error:", error);
      return {
        success: false,
        error:
          error.response?.data?.message ||
          error.message ||
          "Failed to get multiple tokens",
      };
    }
  }

  /**
   * Get latest token profiles
   */
  async getLatestTokenProfiles(): Promise<
    DexScreenerServiceResponse<DexScreenerProfile[]>
  > {
    try {
      await this.rateLimit();
      const response = await this.api.get(`/token-profiles/latest/v1`);

      return {
        success: true,
        data: Array.isArray(response.data) ? response.data : [response.data],
      };
    } catch (error: any) {
      console.error("DexScreener getLatestTokenProfiles error:", error);
      return {
        success: false,
        error:
          error.response?.data?.message ||
          error.message ||
          "Failed to get latest token profiles",
      };
    }
  }

  /**
   * Get latest boosted tokens
   */
  async getLatestBoostedTokens(): Promise<DexScreenerServiceResponse<any[]>> {
    try {
      await this.rateLimit();
      const response = await this.api.get(`/token-boosts/latest/v1`);

      return {
        success: true,
        data: Array.isArray(response.data) ? response.data : [response.data],
      };
    } catch (error: any) {
      console.error("DexScreener getLatestBoostedTokens error:", error);
      return {
        success: false,
        error:
          error.response?.data?.message ||
          error.message ||
          "Failed to get latest boosted tokens",
      };
    }
  }

  /**
   * Get top boosted tokens
   */
  async getTopBoostedTokens(): Promise<DexScreenerServiceResponse<any[]>> {
    try {
      await this.rateLimit();
      const response = await this.api.get(`/token-boosts/top/v1`);

      return {
        success: true,
        data: Array.isArray(response.data) ? response.data : [response.data],
      };
    } catch (error: any) {
      console.error("DexScreener getTopBoostedTokens error:", error);
      return {
        success: false,
        error:
          error.response?.data?.message ||
          error.message ||
          "Failed to get top boosted tokens",
      };
    }
  }

  /**
   * Check order status for a token
   */
  async checkOrderStatus(
    chainId: string,
    tokenAddress: string,
  ): Promise<DexScreenerServiceResponse<any[]>> {
    try {
      await this.rateLimit();
      const response = await this.api.get(
        `/orders/v1/${chainId}/${tokenAddress}`,
      );

      return {
        success: true,
        data: response.data || [],
      };
    } catch (error: any) {
      console.error("DexScreener checkOrderStatus error:", error);
      return {
        success: false,
        error:
          error.response?.data?.message ||
          error.message ||
          "Failed to check order status",
      };
    }
  }

  /**
   * Get token pairs by chain and address
   */
  async getTokenPairsByChain(
    chainId: string,
    tokenAddress: string,
  ): Promise<DexScreenerServiceResponse<DexScreenerPair[]>> {
    try {
      await this.rateLimit();
      const response = await this.api.get(
        `/token-pairs/v1/${chainId}/${tokenAddress}`,
      );

      return {
        success: true,
        data: response.data || [],
      };
    } catch (error: any) {
      console.error("DexScreener getTokenPairsByChain error:", error);
      return {
        success: false,
        error:
          error.response?.data?.message ||
          error.message ||
          "Failed to get token pairs by chain",
      };
    }
  }
}
