/**
 * Discord Gateway Shared Constants
 *
 * These constants must be consistent across the gateway service and API routes.
 * The gateway reads from environment variables, but the API routes use these defaults.
 */

/**
 * Time (ms) after which a pod is considered dead if no heartbeat received.
 * Used by both the gateway service (failover detection) and API routes (failover validation).
 *
 * Formula: DEAD_POD_THRESHOLD_MS should be >= 3 * HEARTBEAT_INTERVAL_MS
 * to allow for 2-3 missed heartbeats before declaring dead.
 *
 * Note: The gateway service reads this from DEAD_POD_THRESHOLD_MS env var.
 * This default must match the K8s deployment configuration.
 */
export const DEAD_POD_THRESHOLD_MS = 45_000; // 45 seconds

// ============================================
// Discord API Rate Limiting
// ============================================

/**
 * Discord enforces 50 requests per second per bot globally.
 * We use 45 to leave headroom for other operations.
 */
export const DISCORD_RATE_LIMIT_REQUESTS = 45;

/** Rate limit window in milliseconds (1 second) */
export const DISCORD_RATE_LIMIT_WINDOW_MS = 1_000;

/** Maximum queue size per bot before rejecting requests */
export const DISCORD_RATE_LIMIT_MAX_QUEUE = 100;

/** Default retry delay when rate limited without Retry-After header */
export const DISCORD_RATE_LIMIT_DEFAULT_RETRY_MS = 1_000;
