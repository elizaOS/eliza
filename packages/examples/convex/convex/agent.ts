"use node";

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
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

interface LLMProvider {
  name: string;
  envKey: string;
  loadPlugin: () => Promise<Plugin>;
}

const LLM_PROVIDERS: LLMProvider[] = [
  {
    name: "OpenAI",
    envKey: "OPENAI_API_KEY",
    loadPlugin: async () =>
      (await import("@elizaos/plugin-openai")).default as Plugin,
  },
  {
    name: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    loadPlugin: async () =>
      (await import("@elizaos/plugin-anthropic")).default as Plugin,
  },
  {
    name: "xAI (Grok)",
    envKey: "XAI_API_KEY",
    loadPlugin: async () =>
      (await import("@elizaos/plugin-xai")).default as Plugin,
  },
  {
    name: "Google GenAI (Gemini)",
    envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
    loadPlugin: async () =>
      (await import("@elizaos/plugin-google-genai")).default as Plugin,
  },
  {
    name: "Groq",
    envKey: "GROQ_API_KEY",
    loadPlugin: async () =>
      (await import("@elizaos/plugin-groq")).default as unknown as Plugin,
  },
];

function hasValidApiKey(envKey: string): boolean {
  const value = process.env[envKey];
  return typeof value === "string" && value.trim().length > 0;
}

function detectLLMProvider(): LLMProvider | null {
  for (const provider of LLM_PROVIDERS) {
    if (hasValidApiKey(provider.envKey)) {
      return provider;
    }
  }
  return null;
}

let cachedRuntime: AgentRuntime | null = null;
let cachedProviderName: string | null = null;

async function getOrCreateRuntime(): Promise<{
  runtime: AgentRuntime;
  providerName: string;
}> {
  if (cachedRuntime && cachedProviderName) {
    return { runtime: cachedRuntime, providerName: cachedProviderName };
  }

  const llmProvider = detectLLMProvider();
  if (!llmProvider) {
    throw new Error(
      "No valid LLM API key found. Set one of: " +
        LLM_PROVIDERS.map((p) => p.envKey).join(", "),
    );
  }

  const character: Character = createCharacter({
    name: "Eliza",
    bio: "A helpful AI assistant powered by elizaOS, running on Convex.",
  });

  const { default: sqlPlugin } = await import("@elizaos/plugin-sql");
  const llmPlugin = await llmProvider.loadPlugin();

  const runtime = new AgentRuntime({
    character,
    plugins: [sqlPlugin, llmPlugin],
  });

  await runtime.initialize();

  cachedRuntime = runtime;
  cachedProviderName = llmProvider.name;

  return { runtime, providerName: llmProvider.name };
}

export const chat = internalAction({
  args: {
    message: v.string(),
    conversationId: v.string(),
    userId: v.optional(v.string()),
  },
  returns: v.object({
    response: v.string(),
    conversationId: v.string(),
    agentName: v.string(),
    provider: v.string(),
  }),
  handler: async (ctx, args) => {
    const { runtime, providerName } = await getOrCreateRuntime();

    const userId = (args.userId ?? crypto.randomUUID()) as UUID;
    const roomId = stringToUuid(`convex-room-${args.conversationId}`);
    const worldId = stringToUuid("convex-world");

    await runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      userName: "User",
      source: "convex",
      channelId: args.conversationId,
      type: ChannelType.DM,
    });

    await ctx.runMutation(internal.messages.store, {
      conversationId: args.conversationId,
      role: "user" as const,
      text: args.message,
      entityId: userId,
    });

    const memory = createMessageMemory({
      id: crypto.randomUUID() as UUID,
      entityId: userId,
      roomId,
      content: {
        text: args.message,
        source: "convex",
        channelType: ChannelType.DM,
      },
    });

    let responseText = "";

    const messageService = runtime.messageService;
    if (!messageService) {
      throw new Error("Message service not initialized");
    }
    await messageService.handleMessage(runtime, memory, async (content) => {
      if (content?.text) {
        responseText += content.text;
      }
      return [];
    });

    if (!responseText) {
      responseText = "I'm sorry, I wasn't able to generate a response.";
    }

    await ctx.runMutation(internal.messages.store, {
      conversationId: args.conversationId,
      role: "assistant" as const,
      text: responseText,
      entityId: runtime.agentId,
    });

    return {
      response: responseText,
      conversationId: args.conversationId,
      agentName: runtime.character?.name ?? "Eliza",
      provider: providerName,
    };
  },
});
