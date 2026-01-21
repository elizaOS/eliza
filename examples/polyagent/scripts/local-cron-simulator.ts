#!/usr/bin/env bun
/**
 * Local Cron Simulator for Polyagent
 *
 * Simulates Vercel Cron locally by calling agent-tick endpoint every minute.
 * This runs autonomous trading agents that trade on Polymarket.
 *
 * Usage:
 *   bun run cron:local      (start local cron)
 *   bun run dev             (in another terminal - web app)
 *
 * Or use dev:full to run both automatically.
 */

const CRON_INTERVAL = 60000; // 60 seconds
const AGENT_TICK_URL = "http://localhost:3000/api/cron/agent-tick";

let intervalId: NodeJS.Timeout | null = null;
let tickCount = 0;

async function executeAgentTick() {
  tickCount++;
  console.info(
    `🤖 Triggering agent tick #${tickCount}...`,
    undefined,
    "LocalCron",
  );

  const response = await fetch(AGENT_TICK_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CRON_SECRET || "development"}`,
      "Content-Type": "application/json",
    },
  }).catch((error: Error) => {
    const errorMessage = error.message;
    console.error(
      `Agent tick #${tickCount} error: ${errorMessage}`,
      { error },
      "LocalCron",
    );

    if (errorMessage.includes("ECONNREFUSED")) {
      console.error(
        "❌ Next.js dev server not running!",
        undefined,
        "LocalCron",
      );
      console.error("   Start it first: bun run dev", undefined, "LocalCron");
      process.exit(1);
    }
    return null;
  });

  if (!response) return;

  // Check content-type before parsing JSON
  const contentType = response.headers.get("content-type") || "";

  if (!response.ok) {
    if (contentType.includes("application/json")) {
      const data = await response.json();
      console.error(
        `Agent tick #${tickCount} failed (HTTP ${response.status})`,
        data,
        "LocalCron",
      );
    } else {
      const text = await response.text();
      console.error(
        `Agent tick #${tickCount} failed (HTTP ${response.status})`,
        {
          body: text.slice(0, 500),
        },
        "LocalCron",
      );
    }
    return;
  }

  if (!contentType.includes("application/json")) {
    console.error(
      `Agent tick #${tickCount} returned non-JSON response`,
      { contentType },
      "LocalCron",
    );
    return;
  }

  const data = await response.json();

  console.info(
    `✅ Agent tick #${tickCount} completed`,
    {
      agentsProcessed: data.processed || 0,
      totalActions: data.totalActions || 0,
      errors: data.errors || 0,
    },
    "LocalCron",
  );
}

async function waitForServer(
  maxAttempts = 30,
  delayMs = 5000,
): Promise<boolean> {
  console.info(
    "Waiting for Next.js server to be ready (first compile may take 30-60s)...",
    undefined,
    "LocalCron",
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // First attempt needs longer timeout for initial compilation (90s)
      // Subsequent attempts can use shorter timeout (30s)
      const timeoutMs = attempt === 1 ? 90000 : 30000;

      const response = await fetch("http://localhost:3000/api/health", {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.ok) {
        console.info(
          `✅ Server ready after ${attempt} attempt(s)`,
          undefined,
          "LocalCron",
        );
        return true;
      }
    } catch (_error) {
      // Server not ready yet, continue waiting
      if (attempt < maxAttempts) {
        console.info(
          `Attempt ${attempt}/${maxAttempts}: Server not ready, waiting ${delayMs}ms...`,
          undefined,
          "LocalCron",
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  console.error(
    "❌ Server did not become ready after maximum attempts",
    undefined,
    "LocalCron",
  );
  return false;
}

async function main() {
  console.info("🔄 POLYAGENT CRON SIMULATOR", undefined, "LocalCron");
  console.info("===========================", undefined, "LocalCron");
  console.info(
    "Running autonomous agent trading ticks every minute",
    undefined,
    "LocalCron",
  );
  console.info("Press Ctrl+C to stop", undefined, "LocalCron");
  console.info("", undefined, "LocalCron");

  // Wait for server to be ready with health check
  const serverReady = await waitForServer();
  if (!serverReady) {
    console.error(
      "Cannot start cron simulator - server is not ready",
      undefined,
      "LocalCron",
    );
    process.exit(1);
  }

  // Execute first tick immediately
  await executeAgentTick();

  // Then execute every minute
  intervalId = setInterval(async () => {
    await executeAgentTick();
  }, CRON_INTERVAL);

  // Handle shutdown gracefully
  const cleanup = () => {
    console.info("Stopping cron simulator...", undefined, "LocalCron");
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    console.info(`Total ticks executed: ${tickCount}`, undefined, "LocalCron");
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  // Keep alive
  await new Promise(() => {});
}

main();
