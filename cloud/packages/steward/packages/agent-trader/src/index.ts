/**
 * @stwd/agent-trader — Autonomous Agent Trading Service
 *
 * Entry point.  Bootstraps the service:
 *   1. Loads configuration
 *   2. Initialises the Steward SDK client
 *   3. Starts per-agent trading loops
 *   4. Starts the webhook receiver
 *   5. Registers graceful-shutdown handlers
 */

import { StewardClient } from "@stwd/sdk";
import { loadConfig } from "./config.js";
import { logError, logInfo, logWarn } from "./logger.js";
import type { AgentLoop } from "./loop.js";
import { startAgentLoop } from "./loop.js";
import { createWebhookServer, registerDefaultHandlers } from "./webhook.js";

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logInfo("agent-trader starting", { version: "0.3.0" });

  // 1. Config
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    logError("Failed to load configuration", err);
    process.exit(1);
    // Unreachable — TypeScript doesn't infer process.exit as never
    return;
  }

  const enabledAgents = config.agents.filter((a) => a.enabled);
  const disabledCount = config.agents.length - enabledAgents.length;

  logInfo("Configuration loaded", {
    tenantId: config.steward.tenantId,
    apiUrl: config.steward.apiUrl,
    agentsTotal: config.agents.length,
    agentsEnabled: enabledAgents.length,
    agentsDisabled: disabledCount,
    webhookPort: config.webhookPort,
    dryRun: config.dryRun ?? false,
  });

  if (disabledCount > 0) {
    logWarn(`${disabledCount} agent(s) are disabled and will not trade`);
  }

  if (enabledAgents.length === 0) {
    logWarn("No enabled agents found — running in webhook-only mode");
  }

  // 2. Steward SDK client
  const steward = new StewardClient({
    baseUrl: config.steward.apiUrl,
    apiKey: config.steward.apiKey,
    tenantId: config.steward.tenantId,
  });

  // Quick connectivity check (non-fatal)
  try {
    await steward.listAgents();
    logInfo("Steward API reachable ✓");
  } catch (err) {
    logWarn("Steward API connectivity check failed — will retry on first tick", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Trading loops
  const loops: AgentLoop[] = [];

  for (const agentConfig of enabledAgents) {
    try {
      const loop = startAgentLoop(agentConfig, steward, config);
      loops.push(loop);
    } catch (err) {
      logError(`Failed to start loop for agent "${agentConfig.agentId}"`, err);
    }
  }

  // 4. Webhook receiver
  const webhookServer = createWebhookServer(config.webhookPort, config.webhookSecret);
  registerDefaultHandlers(webhookServer);

  try {
    await webhookServer.start();
  } catch (err) {
    logError("Failed to start webhook server", err);
    // Non-fatal — trading loops can still run without the webhook server
  }

  logInfo("agent-trader running", {
    activeLoops: loops.length,
    webhookPort: config.webhookPort,
    dryRun: config.dryRun ?? false,
  });

  // 5. Graceful shutdown
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logInfo(`Received ${signal} — shutting down gracefully…`);

    // Stop all trading loops
    for (const loop of loops) {
      loop.stop();
    }

    // Stop webhook server
    try {
      await webhookServer.stop();
    } catch (err) {
      logError("Error stopping webhook server", err);
    }

    logInfo("agent-trader stopped");
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("uncaughtException", (err: Error) => {
    logError("Uncaught exception", err);
    void shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason: unknown) => {
    logError(
      "Unhandled promise rejection",
      reason instanceof Error ? reason : new Error(String(reason)),
    );
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
