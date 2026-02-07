"use node";

/**
 * Convex Node.js action that runs an elizaOS agent.
 *
 * The "use node" directive enables full Node.js runtime so we can import
 * @elizaos/core and LLM provider plugins. The action receives a chat message,
 * processes it through runtime.messageService.handleMessage, persists both the
 * user message and the agent response to Convex, and returns the result.
 */

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  AgentRuntime,
  ChannelType,
  createCharacter,
  createMessageMemory,
  stringToUuid,
  type Character,
  type Plugin,
  type UUID,
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
    name: "Anthropic",
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

async function loadLLMPlugin(): Promise<{
  plugin: Plugin;
  providerName: string;
} | null> {
  for (const provider of LLM_PROVIDERS) {
    if (hasValidApiKey(provider.envKey)) {
      try {
        const mod = await import(provider.importPath);
        const plugin = mod[provider.exportName] || mod.default;
        if (plugin) {
          return { plugin, providerName: provider.name };
        }
      } catch {
        continue;
      }
    }
  }
  return null;
}

// ============================================================================
// Cached Runtime (survives warm-start reuse within the same Convex isolate)
// ============================================================================

let cachedRuntime: AgentRuntime | null = null;
let cachedProviderName: string | null = null;

async function getOrCreateRuntime(): Promise<{
  runtime: AgentRuntime;
  providerName: string;
}> {
  if (cachedRuntime && cachedProviderName) {
    return { runtime: cachedRuntime, providerName: cachedProviderName };
  }

  const llmResult = await loadLLMPlugin();
  if (!llmResult) {
    throw new Error(
      "No valid LLM API key found. Set one of: " +
        LLM_PROVIDERS.map((p) => p.envKey).join(", "),
    );
  }

  const character: Character = createCharacter({
    name: "Eliza",
    bio: "A helpful AI assistant powered by elizaOS, running on Convex.",
  });

  const runtime = new AgentRuntime({
    character,
    plugins: [sqlPlugin, llmResult.plugin],
  });

  await runtime.initialize();

  cachedRuntime = runtime;
  cachedProviderName = llmResult.providerName;

  return { runtime, providerName: llmResult.providerName };
}

// ============================================================================
// Chat Action
// ============================================================================

/**
 * Process a chat message through the elizaOS agent.
 *
 * Flow:
 *   1. Initialise (or reuse) the AgentRuntime
 *   2. Ensure a connection for this user + conversation room
 *   3. Persist the user message to Convex
 *   4. Call runtime.messageService.handleMessage with a callback
 *   5. Persist the agent response to Convex
 *   6. Return the response text
 */
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

    const userId = (args.userId ?? uuidv4()) as UUID;
    const roomId = stringToUuid(`convex-room-${args.conversationId}`);
    const worldId = stringToUuid("convex-world");

    // Ensure the agent knows about this user / room
    await runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      userName: "User",
      source: "convex",
      channelId: args.conversationId,
      type: ChannelType.DM,
    });

    // Persist the incoming user message
    await ctx.runMutation(internal.messages.store, {
      conversationId: args.conversationId,
      role: "user" as const,
      text: args.message,
      entityId: userId,
    });

    // Build an elizaOS Memory object for the incoming message
    const memory = createMessageMemory({
      id: uuidv4() as UUID,
      entityId: userId,
      roomId,
      content: {
        text: args.message,
        source: "convex",
        channelType: ChannelType.DM,
      },
    });

    // ---- core integration: messageService.handleMessage ----
    let responseText = "";

    await runtime.messageService?.handleMessage(
      runtime,
      memory,
      async (content) => {
        if (content?.text) {
          responseText += content.text;
        }
        return [];
      },
    );

    if (!responseText) {
      responseText = "I'm sorry, I wasn't able to generate a response.";
    }

    // Persist the agent response
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
