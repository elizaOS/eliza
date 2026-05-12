/**
 * Service Proxy Configuration
 *
 * Central configuration for service proxy behavior.
 * Environment variables override defaults. Call `getProxyConfig()` so reads
 * resolve under Cloud Workers via `getCloudAwareEnv()` (per-request `c.env`).
 */

import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";

export function getProxyConfig() {
  const e = getCloudAwareEnv();
  return {
    /**
     * Pricing cache TTL (seconds)
     *
     * CRITICAL: This TTL is a safety net for cache consistency.
     * If cache invalidation fails after DB update, stale pricing will
     * persist until this TTL expires.
     *
     * Default: 300s (5 minutes)
     */
    PRICING_CACHE_TTL: parseInt(e.PRICING_CACHE_TTL || "300", 10),
    PRICING_CACHE_STALE_TIME: parseInt(e.PRICING_CACHE_STALE_TIME || "150", 10),

    UPSTREAM_TIMEOUT_MS: parseInt(e.UPSTREAM_TIMEOUT_MS || "25000", 10),
    MAX_BATCH_SIZE: parseInt(e.MAX_BATCH_SIZE || "20", 10),

    HELIUS_MAINNET_URL: e.HELIUS_MAINNET_URL || "https://mainnet.helius-rpc.com",
    HELIUS_DEVNET_URL: e.HELIUS_DEVNET_URL || "https://devnet.helius-rpc.com",

    HELIUS_MAINNET_FALLBACK_URL: e.HELIUS_MAINNET_FALLBACK_URL,
    HELIUS_DEVNET_FALLBACK_URL: e.HELIUS_DEVNET_FALLBACK_URL,

    RPC_MAX_RETRIES: parseInt(e.RPC_MAX_RETRIES || "5", 10),
    RPC_INITIAL_RETRY_DELAY_MS: parseInt(e.RPC_INITIAL_RETRY_DELAY_MS || "1000", 10),
    RPC_MAX_RETRY_DELAY_MS: parseInt(e.RPC_MAX_RETRY_DELAY_MS || "16000", 10),

    RPC_EXPENSIVE_MAX_RETRIES: parseInt(e.RPC_EXPENSIVE_MAX_RETRIES || "2", 10),

    RPC_CIRCUIT_FAILURE_THRESHOLD: parseInt(e.RPC_CIRCUIT_FAILURE_THRESHOLD || "10", 10),
    RPC_CIRCUIT_OPEN_DURATION_MS: parseInt(e.RPC_CIRCUIT_OPEN_DURATION_MS || "30000", 10),

    MARKET_DATA_BASE_URL: e.MARKET_DATA_BASE_URL || "https://public-api.birdeye.so",
    MARKET_DATA_TIMEOUT_MS: parseInt(e.MARKET_DATA_TIMEOUT_MS || "15000", 10),
    MARKET_DATA_MAX_RETRIES: parseInt(e.MARKET_DATA_MAX_RETRIES || "3", 10),
    MARKET_DATA_INITIAL_RETRY_DELAY_MS: parseInt(e.MARKET_DATA_INITIAL_RETRY_DELAY_MS || "500", 10),

    ALCHEMY_TIMEOUT_MS: parseInt(e.ALCHEMY_TIMEOUT_MS || "25000", 10),
    ALCHEMY_MAX_RETRIES: parseInt(e.ALCHEMY_MAX_RETRIES || "3", 10),
    ALCHEMY_INITIAL_RETRY_DELAY_MS: parseInt(e.ALCHEMY_INITIAL_RETRY_DELAY_MS || "500", 10),
    ALCHEMY_MAX_BATCH_SIZE: parseInt(e.ALCHEMY_MAX_BATCH_SIZE || "20", 10),
  } as const;
}

export type ProxyConfig = ReturnType<typeof getProxyConfig>;
