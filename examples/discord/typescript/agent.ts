#!/usr/bin/env bun

/**
 * Discord Agent - A full-featured AI agent running on Discord
 *
 * This agent:
 * - Responds to @mentions and replies
 * - Handles slash commands (/ping, /about, /help)
 * - Persists conversations and memories to SQL database
 * - Uses OpenAI for language understanding
 */

import { AgentRuntime } from "@elizaos/core";
import discordPlugin from "@elizaos/plugin-discord";
import { openaiPlugin } from "@elizaos/plugin-openai";
import sqlPlugin from "@elizaos/plugin-sql";
import { config } from "dotenv";

import { character } from "./character";
import { registerDiscordHandlers, registerSlashCommands } from "./handlers";

// Load environment variables
config({ path: "../.env" });
config(); // Also check current directory

/**
 * Validate required environment variables
 */
function validateEnvironment(): void {
  const required = ["DISCORD_APPLICATION_ID", "DISCORD_API_TOKEN"];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error(
      `❌ Missing required environment variables: ${missing.join(", ")}`,
    );
    console.error("   Copy env.example to .env and fill in your credentials.");
    process.exit(1);
  }

  // Check for model provider
  const hasModelProvider =
    process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;

  if (!hasModelProvider) {
    console.error(
      "❌ No model provider configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.",
    );
    process.exit(1);
  }

  // Optional: Check for Telegram token (for multi-bot setup)
  if (process.env.TELEGRAM_BOT_TOKEN) {
    console.log("   Telegram token detected (for multi-platform setup)");
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log("🤖 Starting Discord Agent...\n");

  validateEnvironment();

  // Create the runtime with all required plugins
  const runtime = new AgentRuntime({
    character,
    plugins: [
      sqlPlugin, // Database persistence
      openaiPlugin, // LLM provider
      discordPlugin, // Discord client
    ],
    logLevel: "info",
  });

  // Register custom event handlers
  registerDiscordHandlers(runtime);

  // Initialize the runtime (starts all services)
  await runtime.initialize();

  // Register slash commands after Discord is connected
  await registerSlashCommands(runtime);

  console.log(`\n✅ Agent "${character.name}" is now running on Discord!`);
  console.log(`   Application ID: ${process.env.DISCORD_APPLICATION_ID}`);
  console.log(`   Responds to: @mentions and replies`);
  console.log(`   Slash commands: /ping, /about, /help`);
  console.log("\n   Press Ctrl+C to stop.\n");

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n🛑 ${signal} received. Shutting down gracefully...`);
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
