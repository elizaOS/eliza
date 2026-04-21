#!/usr/bin/env bun

import { AgentRuntime } from "@elizaos/core";
import { config as loadDotEnv } from "dotenv";

import { character } from "./character";

function requireEnv(key: string): string {
  const value = process.env[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function validateEnvironment(): void {
  // Grok (xAI) is the model provider for this example.
  requireEnv("XAI_API_KEY");

  // X API user-context OAuth 1.0a (recommended for posting/replying).
  const authMode = (process.env.X_AUTH_MODE ?? "env").toLowerCase();
  if (authMode !== "env") {
    throw new Error(
      `This example expects X_AUTH_MODE=env (OAuth 1.0a). Got X_AUTH_MODE=${process.env.X_AUTH_MODE ?? ""}`,
    );
  }

  requireEnv("X_API_KEY");
  requireEnv("X_API_SECRET");
  requireEnv("X_ACCESS_TOKEN");
  requireEnv("X_ACCESS_TOKEN_SECRET");
}

async function main(): Promise<void> {
  // Load environment variables from parent directory and current directory.
  loadDotEnv({ path: "../.env" });
  loadDotEnv();

  console.log("𝕏 Starting X (Grok) Agent...\n");

  try {
    validateEnvironment();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`❌ ${message}`);
    console.error(
      "   Copy examples/twitter-xai/env.example to examples/twitter-xai/.env and fill in credentials.",
    );
    process.exit(1);
  }

  // Dynamically import workspace plugins (matches other examples).
  const sqlPlugin = (await import("@elizaos/plugin-sql")).default;
  const { XAIPlugin } = await import("@elizaos/plugin-xai");

  const runtime = new AgentRuntime({
    character,
    plugins: [sqlPlugin, XAIPlugin],
  });

  console.log("⏳ Initializing runtime...");
  await runtime.initialize();

  // Fail fast if the X service did not start (registerPlugin starts services async).
  // This prevents "agent is running" logs when the X integration is actually down.
  await runtime.getServiceLoadPromise("x");

  console.log(`\n✅ Agent "${character.name}" is now running on X.`);
  console.log(`   Dry run mode: ${process.env.X_DRY_RUN === "true"}`);
  console.log(
    `   Replies enabled: ${(process.env.X_ENABLE_REPLIES ?? "true") !== "false"}`,
  );
  console.log(`   Posting enabled: ${process.env.X_ENABLE_POST === "true"}`);
  console.log(
    `   Timeline actions enabled: ${process.env.X_ENABLE_ACTIONS === "true"}`,
  );
  console.log(
    `   Discovery enabled: ${process.env.X_ENABLE_DISCOVERY === "true"}`,
  );
  console.log("\n   Press Ctrl+C to stop.\n");

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received. Shutting down...`);
    await runtime.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Keep process alive; the X service runs polling loops internally.
  await new Promise(() => {});
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Fatal error: ${message}`);
  process.exit(1);
});
