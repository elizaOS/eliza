#!/usr/bin/env bun

/**
 * Bluesky Agent - A full-featured AI agent running on Bluesky
 *
 * This agent:
 * - Monitors and responds to @mentions
 * - Processes and replies to direct messages
 * - Optionally posts automated content on a schedule
 * - Persists conversations and memories to SQL database
 */

import { AgentRuntime } from "@elizaos/core";
import { config } from "dotenv";

import { character } from "./character";
import { registerBlueskyHandlers } from "./handlers";

// Load environment variables
config({ path: "../.env" });
config(); // Also check current directory

/**
 * Validate required environment variables
 */
function validateEnvironment(): void {
  const required = ["BLUESKY_HANDLE", "BLUESKY_PASSWORD"];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
    console.error("Copy env.example to .env and fill in your credentials.");
    process.exit(1);
  }

  // Check for at least one model provider
  const hasModelProvider =
    process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;

  if (!hasModelProvider) {
    console.error(
      "No model provider configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.",
    );
    process.exit(1);
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log("🦋 Starting Bluesky Agent...\n");

  validateEnvironment();

  // Dynamically import plugins to handle workspace dependencies
  const sqlPlugin = (await import("@elizaos/plugin-sql")).default;
  const { openaiPlugin } = await import("@elizaos/plugin-openai");
  // @ts-expect-error - Workspace plugin resolved at runtime after build
  const { blueSkyPlugin } = await import("@elizaos/plugin-bluesky");

  // Create the runtime with all required plugins
  const runtime = new AgentRuntime({
    character,
    plugins: [
      sqlPlugin, // Database persistence
      openaiPlugin, // LLM provider
      blueSkyPlugin, // Bluesky client
    ],
  });

  // Register custom event handlers for Bluesky interactions
  registerBlueskyHandlers(runtime);

  // Initialize the runtime (starts all services)
  await runtime.initialize();

  console.log(`✅ Agent "${character.name}" is now running on Bluesky!`);
  console.log(`   Handle: ${process.env.BLUESKY_HANDLE}`);
  console.log(
    `   Polling interval: ${process.env.BLUESKY_POLL_INTERVAL || 60}s`,
  );
  console.log(
    `   Automated posting: ${process.env.BLUESKY_ENABLE_POSTING !== "false"}`,
  );
  console.log("\n   Press Ctrl+C to stop.\n");

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    await runtime.stop();
    console.log("👋 Goodbye!");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep the process running
  await new Promise(() => {});
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
