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
}

const LLM_PROVIDERS: LLMProvider[] = [
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

async function loadLLMPlugin(): Promise<{ plugin: Plugin; providerName: string } | null> {
  for (const provider of LLM_PROVIDERS) {
    if (hasValidApiKey(provider.envKey)) {
      try {
        const module = await import(provider.importPath);
        const plugin = module[provider.exportName] || module.default;
        if (plugin) {
          return { plugin, providerName: provider.name };
        }
      } catch (error) {
        console.warn(`⚠️  Failed to load ${provider.name} plugin: ${error}`);
        continue;
      }
    }
  }
  return null;
}

function printAvailableProviders(): void {
  console.log("\n📋 Supported LLM providers and their API keys:\n");
  for (const provider of LLM_PROVIDERS) {
    const hasKey = hasValidApiKey(provider.envKey);
    const status = hasKey ? "✅" : "❌";
    console.log(`   ${status} ${provider.name.padEnd(25)} ${provider.envKey}`);
  }
  console.log("\n💡 Set one of these environment variables in your .env file");
  console.log("   or export it in your shell before running this example.\n");
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
