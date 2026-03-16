#!/usr/bin/env bun

import { AgentRuntime } from "@elizaos/core";
import type { Action, Memory } from "@elizaos/core";
import type { AutonomyService } from "@elizaos/core";
import { MemoryType, stringToUuid } from "@elizaos/core";
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
  const sqlPlugin = (await import("@elizaos/plugin-sql")).default;
  const goalsPlugin = (await import("@elizaos/plugin-goals")).default;
  const todoPlugin = (await import("@elizaos/plugin-todo")).default;

  const runtime = new AgentRuntime({
    character,
    plugins: [sqlPlugin, goalsPlugin, todoPlugin, openaiPlugin, minecraftPlugin],
    enableAutonomy: true,
    // Prefer single-action steps for games where world state changes rapidly.
    actionPlanning: false,
    logLevel: "info",
  });

  await runtime.initialize();

  const roomId = stringToUuid("minecraft-room");
  const entityId = stringToUuid("minecraft-autonomy");

  const makeMemory = (text: string): Memory => ({
    entityId,
    roomId,
    createdAt: Date.now(),
    content: { text, source: "system" },
    metadata: { type: MemoryType.MESSAGE, source: "system", scope: "room", timestamp: Date.now() },
  });

  const runAction = async (actionName: string, text: string): Promise<void> => {
    const action = runtime.actions.find(a => a.name === actionName);
    if (!action) return;
    await action.handler(runtime, makeMemory(text), undefined, {}, undefined);
  };

  // Create a starter goal + todos once (so goals/todo are visibly integrated).
  await runAction(
    "CREATE_GOAL",
    "Survive the first night in Minecraft safely: gather wood, craft basic tools, and build a simple shelter.",
  );
  await runAction("CREATE_TODO", "Gather at least 16 logs.");
  await runAction("CREATE_TODO", "Craft a crafting table.");
  await runAction("CREATE_TODO", "Craft a wooden pickaxe.");
  await runAction("CREATE_TODO", "Find or dig a small shelter and wait out night safely.");

  // Ensure the bot connects (uses env vars for host/port/auth/username/version).
  await runAction("MC_CONNECT", "{}");

  // Enable the built-in runtime autonomy loop (autonomy/service.ts).
  // This runs the full message pipeline (providers → LLM → actions → evaluators) on an interval.
  const autonomy = runtime.getService<AutonomyService>("AUTONOMY");
  if (autonomy) {
    autonomy.setLoopInterval(5000);
    await autonomy.enableAutonomy();
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

