/**
 * Process entrypoint for hosted agent-server containers.
 *
 * It validates pod configuration before accepting traffic, starts the runtime
 * manager, optionally auto-starts one explicit character reference, and drains
 * in-flight agent work on SIGTERM.
 */
import { Elysia } from "elysia";
import { AgentManager } from "./agent-manager";
import {
  ensureServerName,
  getRequiredEnv,
  type StartupConfig,
  validateStartupEnv,
} from "./config";
import { logger } from "./logger";
import { getRedis } from "./redis";
import { createRoutes } from "./routes";

// Map DATABASE_URL → POSTGRES_URL for @elizaos/plugin-sql
if (process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
  process.env.POSTGRES_URL = process.env.DATABASE_URL;
}

ensureServerName();

let startupConfig: StartupConfig;
try {
  startupConfig = validateStartupEnv();
} catch (err) {
  // error-policy:J1 process startup boundary translates invalid pod config into
  // a fail-fast exit before the HTTP server accepts traffic.
  logger.error("Invalid startup environment", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 3000);
const sharedSecret = getRequiredEnv("AGENT_SERVER_SHARED_SECRET");
const manager = new AgentManager();

// Initialize manager before accepting connections
await manager.initialize();

const { agentId, characterRef } = startupConfig;
if (agentId && characterRef) {
  await manager.startAgent(agentId, characterRef);
  logger.info("Auto-started agent", {
    agentId,
    tier: process.env.TIER,
    characterRef,
  });
}

new Elysia().use(createRoutes(manager, sharedSecret)).listen(PORT);

logger.info("Agent-server listening", {
  serverName: process.env.SERVER_NAME,
  port: PORT,
  tier: process.env.TIER,
  capacity: process.env.CAPACITY,
});

process.on("SIGTERM", async () => {
  logger.info("SIGTERM received, draining...");
  await manager.drain();
  await manager.cleanupRedis();
  const redis = getRedis();
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
  process.exit(0);
});
