import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { logger } from "@/lib/utils/logger";
import { getProxyConfig } from "../config";
import { retryFetch } from "../fetch";
import { calculateBatchCost, getServiceMethodCost } from "../pricing";
import type { ServiceConfig, ServiceHandler } from "../types";
import { solanaRpcConfig, solanaRpcHandler } from "./solana-rpc";

/**
 * Alchemy chain-to-slug mapping (mainnet)
 *
 * WHY exported: chain-data.ts needs this to validate chains for enhanced APIs
 */
export const ALCHEMY_SLUGS: Record<string, string> = {
  ethereum: "eth-mainnet",
  polygon: "polygon-mainnet",
  arbitrum: "arb-mainnet",
  optimism: "opt-mainnet",
  base: "base-mainnet",
  zksync: "zksync-mainnet",
  avalanche: "avax-mainnet",
};

/**
 * Alchemy testnet slug mapping
 */
export const ALCHEMY_TESTNET_SLUGS: Record<string, string> = {
  ethereum: "eth-sepolia",
  polygon: "polygon-amoy",
  arbitrum: "arb-sepolia",
  optimism: "opt-sepolia",
  base: "base-sepolia",
};

/**
 * EVM RPC method whitelist
 *
 * WHY standard methods only:
 * - These methods are identical across all EVM RPC providers
 * - Provider-specific methods (alchemy_*) go in chain-data.ts
 * - Ensures we can swap Alchemy for QuickNode/Infura without route changes
 */
const EVM_ALLOWED_METHODS = new Set([
  // 0 CU tier
  "net_version",
  "eth_chainId",
  "eth_syncing",
  "eth_protocolVersion",
  "net_listening",

  // 10 CU tier
  "eth_blockNumber",
  "eth_feeHistory",
  "eth_maxPriorityFeePerGas",
  "eth_blobBaseFee",
  "eth_uninstallFilter",
  "eth_accounts",
  "eth_subscribe",
  "eth_unsubscribe",
  "eth_createAccessList",

  // 20 CU tier
  "eth_getBalance",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_gasPrice",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_estimateGas",
  "eth_getTransactionCount",
  "eth_getBlockTransactionCountByHash",
  "eth_getBlockTransactionCountByNumber",
  "eth_getProof",
  "eth_newFilter",
  "eth_newBlockFilter",
  "eth_newPendingTransactionFilter",
  "eth_getFilterChanges",
  "eth_getBlockReceipts",
  "web3_clientVersion",
  "web3_sha3",

  // 26 CU tier
  "eth_call",

  // 40 CU tier
  "eth_sendRawTransaction",
  "eth_simulateV1",

  // 60 CU tier
  "eth_getLogs",
  "eth_getFilterLogs",
]);

/**
 * EVM methods that should not be cached
 *
 * WHY these are non-cacheable:
 * - Mutations: sendRawTransaction (changes blockchain state)
 * - Rapidly changing: blockNumber, gasPrice, maxPriorityFeePerGas (update every block)
 * - Caching these = stale data misleads users while still costing 50%
 */
const EVM_NON_CACHEABLE_METHODS = new Set([
  "eth_sendRawTransaction",
  "eth_blockNumber",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_blobBaseFee",
]);

/**
 * Extract method from JSON-RPC request body (EVM)
 *
 * WHY separate from Solana's extractMethodFromBody:
 * - Different method whitelists
 * - Different error messages (EVM vs Solana context)
 * - Solana-specific validation stays in solana-rpc.ts
 */
function extractEvmMethodFromBody(body: unknown): string {
  if (!body || typeof body !== "object") {
    throw new Error("Invalid JSON-RPC request: body must be an object");
  }

  if (Array.isArray(body)) {
    if (body.length === 0) {
      throw new Error("Invalid JSON-RPC batch: empty array");
    }
    if (body.length > getProxyConfig().ALCHEMY_MAX_BATCH_SIZE) {
      throw new Error(
        `Invalid JSON-RPC batch: maximum ${getProxyConfig().ALCHEMY_MAX_BATCH_SIZE} requests`,
      );
    }
    return "_batch";
  }

  if (!("method" in body) || typeof body.method !== "string") {
    throw new Error("Invalid JSON-RPC request: missing method field");
  }

  const method = body.method;

  if (!EVM_ALLOWED_METHODS.has(method)) {
    throw new Error(
      `Method '${method}' is not supported for EVM chains. Supported methods: standard JSON-RPC only.`,
    );
  }

  return method;
}

/**
 * Build EVM RPC config
 *
 * WHY build dynamically instead of constant:
 * - ServiceConfig.getCost is async (reads from DB/cache)
 * - Can't initialize at module level without top-level await
 * - Building per-request has negligible overhead vs DB/cache hits
 */
function buildEvmRpcConfig(): ServiceConfig {
  return {
    id: "evm-rpc",
    name: "EVM RPC",
    auth: "apiKeyWithOrg",
    rateLimit: {
      windowMs: 60000,
      maxRequests: 100,
    },
    cache: {
      maxTTL: 60,
      isMethodCacheable: (method) => !EVM_NON_CACHEABLE_METHODS.has(method),
      maxResponseSize: 65536,
      hitCostMultiplier: 0.5,
    },
    getCost: async (body: unknown) => {
      const method = extractEvmMethodFromBody(body);

      if (method === "_batch" && Array.isArray(body)) {
        return calculateBatchCost(
          "evm-rpc",
          EVM_ALLOWED_METHODS,
          body,
          getProxyConfig().ALCHEMY_MAX_BATCH_SIZE,
        );
      }

      return getServiceMethodCost("evm-rpc", method);
    },
  };
}

/**
 * Build EVM RPC handler
 *
 * WHY closure pattern:
 * - Captures chain at creation time
 * - Allows chain-specific URL building and validation
 * - Keeps handler signature generic (no chain param)
 */
function buildEvmRpcHandler(chain: string): ServiceHandler {
  return async ({ body, searchParams }) => {
    const network = searchParams.get("network") || "mainnet";

    if (network !== "mainnet" && network !== "testnet") {
      throw new Error("Invalid network: must be mainnet or testnet");
    }

    const apiKey = getCloudAwareEnv().ALCHEMY_API_KEY;
    if (!apiKey) {
      throw new Error("ALCHEMY_API_KEY not configured");
    }

    const slugMap = network === "mainnet" ? ALCHEMY_SLUGS : ALCHEMY_TESTNET_SLUGS;
    const slug = slugMap[chain];

    if (!slug) {
      throw new Error(`Chain '${chain}' not supported on ${network}`);
    }

    const url = `https://${slug}.g.alchemy.com/v2/${apiKey}`;

    try {
      const response = await retryFetch({
        url,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
        maxRetries: getProxyConfig().ALCHEMY_MAX_RETRIES,
        initialDelayMs: getProxyConfig().ALCHEMY_INITIAL_RETRY_DELAY_MS,
        timeoutMs: getProxyConfig().ALCHEMY_TIMEOUT_MS,
        serviceTag: "EVM RPC",
        nonRetriableStatuses: [400, 404],
      });

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error("[EVM RPC] Alchemy error", {
          chain,
          network,
          status: response.status,
          body: errorBody,
        });

        return {
          response: Response.json(
            {
              error: "Upstream RPC error",
              code: response.status,
            },
            { status: 502 },
          ),
        };
      }

      return { response };
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        logger.error("[EVM RPC] Timeout", { chain, network });
        throw new Error("timeout");
      }
      throw error;
    }
  };
}

/**
 * Supported RPC chains (Solana + all Alchemy EVM chains)
 */
export const SUPPORTED_RPC_CHAINS = new Set(["solana", ...Object.keys(ALCHEMY_SLUGS)]);

/**
 * Check if chain is supported for RPC
 */
export function isValidRpcChain(chain: string): boolean {
  return SUPPORTED_RPC_CHAINS.has(chain);
}

/**
 * Get ServiceConfig for a chain
 *
 * WHY return solanaRpcConfig directly:
 * - Single source of truth for Solana config
 * - /api/v1/solana/rpc and /api/v1/rpc/solana must behave identically
 * - Prevents config divergence (different rate limits, cache TTLs, etc.)
 */
export function rpcConfigForChain(chain: string): ServiceConfig {
  if (chain === "solana") {
    return solanaRpcConfig;
  }

  if (!ALCHEMY_SLUGS[chain]) {
    throw new Error(`Unsupported chain: ${chain}`);
  }

  return buildEvmRpcConfig();
}

/**
 * Get ServiceHandler for a chain
 *
 * WHY return solanaRpcHandler directly:
 * - Same reasoning as rpcConfigForChain
 * - Ensures backward compatibility
 * - Both URLs use same implementation
 */
export function rpcHandlerForChain(chain: string): ServiceHandler {
  if (chain === "solana") {
    return solanaRpcHandler;
  }

  if (!ALCHEMY_SLUGS[chain]) {
    throw new Error(`Unsupported chain: ${chain}`);
  }

  return buildEvmRpcHandler(chain);
}
