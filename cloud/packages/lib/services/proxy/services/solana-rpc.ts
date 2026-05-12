import { servicePricingRepository } from "@/db/repositories";
import { cache } from "@/lib/cache/client";
import { logger } from "@/lib/utils/logger";
import { getProxyConfig } from "../config";
import { getServiceMethodCost } from "../pricing";
import type {
  JsonRpcBatchRequest,
  JsonRpcRequest,
  ProxyRequestBody,
  ServiceConfig,
  ServiceHandler,
} from "../types";

// Methods that should not be cached (mutations and rapidly changing data)
const NON_CACHEABLE_METHODS = new Set([
  "sendTransaction",
  "simulateTransaction",
  "requestAirdrop",
  "getRecentBlockhash",
  "getLatestBlockhash",
]);

// Tier 2+ methods: 10-100 Helius credits per call (vs 1 credit for tier 1).
// Helius charges per request regardless of response status, so every retry is
// real upstream spend. These methods use RPC_EXPENSIVE_MAX_RETRIES (default 2).
const EXPENSIVE_METHODS = new Set([
  // Tier 2 — DAS API (10 credits)
  "getAsset",
  "getAssetsByOwner",
  "searchAssets",
  "getTokenAccounts",
  "getAssetProof",
  "getAssetProofBatch",
  "getAssetsByAuthority",
  "getAssetsByCreator",
  "getAssetsByGroup",
  "getAssetBatch",
  "getSignaturesForAsset",
  "getNftEditions",
  // Tier 2 — Complex/Historical (10 credits)
  "getProgramAccounts",
  "getBlock",
  "getBlocks",
  "getBlocksWithLimit",
  "getTransaction",
  "getSignaturesForAddress",
  "getBlockTime",
  "getInflationReward",
  // Tier 3 — Enhanced/ZK (100 credits)
  "getTransactionsForAddress",
  "getValidityProof",
]);

/**
 * Hardcoded Fallback Whitelist
 *
 * MAINTENANCE NOTE: This is now a FALLBACK ONLY.
 *
 * Primary method authorization comes from the database (service_pricing table).
 * Any method with an active pricing entry (is_active=true) is automatically allowed.
 *
 * This hardcoded list serves as:
 * 1. Emergency fallback if database is unreachable
 * 2. Bootstrap/seed data reference
 * 3. Documentation of supported methods
 *
 * To add new methods:
 * ✅ Add pricing entry via admin API: POST /api/v1/admin/service-pricing
 * ❌ DO NOT edit this list (unless updating fallback)
 *
 * @see getActiveMethodsFromDatabase() for the primary authorization logic
 */
const HARDCODED_FALLBACK_METHODS = new Set([
  // Tier 1 - Standard Solana RPC (fall under _default pricing)
  "getAccountInfo",
  "getBalance",
  "getBlockHeight",
  "getBlockProduction",
  "getBlockCommitment",
  "getClusterNodes",
  "getEpochInfo",
  "getEpochSchedule",
  "getFeeForMessage",
  "getFirstAvailableBlock",
  "getGenesisHash",
  "getHealth",
  "getHighestSnapshotSlot",
  "getIdentity",
  "getInflationGovernor",
  "getInflationRate",
  "getLargestAccounts",
  "getLatestBlockhash",
  "getLeaderSchedule",
  "getMaxRetransmitSlot",
  "getMaxShredInsertSlot",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getRecentBlockhash",
  "getRecentPerformanceSamples",
  "getRecentPrioritizationFees",
  "getSignatureStatuses",
  "getSlot",
  "getSlotLeader",
  "getSlotLeaders",
  "getStakeActivation",
  "getStakeMinimumDelegation",
  "getSupply",
  "getTokenAccountBalance",
  "getTokenAccountsByDelegate",
  "getTokenAccountsByOwner",
  "getTokenLargestAccounts",
  "getTokenSupply",
  "getTransactionCount",
  "getVersion",
  "getVoteAccounts",
  "isBlockhashValid",
  "minimumLedgerSlot",
  "requestAirdrop",
  "sendTransaction",
  "simulateTransaction",

  // Tier 2 - DAS API (explicitly priced)
  "getAsset",
  "getAssetsByOwner",
  "searchAssets",
  "getTokenAccounts",
  "getAssetProof",
  "getAssetProofBatch",
  "getAssetsByAuthority",
  "getAssetsByCreator",
  "getAssetsByGroup",
  "getAssetBatch",
  "getSignaturesForAsset",
  "getNftEditions",

  // Tier 2 - Complex/Historical (explicitly priced)
  "getProgramAccounts",
  "getBlock",
  "getBlocks",
  "getBlocksWithLimit",
  "getTransaction",
  "getSignaturesForAddress",
  "getBlockTime",
  "getInflationReward",

  // Tier 3 - Enhanced/ZK (explicitly priced)
  "getTransactionsForAddress",
  "getValidityProof",
]);

/**
 * Cache key for allowed methods list
 * TTL: 60 seconds (fast refresh for new methods added via admin API)
 */
const ALLOWED_METHODS_CACHE_KEY = "solana-rpc:allowed-methods";
const ALLOWED_METHODS_CACHE_TTL = 60;

/**
 * Gets allowed methods from database (with caching)
 *
 * Strategy:
 * 1. Check cache (60s TTL) - fast path for most requests
 * 2. Query database for active methods
 * 3. Fallback to hardcoded list if DB fails
 *
 * Performance:
 * - Cache hit: ~1ms (no DB query)
 * - Cache miss: ~10-50ms (DB query)
 * - DB failure: Falls back to hardcoded list immediately
 *
 * @returns Set of allowed method names
 */
async function getAllowedMethods(): Promise<Set<string>> {
  try {
    // Check cache first
    const cached = await cache.get<string[]>(ALLOWED_METHODS_CACHE_KEY);
    if (cached) {
      logger.debug("[Solana RPC] Allowed methods cache hit");
      return new Set(cached);
    }

    logger.debug("[Solana RPC] Allowed methods cache miss, querying database");

    // Query database for active methods
    const pricingRecords = await servicePricingRepository.listByService("solana-rpc");
    const activeMethods = pricingRecords
      .filter((record) => record.is_active)
      .map((record) => record.method);

    if (activeMethods.length === 0) {
      logger.warn("[Solana RPC] No active methods in database, using fallback");
      return HARDCODED_FALLBACK_METHODS;
    }

    // Cache the result
    await cache.set(ALLOWED_METHODS_CACHE_KEY, activeMethods, ALLOWED_METHODS_CACHE_TTL);

    logger.info("[Solana RPC] Loaded allowed methods from database", {
      count: activeMethods.length,
      cached_for: `${ALLOWED_METHODS_CACHE_TTL}s`,
    });

    return new Set(activeMethods);
  } catch (error) {
    // Database or cache failure - use hardcoded fallback
    logger.error("[Solana RPC] Failed to load allowed methods from database, using fallback", {
      error: error instanceof Error ? error.message : "Unknown error",
      fallback_count: HARDCODED_FALLBACK_METHODS.size,
    });

    return HARDCODED_FALLBACK_METHODS;
  }
}

/**
 * Checks if a method is allowed
 *
 * Uses database-driven whitelist with hardcoded fallback.
 * Results are cached for 60 seconds to minimize DB load.
 *
 * @param method - RPC method name to check
 * @returns true if method is allowed
 */
async function isMethodAllowed(method: string): Promise<boolean> {
  const allowedMethods = await getAllowedMethods();
  return allowedMethods.has(method);
}

async function extractMethodFromBody(body: ProxyRequestBody): Promise<string> {
  if (!body || typeof body !== "object") {
    throw new Error("Invalid JSON-RPC request: body must be an object");
  }

  if (Array.isArray(body)) {
    if (body.length === 0) {
      throw new Error("Invalid JSON-RPC batch: empty array");
    }
    if (body.length > getProxyConfig().MAX_BATCH_SIZE) {
      throw new Error(
        `Invalid JSON-RPC batch: maximum ${getProxyConfig().MAX_BATCH_SIZE} requests`,
      );
    }
    return "_batch";
  }

  if (!("method" in body) || typeof body.method !== "string") {
    throw new Error("Invalid JSON-RPC request: missing method field");
  }

  const method = body.method;

  // Validate method is in database-driven whitelist (with caching)
  const allowed = await isMethodAllowed(method);
  if (!allowed) {
    throw new Error(
      `Method '${method}' is not supported. See /api/v1/solana/methods for allowed methods.`,
    );
  }

  return method;
}

async function calculateBatchCost(body: JsonRpcBatchRequest): Promise<number> {
  const allowedMethods = await getAllowedMethods();
  const methodCounts = new Map<string, number>();

  for (const item of body) {
    if (!item || typeof item !== "object" || !("method" in item)) {
      throw new Error("Invalid JSON-RPC batch: malformed request");
    }
    const method = String(item.method);

    if (!allowedMethods.has(method)) {
      throw new Error(
        `Batch contains unsupported method '${method}'. See /api/v1/solana/methods for allowed methods.`,
      );
    }

    methodCounts.set(method, (methodCounts.get(method) ?? 0) + 1);
  }

  const costs = await Promise.all(
    Array.from(methodCounts.keys()).map(async (method) => ({
      method,
      cost: await getServiceMethodCost("solana-rpc", method),
    })),
  );

  return costs.reduce((total, { method, cost }) => total + cost * methodCounts.get(method)!, 0);
}

export const solanaRpcConfig: ServiceConfig = {
  id: "solana-rpc",
  name: "Solana RPC",
  auth: "apiKeyWithOrg",
  rateLimit: {
    windowMs: 60000,
    maxRequests: 100,
  },
  cache: {
    maxTTL: 60,
    isMethodCacheable: (method) => !NON_CACHEABLE_METHODS.has(method),
    maxResponseSize: 65536,
    hitCostMultiplier: 0.5,
  },
  getCost: async (body: ProxyRequestBody) => {
    if (!body) {
      throw new Error("Invalid JSON-RPC request: body is required");
    }

    const method = await extractMethodFromBody(body);

    if (method === "_batch" && Array.isArray(body)) {
      return await calculateBatchCost(body);
    }

    return await getServiceMethodCost("solana-rpc", method);
  },
};

/** Sanitize URL by masking API key for safe logging */
function sanitizeUrl(url: string): string {
  return url.replace(/api-key=[^&]+/, "api-key=***");
}

// ---------------------------------------------------------------------------
// Circuit breaker — per-network (mainnet / devnet)
//
// Tracks consecutive upstream failures. After THRESHOLD failures the circuit
// opens and all requests fast-fail with 503 for OPEN_DURATION_MS.  When the
// open period elapses, one probe request is allowed through (half-open):
//   • success → circuit closes (state deleted)
//   • failure → circuit re-opens immediately (failures still >= threshold)
// ---------------------------------------------------------------------------
const circuitBreaker = new Map<string, { failures: number; openUntil: number }>();

function isCircuitOpen(network: string): boolean {
  const cb = circuitBreaker.get(network);
  if (!cb) return false;
  return Date.now() < cb.openUntil;
}

function recordCircuitSuccess(network: string): void {
  circuitBreaker.delete(network);
}

function recordCircuitFailure(network: string): void {
  const cb = circuitBreaker.get(network) ?? { failures: 0, openUntil: 0 };
  cb.failures++;
  if (cb.failures >= getProxyConfig().RPC_CIRCUIT_FAILURE_THRESHOLD) {
    cb.openUntil = Date.now() + getProxyConfig().RPC_CIRCUIT_OPEN_DURATION_MS;
    logger.error("[Solana RPC] Circuit breaker opened", {
      network,
      failures: cb.failures,
      openForMs: getProxyConfig().RPC_CIRCUIT_OPEN_DURATION_MS,
    });
  }
  circuitBreaker.set(network, cb);
}

/** Fewer retries for expensive methods / batch requests to limit upstream spend. */
function getMaxRetries(body: JsonRpcRequest | JsonRpcBatchRequest): number {
  if (Array.isArray(body)) return getProxyConfig().RPC_EXPENSIVE_MAX_RETRIES;
  if (body && typeof body === "object" && "method" in body) {
    if (EXPENSIVE_METHODS.has(String(body.method))) {
      return getProxyConfig().RPC_EXPENSIVE_MAX_RETRIES;
    }
  }
  return getProxyConfig().RPC_MAX_RETRIES;
}

interface FetchAttemptLog {
  attempt: number;
  url: string;
  status?: number;
  error?: string;
  durationMs: number;
}

interface FetchResult {
  response: Response;
  fetchLogs: FetchAttemptLog[];
}

/**
 * Retry wrapper with exponential backoff and per-attempt audit logging.
 * Delays: 1s, 2s, 4s, 8s… capped at RPC_MAX_RETRY_DELAY_MS (default 16s).
 * Retries on: TimeoutError, 5xx status codes.
 * Does NOT retry: 2xx (success), 400, 404 (non-retriable client errors).
 */
async function fetchWithRetry(
  url: string,
  body: JsonRpcRequest | JsonRpcBatchRequest,
  maxRetries?: number,
): Promise<FetchResult> {
  const fetchLogs: FetchAttemptLog[] = [];
  const sanitized = sanitizeUrl(url);
  const maxAttempts = maxRetries ?? getProxyConfig().RPC_MAX_RETRIES;
  const {
    RPC_INITIAL_RETRY_DELAY_MS: initialDelay,
    RPC_MAX_RETRY_DELAY_MS: maxDelay,
    UPSTREAM_TIMEOUT_MS: timeoutMs,
  } = getProxyConfig();

  let lastResponse: Response | undefined;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const start = Date.now();

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      fetchLogs.push({
        attempt,
        url: sanitized,
        status: response.status,
        durationMs: Date.now() - start,
      });

      if (response.ok || response.status === 400 || response.status === 404) {
        return { response, fetchLogs };
      }

      lastResponse = response;
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === "TimeoutError";

      fetchLogs.push({
        attempt,
        url: sanitized,
        error: isTimeout ? "TimeoutError" : error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - start,
      });

      if (!isTimeout) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    if (attempt < maxAttempts) {
      const delayMs = Math.min(initialDelay * 2 ** (attempt - 1), maxDelay);
      logger.warn("[Solana RPC] Retrying", {
        attempt,
        delayMs,
        url: sanitized,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  if (lastResponse) return { response: lastResponse, fetchLogs };
  throw lastError!;
}

export const solanaRpcHandler: ServiceHandler = async ({ body, searchParams }) => {
  if (!body) {
    throw new Error("Invalid JSON-RPC request: body is required");
  }

  const rpcBody = body as JsonRpcRequest | JsonRpcBatchRequest;
  const network = searchParams.get("network") || "mainnet";

  if (network !== "mainnet" && network !== "devnet") {
    throw new Error("Invalid network: must be mainnet or devnet");
  }

  // Circuit breaker — fast-fail if upstream is consistently down
  if (isCircuitOpen(network)) {
    logger.warn("[Solana RPC] Circuit open, fast-failing", { network });
    return {
      response: Response.json(
        { error: "Service temporarily unavailable", code: 503 },
        { status: 503 },
      ),
      usageMetadata: { circuit_open: true },
    };
  }

  // Helius requires API key in URL (no header auth). All URL logging goes through
  // sanitizeUrl() which masks the key as api-key=***.
  const apiKey = process.env.SOLANA_RPC_PROVIDER_API_KEY;
  if (!apiKey) {
    throw new Error("SOLANA_RPC_PROVIDER_API_KEY not configured");
  }

  const primaryBaseUrl =
    network === "mainnet"
      ? getProxyConfig().HELIUS_MAINNET_URL
      : getProxyConfig().HELIUS_DEVNET_URL;

  const fallbackBaseUrl =
    network === "mainnet"
      ? getProxyConfig().HELIUS_MAINNET_FALLBACK_URL
      : getProxyConfig().HELIUS_DEVNET_FALLBACK_URL;

  const primaryUrl = `${primaryBaseUrl}/?api-key=${apiKey}`;
  const maxRetries = getMaxRetries(rpcBody);
  const fetchLogs: FetchAttemptLog[] = [];
  let primaryTimedOut = false;
  let primaryStatus: number | undefined;

  // Try primary URL with retries (fewer for expensive methods)
  try {
    const primary = await fetchWithRetry(primaryUrl, rpcBody, maxRetries);
    fetchLogs.push(...primary.fetchLogs);

    if (primary.response.ok || (primary.response.status >= 400 && primary.response.status < 500)) {
      recordCircuitSuccess(network);
      return {
        response: primary.response,
        usageMetadata: { fetch_logs: fetchLogs },
      };
    }

    primaryStatus = primary.response.status;
    const errorBody = await primary.response.text();
    logger.error("[Solana RPC] Primary URL failed after retries", {
      url: sanitizeUrl(primaryUrl),
      status: primaryStatus,
      body: errorBody,
      attempts: primary.fetchLogs.length,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      primaryTimedOut = true;
      logger.error("[Solana RPC] Primary URL timed out after retries", {
        url: sanitizeUrl(primaryUrl),
        attempts: fetchLogs.length,
      });
    } else {
      throw error;
    }
  }

  // Primary failed — try fallback if configured (same retry budget)
  if (fallbackBaseUrl) {
    const fallbackUrl = `${fallbackBaseUrl}/?api-key=${apiKey}`;
    logger.info("[Solana RPC] Attempting fallback URL");

    try {
      const fallback = await fetchWithRetry(fallbackUrl, rpcBody, maxRetries);
      fetchLogs.push(...fallback.fetchLogs);

      if (fallback.response.ok) {
        logger.info("[Solana RPC] Fallback succeeded");
        recordCircuitSuccess(network);
        return {
          response: fallback.response,
          usageMetadata: { fetch_logs: fetchLogs },
        };
      }

      const fallbackError = await fallback.response.text();
      logger.error("[Solana RPC] Fallback also failed", {
        url: sanitizeUrl(fallbackUrl),
        status: fallback.response.status,
        body: fallbackError,
      });
    } catch (fallbackErr) {
      logger.error("[Solana RPC] Fallback error", {
        error: fallbackErr instanceof Error ? fallbackErr.message : "Unknown",
      });
    }
  }

  // Both URLs exhausted — record failure for circuit breaker
  recordCircuitFailure(network);

  if (primaryTimedOut) {
    throw new Error("timeout");
  }

  return {
    response: Response.json(
      { error: "Upstream RPC error", code: primaryStatus ?? 502 },
      { status: 502 },
    ),
    usageMetadata: { fetch_logs: fetchLogs },
  };
};
