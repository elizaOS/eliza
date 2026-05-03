import { logger } from "@/lib/utils/logger";
import { getProxyConfig } from "../config";
import { retryFetch } from "../fetch";
import { getServiceMethodCost } from "../pricing";
import type { ServiceConfig, ServiceHandler } from "../types";
import { ALCHEMY_SLUGS } from "./rpc";

/**
 * Provider method configuration for enhanced chain data
 *
 * WHY dual-mode (REST + JSON-RPC):
 * - Alchemy NFT API is REST (GET requests to /nft/v3/{apiKey}/endpoint)
 * - Alchemy Token/Transfers API is JSON-RPC (POST to /v2/{apiKey} with alchemy_* methods)
 * - Routes stay provider-agnostic by using generic method names
 * - Swapping providers = update these configs, routes unchanged
 *
 * WHY buildRpcParams:
 * - Routes use named params (provider-agnostic)
 * - Alchemy JSON-RPC needs positional params (provider-specific)
 * - This function transforms: {address: "0x..."} → ["0x...", "erc20"]
 * - Different providers may need different transformations
 */
interface ProviderMethod {
  style: "rest" | "jsonrpc";
  path: string;
  rpcMethod?: string;
  buildRpcParams?: (params: Record<string, unknown>) => unknown[];
}

const PROVIDER_METHODS: Record<string, ProviderMethod> = {
  getNFTsForOwner: {
    style: "rest",
    path: "/nft/v3/{apiKey}/getNFTsForOwner",
    // REST: params become query string directly, no transformation needed
  },
  getNFTMetadata: {
    style: "rest",
    path: "/nft/v3/{apiKey}/getNFTMetadata",
  },
  getTokenBalances: {
    style: "jsonrpc",
    path: "/v2/{apiKey}",
    rpcMethod: "alchemy_getTokenBalances",
    // Alchemy expects: params: [ownerAddress, "erc20"]
    buildRpcParams: (p) => [p.address, "erc20"],
  },
  getTokenMetadata: {
    style: "jsonrpc",
    path: "/v2/{apiKey}",
    rpcMethod: "alchemy_getTokenMetadata",
    // Alchemy expects: params: [contractAddress]
    buildRpcParams: (p) => [p.contractAddress],
  },
  getAssetTransfers: {
    style: "jsonrpc",
    path: "/v2/{apiKey}",
    rpcMethod: "alchemy_getAssetTransfers",
    // Alchemy expects: params: [{ fromAddress, toAddress, category, maxCount, pageKey }]
    // Filter out null/undefined values to avoid sending them to Alchemy
    buildRpcParams: (p) => {
      const params: Record<string, string | string[]> = {
        category: p.category ? [String(p.category)] : ["external", "erc20", "erc721", "erc1155"],
      };
      if (p.fromAddress) params.fromAddress = String(p.fromAddress);
      if (p.toAddress) params.toAddress = String(p.toAddress);
      if (p.pageKey) params.pageKey = String(p.pageKey);
      const count = Number(p.maxCount);
      params.maxCount = !p.maxCount || Number.isNaN(count) ? "0x64" : "0x" + count.toString(16);
      return [params];
    },
  },
};

/**
 * Methods that should not be cached
 *
 * WHY getAssetTransfers is non-cacheable:
 * - Real-time transaction data changes every block
 * - Caching = users see stale transactions while still paying 50%
 * - Better to always fetch fresh data
 */
const NON_CACHEABLE_METHODS = new Set(["getAssetTransfers"]);

export interface ChainDataRequest {
  method: string;
  chain: string;
  params: Record<string, unknown>;
}

/**
 * Chain Data ServiceConfig
 *
 * WHY apiKeyWithOrg auth:
 * - Enhanced data is premium (5-100x more expensive than standard RPC)
 * - Must validate both API key AND org has sufficient balance
 *
 * WHY 60 req/min rate limit (stricter than standard RPC's 100):
 * - Enhanced APIs are heavier on upstream provider
 * - Higher per-request cost reduces need for frequent calls
 * - Prevents single org from monopolizing enhanced endpoints
 *
 * WHY 30s cache TTL:
 * - NFT metadata rarely changes (safe to cache longer)
 * - Token balances change frequently (keep fresh)
 * - 30s balances freshness vs cost savings
 *
 * WHY 50% cost on cache hit:
 * - Zero cost = users abuse cache with rapid refreshes
 * - 100% cost = no incentive to use caching
 * - 50% = fair split of savings
 */
export const chainDataConfig: ServiceConfig = {
  id: "chain-data",
  name: "Chain Data",
  auth: "apiKeyWithOrg",
  rateLimit: {
    windowMs: 60000,
    maxRequests: 60,
  },
  cache: {
    maxTTL: 30,
    hitCostMultiplier: 0.5,
    isMethodCacheable: (method) => !NON_CACHEABLE_METHODS.has(method),
    maxResponseSize: 131072, // 128KB - covers 99% of NFT/token responses
  },
  getCost: async (body: unknown) => {
    const { method } = body as ChainDataRequest;
    return getServiceMethodCost("chain-data", method);
  },
};

/**
 * Chain Data ServiceHandler
 *
 * WHY validate chain against ALCHEMY_SLUGS (not address-validation.ts EVM_CHAINS):
 * - address-validation.ts includes BSC, but Alchemy doesn't support BSC
 * - Chain-data must validate against actual provider coverage
 * - Returns clear error with supported chains list
 */
export const chainDataHandler: ServiceHandler = async ({ body }) => {
  const { method, chain, params } = body as ChainDataRequest;

  // Validate chain is supported for enhanced data
  if (!ALCHEMY_SLUGS[chain]) {
    const supportedChains = Object.keys(ALCHEMY_SLUGS);
    throw new Error(
      `Chain '${chain}' not supported for enhanced data. Supported chains: ${supportedChains.join(", ")}`,
    );
  }

  const providerMethod = PROVIDER_METHODS[method];
  if (!providerMethod) {
    throw new Error(`Unknown chain data method: ${method}`);
  }

  const apiKey = process.env.ALCHEMY_API_KEY;
  if (!apiKey) {
    throw new Error("ALCHEMY_API_KEY not configured");
  }

  const slug = ALCHEMY_SLUGS[chain];
  const baseUrl = `https://${slug}.g.alchemy.com`;
  const path = providerMethod.path.replace("{apiKey}", apiKey);

  try {
    if (providerMethod.style === "rest") {
      // REST API: Build URL with query params, GET request
      const queryParams = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          queryParams.append(key, String(value));
        }
      }
      const url = `${baseUrl}${path}?${queryParams.toString()}`;

      const response = await retryFetch({
        url,
        init: {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
        },
        maxRetries: getProxyConfig().ALCHEMY_MAX_RETRIES,
        initialDelayMs: getProxyConfig().ALCHEMY_INITIAL_RETRY_DELAY_MS,
        timeoutMs: getProxyConfig().ALCHEMY_TIMEOUT_MS,
        serviceTag: "Chain Data",
        nonRetriableStatuses: [400, 404],
      });

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error("[Chain Data] REST API error", {
          method,
          chain,
          status: response.status,
          body: errorBody,
        });

        return {
          response: Response.json(
            {
              error: "Chain data provider error",
              code: response.status,
            },
            { status: 502 },
          ),
        };
      }

      return { response };
    }

    // JSON-RPC API: POST with alchemy_* method
    const rpcParams = providerMethod.buildRpcParams!(params);
    const url = `${baseUrl}${path}`;

    const response = await retryFetch({
      url,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: providerMethod.rpcMethod,
          params: rpcParams,
        }),
      },
      maxRetries: getProxyConfig().ALCHEMY_MAX_RETRIES,
      initialDelayMs: getProxyConfig().ALCHEMY_INITIAL_RETRY_DELAY_MS,
      timeoutMs: getProxyConfig().ALCHEMY_TIMEOUT_MS,
      serviceTag: "Chain Data",
      nonRetriableStatuses: [400, 404],
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error("[Chain Data] JSON-RPC error", {
        method,
        chain,
        rpcMethod: providerMethod.rpcMethod,
        status: response.status,
        body: errorBody,
      });

      return {
        response: Response.json(
          {
            error: "Chain data provider error",
            code: response.status,
          },
          { status: 502 },
        ),
      };
    }

    return { response };
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      logger.error("[Chain Data] Timeout", { method, chain });
      throw new Error("timeout");
    }
    throw error;
  }
};
