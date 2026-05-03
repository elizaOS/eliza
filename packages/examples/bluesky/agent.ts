#!/usr/bin/env bun

/**
 * Bluesky Agent - A full-featured AI agent running on Bluesky
 *
 * This agent uses the COMPLETE elizaOS runtime pipeline:
 * - Full message processing through messageService.handleMessage()
 * - State composition with all registered providers
 * - Action planning and execution
 * - Response generation via messageHandlerTemplate
 * - Evaluator execution
 * - basicCapabilities enabled by default (REPLY, IGNORE, NONE actions)
 *
 * NO shortcuts, NO bypassing the pipeline - this is canonical elizaOS.
 */

import { AgentRuntime, type Plugin, stringToUuid } from "@elizaos/core";
import { config } from "dotenv";

import { character } from "./character";
import { registerBlueskyHandlers } from "./handlers";

// Load environment variables from parent directory and current directory
config({ path: "../.env" });
config();

// ============================================================================
// Environment Validation
// ============================================================================

/**
 * Validate required environment variables
 */
function validateEnvironment(): void {
  const required = ["BLUESKY_HANDLE", "BLUESKY_PASSWORD"];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error(
      `❌ Missing required environment variables: ${missing.join(", ")}`,
    );
    console.error("   Copy env.example to .env and fill in your credentials.");
    process.exit(1);
  }

  // Check for at least one model provider
  const hasModelProvider =
    process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;

  if (!hasModelProvider) {
    console.error(
      "❌ No model provider configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.",
    );
    process.exit(1);
  }
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  console.log("🦋 Starting Bluesky Agent...\n");

  validateEnvironment();

  // Dynamically import plugins to handle workspace build order
  // These are workspace dependencies that need to be built first
  const sqlPlugin = (await import("@elizaos/plugin-sql")).default;
  const { openaiPlugin } = await import("@elizaos/plugin-openai");
  const blueskyModuleId: string = "@elizaos/plugin-bluesky";
  const { blueSkyPlugin } = (await import(blueskyModuleId)) as {
    blueSkyPlugin: Plugin;
  };

  // Create the runtime with all required plugins
  // Note: basicCapabilities is true by default (provides REPLY, IGNORE, NONE actions)
  const runtime = new AgentRuntime({
    character,
    plugins: [
      sqlPlugin, // Database persistence (PGLite by default, or Postgres)
      openaiPlugin, // LLM provider (registers TEXT_SMALL, TEXT_LARGE models)
      blueSkyPlugin, // Bluesky client (polls notifications, handles DMs)
    ],
    // These are the defaults, explicitly shown for clarity:
    // disableBasicCapabilities: false,  // Keep basic actions (REPLY, IGNORE, NONE)
    // enableExtendedCapabilities: false, // Extended features (facts, roles, etc.)
    // actionPlanning: undefined,         // Uses ACTION_PLANNING setting or defaults to true
    // checkShouldRespond: undefined,     // Uses CHECK_SHOULD_RESPOND setting or defaults to true
  });

  // Register Bluesky-specific event handlers
  // These handlers process notifications through the FULL elizaOS pipeline
  registerBlueskyHandlers(runtime);

  // Initialize the runtime
  // This starts all services including:
  // - Database adapter (creates tables, runs migrations)
  // - Model providers (registers handlers for TEXT_SMALL, TEXT_LARGE, etc.)
  // - MessageService (the core message processing pipeline)
  // - BlueSky service (authenticates, starts polling)
  console.log("⏳ Initializing runtime...");
  await runtime.initialize();

  // Ensure the Bluesky world exists for room management
  const worldId = stringToUuid("bluesky-world");
  await runtime.ensureWorldExists({
    id: worldId,
    name: "Bluesky",
    agentId: runtime.agentId,
    messageServerId: worldId,
    metadata: {
      description: "Bluesky social network",
      extra: {
        platform: "bluesky",
      },
    },
  });

  // Log startup info
  console.log(`\n✅ Agent "${character.name}" is now running on Bluesky!`);
  console.log(`   Handle: ${process.env.BLUESKY_HANDLE}`);
  console.log(
    `   Polling interval: ${process.env.BLUESKY_POLL_INTERVAL || 60}s`,
  );
  console.log(
    `   Automated posting: ${process.env.BLUESKY_ENABLE_POSTING !== "false"}`,
  );
  console.log(
    `   DM processing: ${process.env.BLUESKY_ENABLE_DMS !== "false"}`,
  );
  console.log(`   Dry run mode: ${process.env.BLUESKY_DRY_RUN === "true"}`);
  console.log("\n   Using FULL elizaOS pipeline:");
  console.log("   - State composition with providers");
  console.log("   - shouldRespond evaluation");
  console.log("   - Action planning & execution");
  console.log("   - Evaluators");
  console.log("\n   Press Ctrl+C to stop.\n");

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    try {
      await runtime.stop();
      console.log("👋 Goodbye!");
    } catch (error) {
      console.error("Error during shutdown:", error);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep the process running
  // The BlueSky service runs polling in the background
  await new Promise(() => {});
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
