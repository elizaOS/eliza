import {
  cloudServiceApisBaseUrl,
  toRuntimeSettings,
} from "@elizaos/cloud-routing";
import { type IAgentRuntime, Service } from "@elizaos/core";
import { dexScreenerErrorMessage } from "./errors";
import type {
  DexScreenerBoostedToken,
  DexScreenerChainParams,
  DexScreenerConfig,
  DexScreenerNewPairsParams,
  DexScreenerOrder,
  DexScreenerPair,
  DexScreenerPairParams,
  DexScreenerProfile,
  DexScreenerSearchParams,
  DexScreenerServiceResponse,
  DexScreenerTokenParams,
  DexScreenerTrendingParams,
} from "./types";

type DexScreenerBoostedWire = DexScreenerBoostedToken & {
  labels?: string[];
};

type TokensV1Wire = DexScreenerPair | DexScreenerPair[];

export class DexScreenerService extends Service {
  static serviceType = "dexscreener" as const;
  private baseUrl!: string;
  private defaultHeaders!: Record<string, string>;
  private dexConfig!: DexScreenerConfig;
  private lastRequestTime = 0;
  public capabilityDescription =
    "Provides DEX analytics and token information from DexScreener";

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

    service.baseUrl = apiUrl;
    service.defaultHeaders = {
      Accept: "application/json",
      "User-Agent": "ElizaOS-DexScreener-Plugin/1.0",
      ...authHeaders,
    };

    return service;
  }

  async stop(): Promise<void> {
    // Cleanup if needed
    console.log("DexScreener service stopped");
  }

  private async get<T>(
    path: string,
    params?: Record<string, string>,
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    if (params && Object.keys(params).length > 0) {
      url += `?${new URLSearchParams(params).toString()}`;
    }
    const response = await fetch(url, { headers: this.defaultHeaders });
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw Object.assign(
        new Error(errData?.message || `HTTP ${response.status}`),
        {
          response: { data: errData },
        },
      );
    }
    return response.json() as Promise<T>;
  }

  private async rateLimit(): Promise<void> {
    const delayMs = this.dexConfig.rateLimitDelay ?? 100;
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < delayMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, delayMs - timeSinceLastRequest),
      );
    }
    this.lastRequestTime = Date.now();
  }

  async search(
    params: DexScreenerSearchParams,
  ): Promise<DexScreenerServiceResponse<DexScreenerPair[]>> {
    try {
      await this.rateLimit();
      const data = await this.get<{ pairs?: DexScreenerPair[] }>(
        `/latest/dex/search`,
        { q: params.query },
      );

      return {
        success: true,
        data: data.pairs || [],
      };
    } catch (caught: unknown) {
      console.error("DexScreener search error:", caught);
      return {
        success: false,
        error: dexScreenerErrorMessage(caught) || "Failed to search tokens",
      };
    }
  }

  async getTokenPairs(
    params: DexScreenerTokenParams,
  ): Promise<DexScreenerServiceResponse<DexScreenerPair[]>> {
    try {
      await this.rateLimit();
      const data = await this.get<{ pairs?: DexScreenerPair[] }>(
        `/latest/dex/tokens/${params.tokenAddress}`,
      );

      return {
        success: true,
        data: data.pairs || [],
      };
    } catch (caught: unknown) {
      console.error("DexScreener getTokenPairs error:", caught);
      return {
        success: false,
        error: dexScreenerErrorMessage(caught) || "Failed to get token pairs",
      };
    }
  }

  async getPair(
    params: DexScreenerPairParams,
  ): Promise<DexScreenerServiceResponse<DexScreenerPair>> {
    try {
      await this.rateLimit();
      const data = await this.get<{ pair?: DexScreenerPair }>(
        `/latest/dex/pairs/${params.pairAddress}`,
      );

      if (!data.pair) {
        return {
          success: false,
          error: "Pair not found",
        };
      }

      return {
        success: true,
        data: data.pair,
      };
    } catch (caught: unknown) {
      console.error("DexScreener getPair error:", caught);
      return {
        success: false,
        error: dexScreenerErrorMessage(caught) || "Failed to get pair",
      };
    }
  }

  async getTrending(
    params: DexScreenerTrendingParams = {},
  ): Promise<DexScreenerServiceResponse<DexScreenerPair[]>> {
    try {
      await this.rateLimit();

      // DexScreener doesn't have a direct trending endpoint
      // We'll use the boosted tokens endpoint as a proxy for trending
      const responseData = await this.get<
        DexScreenerBoostedToken[] | DexScreenerBoostedToken
      >(`/token-boosts/top/v1`);

      // The boosted tokens response is an array of boosted tokens
      const boostedTokens = Array.isArray(responseData)
        ? responseData
        : [responseData];

      // For each boosted token, we need to get the actual pair data
      const pairPromises = boostedTokens
        .slice(0, params.limit || 10)
        .map(async (token) => {
          try {
            const pairData = await this.get<TokensV1Wire>(
              `/tokens/v1/${token.chainId}/${token.tokenAddress}`,
            );
            return Array.isArray(pairData) ? pairData[0] : null;
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
    } catch (caught: unknown) {
      console.error("DexScreener getTrending error:", caught);
      return {
        success: false,
        error:
          dexScreenerErrorMessage(caught) || "Failed to get trending pairs",
      };
    }
  }

  async getPairsByChain(
    params: DexScreenerChainParams,
  ): Promise<DexScreenerServiceResponse<DexScreenerPair[]>> {
    try {
      await this.rateLimit();

      // Use search API with chain filter
      const data = await this.get<{ pairs?: DexScreenerPair[] }>(
        `/latest/dex/search`,
        { q: params.chain },
      );

      let pairs: DexScreenerPair[] = data.pairs || [];

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
    } catch (caught: unknown) {
      console.error("DexScreener getPairsByChain error:", caught);
      return {
        success: false,
        error:
          dexScreenerErrorMessage(caught) || "Failed to get pairs by chain",
      };
    }
  }

  async getNewPairs(
    params: DexScreenerNewPairsParams = {},
  ): Promise<DexScreenerServiceResponse<DexScreenerPair[]>> {
    try {
      await this.rateLimit();

      // DexScreener doesn't have a direct new pairs endpoint
      // We'll use the latest token profiles as a proxy for new tokens
      const responseData = await this.get<
        DexScreenerProfile[] | DexScreenerProfile
      >(`/token-profiles/latest/v1`);

      // The latest token profiles response is an array of profiles
      const profiles = Array.isArray(responseData)
        ? responseData
        : [responseData];

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
            const pairData = await this.get<TokensV1Wire>(
              `/tokens/v1/${profile.chainId}/${profile.tokenAddress}`,
            );
            const pairs = Array.isArray(pairData) ? pairData : [];
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
    } catch (caught: unknown) {
      console.error("DexScreener getNewPairs error:", caught);
      return {
        success: false,
        error: dexScreenerErrorMessage(caught) || "Failed to get new pairs",
      };
    }
  }

  async getTokenProfile(
    tokenAddress: string,
  ): Promise<DexScreenerServiceResponse<DexScreenerProfile>> {
    try {
      await this.rateLimit();
      // Token profiles are available through the latest profiles endpoint
      // We need to fetch all and find the matching one
      const responseData = await this.get<
        DexScreenerProfile[] | DexScreenerProfile
      >(`/token-profiles/latest/v1`);
      const profiles = Array.isArray(responseData)
        ? responseData
        : [responseData];

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
    } catch (caught: unknown) {
      console.error("DexScreener getTokenProfile error:", caught);
      return {
        success: false,
        error: dexScreenerErrorMessage(caught) || "Failed to get token profile",
      };
    }
  }

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

  formatPriceChange(change: number): string {
    const sign = change >= 0 ? "+" : "";
    return `${sign}${change.toFixed(2)}%`;
  }

  formatUsdValue(value: number): string {
    if (value >= 1000000) {
      return `$${(value / 1000000).toFixed(2)}M`;
    } else if (value >= 1000) {
      return `$${(value / 1000).toFixed(2)}K`;
    } else {
      return `$${value.toFixed(2)}`;
    }
  }

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
      const data = await this.get<DexScreenerPair[] | DexScreenerPair>(
        `/tokens/v1/${chainId}/${addresses}`,
      );

      return {
        success: true,
        data: Array.isArray(data) ? data : data ? [data] : [],
      };
    } catch (caught: unknown) {
      console.error("DexScreener getMultipleTokens error:", caught);
      return {
        success: false,
        error:
          dexScreenerErrorMessage(caught) || "Failed to get multiple tokens",
      };
    }
  }

  async getLatestTokenProfiles(): Promise<
    DexScreenerServiceResponse<DexScreenerProfile[]>
  > {
    try {
      await this.rateLimit();
      const data = await this.get<DexScreenerProfile[] | DexScreenerProfile>(
        `/token-profiles/latest/v1`,
      );

      return {
        success: true,
        data: Array.isArray(data) ? data : [data],
      };
    } catch (caught: unknown) {
      console.error("DexScreener getLatestTokenProfiles error:", caught);
      return {
        success: false,
        error:
          dexScreenerErrorMessage(caught) ||
          "Failed to get latest token profiles",
      };
    }
  }

  async getLatestBoostedTokens(): Promise<
    DexScreenerServiceResponse<DexScreenerBoostedWire[]>
  > {
    try {
      await this.rateLimit();
      const data = await this.get<
        DexScreenerBoostedWire[] | DexScreenerBoostedWire
      >(`/token-boosts/latest/v1`);

      return {
        success: true,
        data: Array.isArray(data) ? data : [data],
      };
    } catch (caught: unknown) {
      console.error("DexScreener getLatestBoostedTokens error:", caught);
      return {
        success: false,
        error:
          dexScreenerErrorMessage(caught) ||
          "Failed to get latest boosted tokens",
      };
    }
  }

  async getTopBoostedTokens(): Promise<
    DexScreenerServiceResponse<DexScreenerBoostedWire[]>
  > {
    try {
      await this.rateLimit();
      const data = await this.get<
        DexScreenerBoostedWire[] | DexScreenerBoostedWire
      >(`/token-boosts/top/v1`);

      return {
        success: true,
        data: Array.isArray(data) ? data : [data],
      };
    } catch (caught: unknown) {
      console.error("DexScreener getTopBoostedTokens error:", caught);
      return {
        success: false,
        error:
          dexScreenerErrorMessage(caught) || "Failed to get top boosted tokens",
      };
    }
  }

  async checkOrderStatus(
    chainId: string,
    tokenAddress: string,
  ): Promise<DexScreenerServiceResponse<DexScreenerOrder[]>> {
    try {
      await this.rateLimit();
      const data = await this.get<DexScreenerOrder[] | DexScreenerOrder>(
        `/orders/v1/${chainId}/${tokenAddress}`,
      );

      return {
        success: true,
        data: Array.isArray(data) ? data : data ? [data] : [],
      };
    } catch (caught: unknown) {
      console.error("DexScreener checkOrderStatus error:", caught);
      return {
        success: false,
        error:
          dexScreenerErrorMessage(caught) || "Failed to check order status",
      };
    }
  }

  async getTokenPairsByChain(
    chainId: string,
    tokenAddress: string,
  ): Promise<DexScreenerServiceResponse<DexScreenerPair[]>> {
    try {
      await this.rateLimit();
      const data = await this.get<DexScreenerPair[] | DexScreenerPair>(
        `/token-pairs/v1/${chainId}/${tokenAddress}`,
      );

      return {
        success: true,
        data: Array.isArray(data) ? data : data ? [data] : [],
      };
    } catch (caught: unknown) {
      console.error("DexScreener getTokenPairsByChain error:", caught);
      return {
        success: false,
        error:
          dexScreenerErrorMessage(caught) ||
          "Failed to get token pairs by chain",
      };
    }
  }
}
