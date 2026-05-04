/**
 * Cache health monitoring and maintenance utilities.
 */

import { logger } from "@/lib/utils/logger";
import { cache } from "./client";

/**
 * Cache health check and maintenance operations.
 */
export class CacheHealth {
  /**
   * Checks cache health by performing a roundtrip test.
   *
   * @returns Health status with latency and error information.
   */
  static async check(): Promise<{
    healthy: boolean;
    latency: number | null;
    error: string | null;
  }> {
    try {
      const testKey = "health:check:ping";
      const testValue = { timestamp: Date.now(), ping: "pong" };

      const start = Date.now();

      await cache.set(testKey, testValue, 10);
      const retrieved = await cache.get<typeof testValue>(testKey);
      await cache.del(testKey);

      const latency = Date.now() - start;

      if (!retrieved || retrieved.ping !== "pong") {
        return {
          healthy: false,
          latency,
          error: "Cache roundtrip failed",
        };
      }

      return {
        healthy: true,
        latency,
        error: null,
      };
    } catch (error) {
      logger.error("[Cache Health] Health check failed:", error);
      return {
        healthy: false,
        latency: null,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Clears cache entries matching a pattern.
   *
   * @param pattern - Pattern to match (e.g., "org:*").
   * @returns 0 on success, -1 on error.
   */
  static async clearPattern(pattern: string): Promise<number> {
    try {
      logger.info(`[Cache Health] Clearing pattern: ${pattern}`);
      await cache.delPattern(pattern);
      return 0;
    } catch (error) {
      logger.error(`[Cache Health] Error clearing pattern ${pattern}:`, error);
      return -1;
    }
  }

  /**
   * Clears potentially corrupted cache entries for an organization.
   *
   * @param organizationId - Organization ID.
   */
  static async clearCorruptedEntries(organizationId: string): Promise<void> {
    logger.info(`[Cache Health] Clearing potentially corrupted cache for org=${organizationId}`);
    await CacheHealth.clearPattern(`org:${organizationId}:*`);
    await CacheHealth.clearPattern(`analytics:*:${organizationId}:*`);
  }
}
