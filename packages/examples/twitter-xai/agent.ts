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

  // X (Twitter) is provided by @elizaos/plugin-x. Pick one of the three modes.
  const authMode = (process.env.TWITTER_AUTH_MODE ?? "broker").toLowerCase();
  switch (authMode) {
    case "broker":
      if (
        !process.env.TWITTER_BROKER_TOKEN &&
        !process.env.ELIZAOS_CLOUD_API_KEY
      ) {
        throw new Error(
          "TWITTER_AUTH_MODE=broker requires TWITTER_BROKER_TOKEN or ELIZAOS_CLOUD_API_KEY. Connect your X account on the Eliza Cloud connectors page first.",
        );
      }
      break;
    case "oauth":
      requireEnv("TWITTER_CLIENT_ID");
      requireEnv("TWITTER_REDIRECT_URI");
      break;
    case "env":
      requireEnv("TWITTER_API_KEY");
      requireEnv("TWITTER_API_SECRET_KEY");
      requireEnv("TWITTER_ACCESS_TOKEN");
      requireEnv("TWITTER_ACCESS_TOKEN_SECRET");
      break;
    default:
      throw new Error(
        `Invalid TWITTER_AUTH_MODE=${authMode}. Expected broker | oauth | env.`,
      );
  }
}

async function main(): Promise<void> {
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

  const sqlPlugin = (await import("@elizaos/plugin-sql")).default;
  const { XAIPlugin } = await import("@elizaos/plugin-xai");
  const xPlugin = (await import("@elizaos/plugin-x")).default;

  const runtime = new AgentRuntime({
    character,
    plugins: [sqlPlugin, XAIPlugin, xPlugin],
  });

  console.log("⏳ Initializing runtime...");
  await runtime.initialize();

  // Fail fast if the Twitter service did not start (registerPlugin starts services async).
  await runtime.getServiceLoadPromise("x");

  console.log(`\n✅ Agent "${character.name}" is now running on X.`);
  console.log(`   Dry run mode: ${process.env.TWITTER_DRY_RUN === "true"}`);
  console.log(
    `   Replies enabled: ${(process.env.TWITTER_ENABLE_REPLIES ?? "true") !== "false"}`,
  );
  console.log(
    `   Posting enabled: ${process.env.TWITTER_ENABLE_POST === "true"}`,
  );
  console.log(
    `   Timeline actions enabled: ${process.env.TWITTER_ENABLE_ACTIONS === "true"}`,
  );
  console.log("\n   Press Ctrl+C to stop.\n");

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received. Shutting down...`);
    await runtime.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Keep process alive; the Twitter service runs polling loops internally.
  await new Promise(() => {});
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Fatal error: ${message}`);
  process.exit(1);
});
