/**
 * Service Proxy Configuration
 *
 * Central configuration for service proxy behavior.
 * Environment variables override defaults. Call `getProxyConfig()` so reads
 * resolve under Cloud Workers via `getCloudAwareEnv()` (per-request `c.env`).
 */

import { getCloudAwareEnv } from "../../runtime/cloud-bindings";

/**
 * Strict integer env parse: rejects trailing garbage (parseInt("25junk") is
 * 25) and sign-prefix confusion, so a corrupted or hostile env value can never
 * silently become a different budget than intended. Empty/unset uses the
 * fallback; anything else non-canonical fails closed to the fallback.
 */
export function envInt(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return fallback;
  return /^\+?\d+$/.test(trimmed) ? Number(trimmed) : fallback;
}

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
    PRICING_CACHE_TTL: envInt(e.PRICING_CACHE_TTL, 300),
    PRICING_CACHE_STALE_TIME: envInt(e.PRICING_CACHE_STALE_TIME, 150),

    UPSTREAM_TIMEOUT_MS: envInt(e.UPSTREAM_TIMEOUT_MS, 25000),
    MAX_BATCH_SIZE: envInt(e.MAX_BATCH_SIZE, 20),

    HELIUS_MAINNET_URL: e.HELIUS_MAINNET_URL || "https://mainnet.helius-rpc.com",
    HELIUS_DEVNET_URL: e.HELIUS_DEVNET_URL || "https://devnet.helius-rpc.com",

    HELIUS_MAINNET_FALLBACK_URL: e.HELIUS_MAINNET_FALLBACK_URL,
    HELIUS_DEVNET_FALLBACK_URL: e.HELIUS_DEVNET_FALLBACK_URL,

    RPC_MAX_RETRIES: envInt(e.RPC_MAX_RETRIES, 5),
    RPC_INITIAL_RETRY_DELAY_MS: envInt(e.RPC_INITIAL_RETRY_DELAY_MS, 1000),
    RPC_MAX_RETRY_DELAY_MS: envInt(e.RPC_MAX_RETRY_DELAY_MS, 16000),

    RPC_EXPENSIVE_MAX_RETRIES: envInt(e.RPC_EXPENSIVE_MAX_RETRIES, 2),

    RPC_CIRCUIT_FAILURE_THRESHOLD: envInt(e.RPC_CIRCUIT_FAILURE_THRESHOLD, 10),
    RPC_CIRCUIT_OPEN_DURATION_MS: envInt(e.RPC_CIRCUIT_OPEN_DURATION_MS, 30000),

    MARKET_DATA_BASE_URL: e.MARKET_DATA_BASE_URL || "https://public-api.birdeye.so",
    MARKET_DATA_TIMEOUT_MS: envInt(e.MARKET_DATA_TIMEOUT_MS, 15000),
    MARKET_DATA_MAX_RETRIES: envInt(e.MARKET_DATA_MAX_RETRIES, 3),
    MARKET_DATA_INITIAL_RETRY_DELAY_MS: envInt(e.MARKET_DATA_INITIAL_RETRY_DELAY_MS, 500),

    ALCHEMY_TIMEOUT_MS: envInt(e.ALCHEMY_TIMEOUT_MS, 25000),
    ALCHEMY_MAX_RETRIES: envInt(e.ALCHEMY_MAX_RETRIES, 3),
    ALCHEMY_INITIAL_RETRY_DELAY_MS: envInt(e.ALCHEMY_INITIAL_RETRY_DELAY_MS, 500),
    ALCHEMY_MAX_BATCH_SIZE: envInt(e.ALCHEMY_MAX_BATCH_SIZE, 20),
  } as const;
}

export type ProxyConfig = ReturnType<typeof getProxyConfig>;
