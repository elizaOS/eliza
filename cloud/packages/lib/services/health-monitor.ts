/**
 * Container Health Monitoring Service
 * Monitors deployed containers and updates their health status
 */

import { and, eq } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/client";
import { containers } from "@/db/schemas";
import { logger } from "@/lib/utils/logger";

/**
 * Result of a container health check.
 */
export interface HealthCheckResult {
  containerId: string;
  healthy: boolean;
  statusCode?: number;
  responseTime?: number;
  error?: string;
  checkedAt: Date;
}

/**
 * Configuration for health monitoring.
 */
export interface HealthMonitorConfig {
  checkIntervalMs: number;
  timeout: number;
  unhealthyThreshold: number; // Number of failed checks before marking unhealthy
  retryOnFailure: boolean;
}

const DEFAULT_CONFIG: HealthMonitorConfig = {
  checkIntervalMs: 60000, // 1 minute
  timeout: 10000, // 10 seconds
  unhealthyThreshold: 3,
  retryOnFailure: true,
};

/**
 * Performs health check on a container.
 *
 * @param containerUrl - Container base URL.
 * @param healthCheckPath - Health check endpoint path.
 * @param timeoutMs - Timeout in milliseconds.
 * @returns Health check result.
 */
export async function checkContainerHealth(
  containerUrl: string,
  healthCheckPath: string = "/health",
  timeoutMs: number = 10000,
): Promise<HealthCheckResult> {
  const startTime = Date.now();
  const fullUrl = `${containerUrl}${healthCheckPath}`;

  logger.debug("Performing health check", { url: fullUrl });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const response = await fetch(fullUrl, {
    method: "GET",
    signal: controller.signal,
    headers: {
      "User-Agent": "elizaOS-HealthMonitor/1.0",
    },
  });

  clearTimeout(timeoutId);

  const responseTime = Date.now() - startTime;
  const healthy = response.ok; // 200-299 status codes

  return {
    containerId: "", // Set by caller
    healthy,
    statusCode: response.status,
    responseTime,
    checkedAt: new Date(),
  };
}

/**
 * Updates container health status in database.
 * Only updates status to 'failed' if container is currently 'running'.
 * This prevents overwriting transitional states like 'building' or 'deploying'.
 *
 * @param containerId - Container ID.
 * @param healthResult - Health check result.
 */
export async function updateContainerHealth(
  containerId: string,
  healthResult: HealthCheckResult,
): Promise<void> {
  // RACE CONDITION FIX: Use atomic conditional UPDATE instead of check-then-act
  // This prevents race conditions by including expected status in WHERE clause

  const baseUpdate = {
    last_health_check: healthResult.checkedAt,
    updated_at: new Date(),
  };

  if (!healthResult.healthy) {
    // Atomically mark as failed ONLY if currently running
    // The WHERE clause ensures we only update if status hasn't changed
    const [updatedContainer] = await dbWrite
      .update(containers)
      .set({
        ...baseUpdate,
        status: "failed",
        error_message: healthResult.error || "Health check failed",
      })
      .where(
        and(
          eq(containers.id, containerId),
          eq(containers.status, "running"), // Only update if still running
        ),
      )
      .returning({ id: containers.id });

    // If no rows were updated, container status has changed (not a race condition)
    if (!updatedContainer) {
      // Just update health check timestamp without changing status
      await dbWrite.update(containers).set(baseUpdate).where(eq(containers.id, containerId));

      logger.debug("Container health check failed, but status changed (not running anymore)", {
        containerId,
        healthy: false,
      });
      return;
    }

    logger.info("Container health status updated to failed", {
      containerId,
      healthy: false,
      previousStatus: "running",
      newStatus: "failed",
    });
  } else {
    // Health check passed - atomically restore to running ONLY if currently failed
    const [updatedContainer] = await dbWrite
      .update(containers)
      .set({
        ...baseUpdate,
        status: "running",
        error_message: null,
      })
      .where(
        and(
          eq(containers.id, containerId),
          eq(containers.status, "failed"), // Only restore if currently failed
        ),
      )
      .returning({ id: containers.id });

    if (!updatedContainer) {
      // Just update health check timestamp for non-failed containers
      await dbWrite.update(containers).set(baseUpdate).where(eq(containers.id, containerId));

      logger.debug("Container health check passed, status unchanged", {
        containerId,
        healthy: true,
      });
      return;
    }

    logger.info("Container health status restored to running", {
      containerId,
      healthy: true,
      previousStatus: "failed",
      newStatus: "running",
    });
  }
}

/**
 * Monitor all running containers
 * This should be called periodically (e.g., via cron job)
 */
export async function monitorAllContainers(
  config: Partial<HealthMonitorConfig> = {},
): Promise<HealthCheckResult[]> {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };

  logger.info("Starting health check for all containers");

  // Get all running containers
  const runningContainers = await dbRead
    .select({
      id: containers.id,
      load_balancer_url: containers.load_balancer_url,
      health_check_path: containers.health_check_path,
    })
    .from(containers)
    .where(eq(containers.status, "running"));

  logger.info(`Found ${runningContainers.length} running containers to check`);

  // Check all containers in parallel for better performance
  const results: HealthCheckResult[] = await Promise.all(
    runningContainers.map(async (container) => {
      if (!container.load_balancer_url) {
        logger.warn("Container has no URL, skipping health check", {
          containerId: container.id,
        });
        return {
          healthy: false,
          responseTime: 0,
          error: "No URL configured",
          containerId: container.id,
        } as HealthCheckResult;
      }

      const result = await checkContainerHealth(
        container.load_balancer_url,
        container.health_check_path || "/health",
        finalConfig.timeout,
      );

      // Update database
      await updateContainerHealth(container.id, result);

      if (!result.healthy) {
        logger.warn("Container health check failed", {
          containerId: container.id,
          url: container.load_balancer_url,
          error: result.error,
        });
      }

      return result;
    }),
  );

  const healthyCount = results.filter((r) => r.healthy).length;
  const unhealthyCount = results.length - healthyCount;

  logger.info("Health check completed", {
    total: results.length,
    healthy: healthyCount,
    unhealthy: unhealthyCount,
  });

  return results;
}

/**
 * Get health status for a specific container
 */
export async function getContainerHealthStatus(
  containerId: string,
): Promise<HealthCheckResult | null> {
  // Note: We need to get container without organization_id here
  // So we still use dbRead directly, but this is acceptable for health monitoring
  const results = await dbRead
    .select()
    .from(containers)
    .where(eq(containers.id, containerId))
    .limit(1);

  if (results.length === 0 || !results[0].load_balancer_url) {
    return null;
  }

  const container = results[0];

  if (!container.load_balancer_url) {
    return null;
  }

  const result = await checkContainerHealth(
    container.load_balancer_url,
    container.health_check_path || "/health",
  );

  result.containerId = containerId;
  await updateContainerHealth(containerId, result);

  return result;
}
