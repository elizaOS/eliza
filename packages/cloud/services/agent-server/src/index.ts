// Runs the hosted agent-server index boundary for cloud runtime containers.
import { Elysia } from "elysia";
import { AgentManager } from "./agent-manager";
import {
  ensureServerName,
  getAutoStartAgentConfig,
  getRequiredEnv,
} from "./config";
import { logger } from "./logger";
import { getRedis } from "./redis";
import { createRoutes } from "./routes";

// Map DATABASE_URL → POSTGRES_URL for @elizaos/plugin-sql
if (process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
  process.env.POSTGRES_URL = process.env.DATABASE_URL;
}

ensureServerName();

const required = [
  "SERVER_NAME",
  "REDIS_URL",
  "DATABASE_URL",
  "CAPACITY",
  "TIER",
  "AGENT_SERVER_SHARED_SECRET",
];
for (const key of required) {
  try {
    getRequiredEnv(key);
  } catch {
    logger.error("Missing required env var", { key });
    process.exit(1);
  }
}

let autoStartAgent: ReturnType<typeof getAutoStartAgentConfig>;
try {
  autoStartAgent = getAutoStartAgentConfig();
} catch (err) {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 3000);
const sharedSecret = getRequiredEnv("AGENT_SERVER_SHARED_SECRET");
const manager = new AgentManager();

// Initialize manager before accepting connections
await manager.initialize();

if (autoStartAgent) {
  const { agentId, characterRef } = autoStartAgent;
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
