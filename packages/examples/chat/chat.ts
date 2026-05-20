import "dotenv/config";
import * as readline from "node:readline";
import {
  AgentRuntime,
  ChannelType,
  type Character,
  createCharacter,
  createMessageMemory,
  type Plugin,
  stringToUuid,
  type UUID,
} from "@elizaos/core";

export type LLMProvider = {
  name: string;
  envKey: string;
  specifier: string;
};

export const LLM_PROVIDERS: LLMProvider[] = [
  {
    name: "OpenAI",
    envKey: "OPENAI_API_KEY",
    specifier: "@elizaos/plugin-openai",
  },
  {
    name: "Anthropic (Claude)",
    envKey: "ANTHROPIC_API_KEY",
    specifier: "@elizaos/plugin-anthropic",
  },
  {
    name: "xAI (Grok)",
    envKey: "XAI_API_KEY",
    specifier: "@elizaos/plugin-xai",
  },
  {
    name: "Google GenAI (Gemini)",
    envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
    specifier: "@elizaos/plugin-google-genai",
  },
  {
    name: "Groq",
    envKey: "GROQ_API_KEY",
    specifier: "@elizaos/plugin-groq",
  },
];

export function hasValidApiKey(envKey: string): boolean {
  const value = process.env[envKey];
  return typeof value === "string" && value.trim().length > 0;
}

export async function detectLLMPlugin(): Promise<{
  plugin: Plugin;
  providerName: string;
} | null> {
  for (const provider of LLM_PROVIDERS) {
    if (hasValidApiKey(provider.envKey)) {
      const module = (await import(/* @vite-ignore */ provider.specifier)) as {
        default: Plugin;
      };
      return {
        plugin: module.default,
        providerName: provider.name,
      };
    }
  }
  return null;
}

export function printAvailableProviders(): void {
  console.log("\nSupported LLM providers and their API keys:\n");
  for (const provider of LLM_PROVIDERS) {
    const hasKey = hasValidApiKey(provider.envKey);
    const status = hasKey ? "set" : "missing";
    console.log(`   ${status} ${provider.name.padEnd(25)} ${provider.envKey}`);
  }
  console.log("\nSet one of these environment variables in your .env file");
  console.log("   or export it in your shell before running this example.\n");
}

async function main() {
  console.log("Starting Eliza Chat...\n");

  const llmResult = await detectLLMPlugin();

  if (!llmResult) {
    console.error("No valid LLM API key found.\n");
    printAvailableProviders();
    process.exit(1);
  }

  console.log(`Using ${llmResult.providerName} for language model\n`);

  const { default: sqlPlugin } = await import("@elizaos/plugin-sql");

  const character: Character = createCharacter({
    name: "Eliza",
    bio: "A helpful AI assistant.",
  });

  const runtime = new AgentRuntime({
    character,
    plugins: [sqlPlugin, llmResult.plugin],
  });
  await runtime.initialize();

  const userId = crypto.randomUUID() as UUID;
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

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("Chat with Eliza (type 'exit' to quit)\n");

  const prompt = () => {
    rl.question("You: ", async (input) => {
      const text = input.trim();

      if (text.toLowerCase() === "exit") {
        console.log("\nGoodbye.");
        rl.close();
        await runtime.stop();
        process.exit(0);
      }

      if (!text) {
        prompt();
        return;
      }

      const message = createMessageMemory({
        id: crypto.randomUUID() as UUID,
        entityId: userId,
        roomId,
        content: {
          text,
          source: "client_chat",
          channelType: ChannelType.DM,
        },
      });

      const messageService = runtime.messageService;
      if (!messageService) {
        throw new Error("Message service not initialized");
      }

      process.stdout.write("Eliza: ");

      await messageService.handleMessage(runtime, message, async (content) => {
        if (content?.text) {
          process.stdout.write(content.text);
        }
        return [];
      });

      console.log("\n");
      prompt();
    });
  };

  prompt();
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
