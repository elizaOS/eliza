#!/usr/bin/env bun

/**
 * Soulmates Agent - Ori, the AI matchmaker
 *
 * This agent:
 * - Handles inbound iMessage/SMS via Blooio webhooks
 * - Manages the complete onboarding flow
 * - Coordinates scheduling between matched users
 * - Persists conversations and memories to SQL database
 * - Uses OpenAI for language understanding
 *
 * Architecture:
 * - character.ts: Ori's personality and templates
 * - soulmates-form.ts: Stage-based onboarding forms
 * - flow-orchestrator.ts: User lifecycle state machine
 * - engine/: Matching and scheduling engine
 */

import { AgentRuntime } from "@elizaos/core";
import blooioPlugin from "@elizaos/plugin-blooio";
import { formPlugin } from "@elizaos/plugin-form";
import { openaiPlugin } from "@elizaos/plugin-openai";
import sqlPlugin from "@elizaos/plugin-sql";
import { config } from "dotenv";

import { character } from "./character";
import { flowOrchestratorPlugin } from "./flow-orchestrator";
import { matchingServicePlugin } from "./matching-service";
import { notificationServicePlugin } from "./notification-service";
import { soulmatesFormPlugin } from "./soulmates-form";

// Load environment variables
config({ path: "../.env" });
config(); // Also check current directory

/**
 * Validate required environment variables
 */
function validateEnvironment(): void {
  const required = ["BLOOIO_API_KEY", "BLOOIO_WEBHOOK_URL"];
  const missing = required.filter(
    (key) => !process.env[key] || process.env[key]?.trim() === "",
  );

  if (missing.length > 0) {
    console.error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
    console.error("   Copy env.example to .env and fill in your credentials.");
    process.exit(1);
  }

  // Check for model provider
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
  console.log("Starting Ori (Soulmates Agent)...\n");

  validateEnvironment();

  // Create the runtime with all required plugins
  const runtime = new AgentRuntime({
    character,
    checkShouldRespond: false,
    plugins: [
      // Core infrastructure
      sqlPlugin, // Database persistence
      openaiPlugin, // LLM provider

      // Communication
      blooioPlugin, // Blooio iMessage/SMS client

      // Conversational forms (must be before dependent plugins)
      formPlugin,

      // Soulmates-specific plugins
      soulmatesFormPlugin, // Onboarding forms
      flowOrchestratorPlugin, // User lifecycle management
      matchingServicePlugin, // Matching engine integration
      notificationServicePlugin, // Reminders and check-ins
    ],
    logLevel: "info",
  });

  // Initialize the runtime (starts all services)
  await runtime.initialize();

  console.log(`\nAgent "${character.name}" is now running!`);
  console.log(
    `   From number: ${process.env.BLOOIO_FROM_NUMBER ?? "(default)"}`,
  );
  console.log(`   Webhook URL: ${process.env.BLOOIO_WEBHOOK_URL}`);
  console.log("\n   Press Ctrl+C to stop.\n");

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    await runtime.stop();
    console.log("Goodbye!");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep the process running
  await new Promise(() => {});
}

main().catch((error: { message?: string }) => {
  console.error("Fatal error:", error.message ?? "Unknown error");
  process.exit(1);
});
