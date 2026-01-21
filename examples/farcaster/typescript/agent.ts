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
  // OpenAI is the model provider for this example.
  requireEnv("OPENAI_API_KEY");

  // Farcaster / Neynar credentials
  requireEnv("FARCASTER_FID");
  requireEnv("FARCASTER_SIGNER_UUID");
  requireEnv("FARCASTER_NEYNAR_API_KEY");
}

async function main(): Promise<void> {
  // Load environment variables from parent directory and current directory.
  loadDotEnv({ path: "../.env" });
  loadDotEnv();

  console.log("🟣 Starting Farcaster Agent...\n");

  try {
    validateEnvironment();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`❌ ${message}`);
    console.error(
      "   Copy examples/farcaster/env.example to examples/farcaster/.env and fill in credentials.",
    );
    process.exit(1);
  }

  // Dynamically import workspace plugins (matches other examples).
  const sqlPlugin = (await import("@elizaos/plugin-sql")).default;
  const openaiPlugin = (await import("@elizaos/plugin-openai")).default;
  const farcasterPlugin = (await import("@elizaos/plugin-farcaster")).default;

  const runtime = new AgentRuntime({
    character,
    plugins: [sqlPlugin, openaiPlugin, farcasterPlugin],
  });

  console.log("⏳ Initializing runtime...");
  await runtime.initialize();

  // Fail fast if the Farcaster service did not start.
  await runtime.getServiceLoadPromise("farcaster");

  console.log(`\n✅ Agent "${character.name}" is now running on Farcaster.`);
  console.log(`   Dry run mode: ${process.env.FARCASTER_DRY_RUN === "true"}`);
  console.log(`   Casting enabled: ${process.env.ENABLE_CAST === "true"}`);
  console.log(
    `   Polling interval: ${process.env.FARCASTER_POLL_INTERVAL ?? "120"}s`,
  );
  console.log("\n   Press Ctrl+C to stop.\n");

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received. Shutting down...`);
    await runtime.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Keep process alive; the Farcaster service runs polling loops internally.
  await new Promise(() => {});
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Fatal error: ${message}`);
  process.exit(1);
});
