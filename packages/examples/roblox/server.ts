import { AgentRuntime, createCharacter } from "@elizaos/core";
import { openaiPlugin } from "@elizaos/plugin-openai";
import { robloxPlugin } from "@elizaos/plugin-roblox";
import sqlPlugin from "@elizaos/plugin-sql";
import { createRobloxBridgeApp } from "./app";
import { elizaClassicXmlPlugin } from "./elizaClassicXmlPlugin";

const PORT = Number(process.env.PORT ?? 3040);
const SHARED_SECRET = process.env.ELIZA_ROBLOX_SHARED_SECRET ?? "";

function envSettings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function createRuntime(): AgentRuntime {
  const character = createCharacter({
    name: "Eliza",
    bio: "A helpful Roblox guide NPC.",
    system:
      "You are a helpful Roblox guide. Be concise. " +
      "If a user asks you to do something in-game (teleport, move NPC, reward coins), you may use Roblox actions.",
  });

  const hasOpenAIKey =
    typeof process.env.OPENAI_API_KEY === "string" &&
    process.env.OPENAI_API_KEY.trim() !== "";

  // If OPENAI_API_KEY is provided, use OpenAI for full agent behavior.
  // Otherwise, use a classic ELIZA model wrapped into elizaOS XML.
  const plugins = hasOpenAIKey
    ? [sqlPlugin, openaiPlugin, robloxPlugin]
    : [sqlPlugin, elizaClassicXmlPlugin, robloxPlugin];

  return new AgentRuntime({
    character,
    plugins,
    // This bridge is a direct chat interface; always respond.
    checkShouldRespond: false,
    // Ensure plugins that use runtime.getSetting() can see env vars.
    settings: envSettings(),
    logLevel: "info",
  });
}

console.log("🚀 Starting Roblox agent bridge...\n");
console.log(`[roblox-bridge] DEBUG_ROBLOX_BRIDGE=${process.env.DEBUG_ROBLOX_BRIDGE ?? ""}`);
const runtime = createRuntime();
await runtime.initialize();

const app = createRobloxBridgeApp(runtime, SHARED_SECRET);

app.listen(PORT, () => {
  console.log(`🌐 Roblox agent bridge listening on http://localhost:${PORT}`);
  console.log(`   POST /roblox/chat`);
  console.log(`   GET  /health\n`);
});

