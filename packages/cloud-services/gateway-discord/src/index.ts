/**
 * Discord Gateway Service
 *
 * Multi-tenant Discord gateway that maintains WebSocket connections
 * and forwards events to Eliza Cloud.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { hostname } from "os";
import { GatewayManager } from "./gateway-manager";
import { logger } from "./logger";

const app = new Hono();

// Pod name is critical for connection tracking and failover.
// MUST be set in production via POD_NAME env var (K8s injects from metadata.name).
// Fallback to hostname is for local development only - hostname may change in K8s
// if pod is rescheduled, causing orphaned connections.
const podName = process.env.POD_NAME ?? `gateway-${hostname()}`;
if (!process.env.POD_NAME) {
  logger.warn(
    "POD_NAME not set - using hostname fallback. This is only suitable for local development. " +
      "In production, set POD_NAME via K8s downward API to ensure proper failover.",
    { podName },
  );
}

const port = parseInt(process.env.PORT ?? "3000", 10);

// Validate required environment variables - fail fast on misconfiguration
// GATEWAY_BOOTSTRAP_SECRET is required for initial JWT token acquisition
if (!process.env.GATEWAY_BOOTSTRAP_SECRET) {
  logger.error(
    "GATEWAY_BOOTSTRAP_SECRET environment variable is required. " +
      "This secret is used to acquire JWT tokens for API authentication.",
  );
  process.exit(1);
}
const gatewayBootstrapSecret = process.env.GATEWAY_BOOTSTRAP_SECRET;

// Initialize gateway manager
// ELIZA_CLOUD_URL takes precedence, then falls back to NEXT_PUBLIC_APP_URL
// This allows reusing the same env var as the main app for local development
const elizaCloudUrl =
  process.env.ELIZA_CLOUD_URL || process.env.NEXT_PUBLIC_APP_URL || "https://elizacloud.ai";

const project = process.env.PROJECT ?? "cloud";

const gatewayManager = new GatewayManager({
  podName,
  elizaCloudUrl,
  gatewayBootstrapSecret,
  redisUrl: process.env.REDIS_URL ?? process.env.KV_REST_API_URL,
  redisToken: process.env.KV_REST_API_TOKEN,
  project,
});

// Liveness check - is the pod alive and should NOT be restarted?
// Returns 200 for healthy/degraded (don't restart), 503 for unhealthy (restart)
// Degraded pods return 200 because restarting would disconnect all bots
app.get("/health", (c) => {
  const health = gatewayManager.getHealth();
  const alive = health.status !== "unhealthy";
  return c.json(health, alive ? 200 : 503);
});

// Readiness check - can this pod accept new work?
// Returns 503 for degraded/unhealthy/draining to deprioritize in load balancing
// Draining pods are explicitly not ready to prevent new bot assignments
app.get("/ready", (c) => {
  const health = gatewayManager.getHealth();
  const ready =
    !health.draining &&
    health.status === "healthy" &&
    health.controlPlane.healthy &&
    (health.totalBots === 0 || health.connectedBots > 0);
  return c.json({ ready, ...health }, ready ? 200 : 503);
});

// Drain endpoint - called by preStop hook before shutdown
// Marks pod as draining to prevent new assignments while allowing existing bots to continue
// This enables graceful failover without message loss
app.post("/drain", async (c) => {
  await gatewayManager.startDraining();
  return c.json({ draining: true, podName });
});

// Metrics endpoint for Prometheus
app.get("/metrics", (c) => {
  const metrics = gatewayManager.getMetrics();
  return c.text(metrics, 200, { "Content-Type": "text/plain" });
});

// Status endpoint with detailed info
app.get("/status", (c) => {
  const status = gatewayManager.getStatus();
  return c.json(status);
});

// Graceful shutdown
const shutdown = async () => {
  logger.info("Shutting down gracefully...");
  await gatewayManager.shutdown();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Start server
serve({ fetch: app.fetch, port }, () => {
  logger.info(`Discord Gateway started on port ${port}`, { podName });
});

// Start gateway manager
gatewayManager.start().catch((err) => {
  logger.error("Failed to start gateway manager", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
