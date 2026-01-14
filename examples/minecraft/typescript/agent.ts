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

async function main(): Promise<void> {
  loadDotEnv({ path: "../.env" });
  loadDotEnv();

  // This example uses OpenAI for the LLM brain.
  requireEnv("OPENAI_API_KEY");

  const minecraftPlugin = (await import("@elizaos/plugin-minecraft")).default;
  const openaiPlugin = (await import("@elizaos/plugin-openai")).default;

  const runtime = new AgentRuntime({
    character,
    plugins: [openaiPlugin, minecraftPlugin],
  });

  await runtime.initialize();

  // Bring the bot online immediately.
  const msg = {
    content: { text: "{}", source: "system" },
  } as const;
  const action = runtime.getAction("MC_CONNECT");
  if (action) {
    await action.handler(runtime, msg as never);
  }

  // Keep process alive; you can drive via your chat/UI in your Eliza setup.
  await new Promise(() => {});
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(message);
  process.exit(1);
});

