import "dotenv/config";
import * as readline from "node:readline";
import {
  AgentRuntime,
  ChannelType,
  createCharacter,
  type Character,
  createMessageMemory,
  stringToUuid,
  type UUID,
  type Plugin,
} from "@elizaos/core";
import sqlPlugin from "@elizaos/plugin-sql";
import { v4 as uuidv4 } from "uuid";

// ============================================================================
// LLM Provider Detection
// ============================================================================

interface LLMProvider {
  name: string;
  envKey: string;
  importPath: string;
  exportName: string;
  /** If true, provider doesn't need an API key (e.g. local server) */
  local?: boolean;
  /** How to detect if the local provider is available */
  detectUrl?: string;
}

const LLM_PROVIDERS: LLMProvider[] = [
  // Local providers first — no API key needed
  {
    name: "Ollama (local)",
    envKey: "OLLAMA_API_URL",
    importPath: "@elizaos/plugin-ollama",
    exportName: "ollamaPlugin",
    local: true,
    detectUrl: "http://localhost:11434/api/tags",
  },
  {
    name: "Local AI",
    envKey: "LOCAL_AI_URL",
    importPath: "@elizaos/plugin-local-ai",
    exportName: "localAiPlugin",
    local: true,
  },
  // Cloud providers — require API keys
  {
    name: "OpenAI",
    envKey: "OPENAI_API_KEY",
    importPath: "@elizaos/plugin-openai",
    exportName: "openaiPlugin",
  },
  {
    name: "Anthropic (Claude)",
    envKey: "ANTHROPIC_API_KEY",
    importPath: "@elizaos/plugin-anthropic",
    exportName: "anthropicPlugin",
  },
  {
    name: "xAI (Grok)",
    envKey: "XAI_API_KEY",
    importPath: "@elizaos/plugin-xai",
    exportName: "xaiPlugin",
  },
  {
    name: "Google GenAI (Gemini)",
    envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
    importPath: "@elizaos/plugin-google-genai",
    exportName: "googleGenaiPlugin",
  },
  {
    name: "Groq",
    envKey: "GROQ_API_KEY",
    importPath: "@elizaos/plugin-groq",
    exportName: "groqPlugin",
  },
];

function hasValidApiKey(envKey: string): boolean {
  const value = process.env[envKey];
  return typeof value === "string" && value.trim().length > 0;
}

async function isLocalServerRunning(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

async function tryLoadPlugin(provider: LLMProvider): Promise<{ plugin: Plugin; providerName: string } | null> {
  try {
    const module = await import(provider.importPath);
    const plugin = module[provider.exportName] || module.default;
    if (plugin) {
      return { plugin, providerName: provider.name };
    }
  } catch (error) {
    console.warn(`⚠️  Failed to load ${provider.name} plugin: ${error}`);
  }
  return null;
}

async function loadLLMPlugin(): Promise<{ plugin: Plugin; providerName: string } | null> {
  // Pass 1: Check providers that the user has EXPLICITLY configured via env vars.
  //         This means cloud API keys and local URLs that were manually set.
  //         An explicit config always wins over auto-detection.
  for (const provider of LLM_PROVIDERS) {
    if (provider.local) {
      const envUrl = process.env[provider.envKey];
      if (!envUrl) continue; // not explicitly configured — skip for now
      const running = await isLocalServerRunning(envUrl);
      if (!running) {
        console.warn(`⚠️  ${provider.name} configured at ${envUrl} but not reachable, skipping`);
        continue;
      }
      const result = await tryLoadPlugin(provider);
      if (result) return result;
    } else {
      if (!hasValidApiKey(provider.envKey)) continue;
      const result = await tryLoadPlugin(provider);
      if (result) return result;
    }
  }

  // Pass 2: No explicit config found. Auto-detect local providers (e.g. Ollama on localhost).
  for (const provider of LLM_PROVIDERS) {
    if (!provider.local || !provider.detectUrl) continue;
    if (process.env[provider.envKey]) continue; // already tried in pass 1
    const running = await isLocalServerRunning(provider.detectUrl);
    if (!running) continue;
    const result = await tryLoadPlugin(provider);
    if (result) return result;
  }

  return null;
}

function printAvailableProviders(): void {
  console.log("\n📋 Supported LLM providers:\n");
  console.log("   Local (no API key needed):");
  for (const provider of LLM_PROVIDERS.filter((p) => p.local)) {
    console.log(`   ❌ ${provider.name.padEnd(25)} (not detected — start the server or set ${provider.envKey})`);
  }
  console.log("\n   Cloud (API key required):");
  for (const provider of LLM_PROVIDERS.filter((p) => !p.local)) {
    const hasKey = hasValidApiKey(provider.envKey);
    const status = hasKey ? "✅" : "❌";
    console.log(`   ${status} ${provider.name.padEnd(25)} ${provider.envKey}`);
  }
  console.log("\n💡 Easiest: install Ollama (https://ollama.com), run `ollama serve`,");
  console.log("   then `ollama pull llama3.1` and restart this example.\n");
  console.log("   Or set a cloud API key in your .env file.\n");
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("🚀 Starting Eliza Chat...\n");

  // Load LLM plugin dynamically
  const llmResult = await loadLLMPlugin();

  if (!llmResult) {
    console.error("❌ No valid LLM API key found!\n");
    printAvailableProviders();
    process.exit(1);
  }

  console.log(`✅ Using ${llmResult.providerName} for language model\n`);

  const character: Character = createCharacter({
    name: "Eliza",
    bio: "A helpful AI assistant.",
  });

  // Create runtime with detected LLM plugin
  const runtime = new AgentRuntime({
    character,
    plugins: [sqlPlugin, llmResult.plugin],
  });
  await runtime.initialize();

  // Setup connection
  const userId = uuidv4() as UUID;
  const roomId = stringToUuid("chat-room");
  const worldId = stringToUuid("chat-world");

  await runtime.ensureConnection({
    entityId: userId,
    roomId,
    worldId,
    userName: "User",
    source: "cli",
    channelId: "chat",
    type: ChannelType.DM,
  });

  // Create readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("💬 Chat with Eliza (type 'exit' to quit)\n");

  const prompt = () => {
    rl.question("You: ", async (input) => {
      const text = input.trim();

      if (text.toLowerCase() === "exit") {
        console.log("\n👋 Goodbye!");
        rl.close();
        await runtime.stop();
        process.exit(0);
      }

      if (!text) {
        prompt();
        return;
      }

      // Create and send message
      const message = createMessageMemory({
        id: uuidv4() as UUID,
        entityId: userId,
        roomId,
        content: {
          text,
          source: "client_chat",
          channelType: ChannelType.DM,
        },
      });

      let _response = "";
      process.stdout.write("Eliza: ");

      await runtime?.messageService?.handleMessage(
        runtime,
        message,
        async (content) => {
          if (content?.text) {
            _response += content.text;
            process.stdout.write(content.text);
          }
          return [];
        },
      );

      console.log("\n");
      prompt();
    });
  };

  prompt();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
