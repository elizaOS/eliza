/**
 * elizaOS REST API Example - Elysia
 *
 * A REST API server demonstrating the canonical elizaOS implementation.
 * Uses AgentRuntime with runtime.messageService.handleMessage for proper
 * message processing through the full elizaOS pipeline.
 */

import {
  AgentRuntime,
  ChannelType,
  type Character,
  createCharacter,
  createMessageMemory,
  type IAgentRuntime,
  type Plugin,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { v4 as uuidv4 } from "uuid";

// ============================================================================
// Configuration
// ============================================================================

const PORT = Number(process.env.PORT ?? 3000);

// Character configuration
// Secrets are injected lazily once an inference provider is selected so that
// getSetting() can find the provider's API key. Without POSTGRES_URL,
// plugin-sql will use PGLite automatically.
const character: Character = createCharacter({
  name: "Eliza",
  bio: "A helpful AI assistant powered by elizaOS.",
});

// ============================================================================
// Inference provider selection
// ============================================================================

type ProviderName = "openai" | "openrouter" | "anthropic" | "elizacloud";

interface ProviderSelection {
  name: ProviderName;
  // Character secret the chosen plugin reads via getSetting() at init.
  secretKey: string;
  secretValue: string;
  loadPlugin: () => Promise<Plugin>;
}

// Pick a provider by which API key is present, in priority order. There is no
// offline fallback: if nothing is configured we throw a clear error.
function selectProvider(): ProviderSelection {
  if (process.env.OPENAI_API_KEY) {
    return {
      name: "openai",
      secretKey: "OPENAI_API_KEY",
      secretValue: process.env.OPENAI_API_KEY,
      loadPlugin: async () =>
        (await import("@elizaos/plugin-openai")).openaiPlugin,
    };
  }
  if (process.env.OPENROUTER_API_KEY) {
    return {
      name: "openrouter",
      secretKey: "OPENROUTER_API_KEY",
      secretValue: process.env.OPENROUTER_API_KEY,
      loadPlugin: async () =>
        (await import("@elizaos/plugin-openrouter")).openrouterPlugin,
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      name: "anthropic",
      secretKey: "ANTHROPIC_API_KEY",
      secretValue: process.env.ANTHROPIC_API_KEY,
      loadPlugin: async () =>
        (await import("@elizaos/plugin-anthropic")).anthropicPlugin,
    };
  }
  if (process.env.ELIZA_API_KEY) {
    return {
      name: "elizacloud",
      // The Eliza Cloud plugin reads ELIZAOS_CLOUD_API_KEY at init.
      secretKey: "ELIZAOS_CLOUD_API_KEY",
      secretValue: process.env.ELIZA_API_KEY,
      loadPlugin: async () =>
        (await import("@elizaos/plugin-elizacloud")).elizaOSCloudPlugin,
    };
  }
  throw new Error(
    "No inference provider configured. Set one of OPENAI_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY, or ELIZA_API_KEY.",
  );
}

// ============================================================================
// Runtime State
// ============================================================================

let runtime: IAgentRuntime | null = null;
let initPromise: Promise<IAgentRuntime | null> | null = null;
let initError: string | null = null;
let providerName: ProviderName | null = null;

// Session identifiers
const roomId = stringToUuid("chat-room");
const worldId = stringToUuid("chat-world");

async function getRuntime(): Promise<IAgentRuntime | null> {
  if (runtime) return runtime;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      console.log("🚀 Initializing elizaOS runtime...");

      const { default: sqlPlugin } = await import("@elizaos/plugin-sql");

      const provider = selectProvider();
      providerName = provider.name;
      character.secrets = { [provider.secretKey]: provider.secretValue };

      console.log(`🔌 Using ${provider.name} inference provider`);
      const plugins: Plugin[] = [
        sqlPlugin as Plugin,
        await provider.loadPlugin(),
      ];

      const newRuntime = new AgentRuntime({
        character,
        plugins,
      });

      await newRuntime.initialize();

      console.log("✅ elizaOS runtime initialized");
      runtime = newRuntime;
      return newRuntime;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("❌ Failed to initialize elizaOS runtime:", message);
      initError = message;
      return null;
    }
  })();

  return initPromise;
}

// ============================================================================
// Types
// ============================================================================

interface ChatRequest {
  message: string;
  userId?: string;
}

// ============================================================================
// Elysia App
// ============================================================================

export const app = new Elysia()
  .use(cors())

  // GET / - Info endpoint
  .get("/", async () => {
    const rt = await getRuntime();
    return {
      name: character.name,
      bio: character.bio,
      version: "2.0.0",
      powered_by: "elizaOS",
      framework: "Elysia",
      mode: rt ? providerName : "unconfigured",
      endpoints: {
        "POST /chat": "Send a message and receive a response",
        "GET /health": "Health check endpoint",
        "GET /": "This info endpoint",
      },
    };
  })

  // GET /health - Health check
  .get("/health", async () => {
    const rt = await getRuntime();
    return {
      status: rt ? "healthy" : "degraded",
      mode: rt ? providerName : "unconfigured",
      character: character.name,
      error: initError,
      timestamp: new Date().toISOString(),
    };
  })

  // POST /chat - Chat with the agent using runtime.messageService.handleMessage
  .post("/chat", async ({ body, set }) => {
    const { message, userId: clientUserId } = body as ChatRequest;

    if (!message || typeof message !== "string") {
      set.status = 400;
      return { error: "Message is required and must be a string" };
    }

    const rt = await getRuntime();

    if (!rt) {
      set.status = 503;
      return {
        error: "Runtime not initialized",
        details: initError,
      };
    }

    const userId = (clientUserId || uuidv4()) as UUID;

    // Ensure connection exists
    await rt.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      userName: "User",
      source: "elysia",
      channelId: "chat",
      serverId: "server",
      type: ChannelType.DM,
    } as Parameters<typeof rt.ensureConnection>[0]);

    // Create message memory
    const messageMemory = createMessageMemory({
      id: uuidv4() as UUID,
      entityId: userId,
      roomId,
      content: {
        text: message,
        source: "elysia_rest_api",
        channelType: ChannelType.DM,
      },
    });

    // Process message through the canonical elizaOS pipeline
    let responseText = "";

    await rt.messageService?.handleMessage(
      rt,
      messageMemory,
      async (content) => {
        if (content?.text) {
          responseText += content.text;
        }
        return [];
      },
    );

    return {
      response:
        responseText || "I processed your message but have no response.",
      character: character.name,
      userId,
      mode: providerName,
    };
  });

// ============================================================================
// Server Startup
// ============================================================================

// Pre-initialize runtime
if (import.meta.main) {
  app.listen(PORT);
  getRuntime().then((rt) => {
    console.log(`\n🌐 elizaOS REST API (Elysia)`);
    console.log(`   http://localhost:${PORT}\n`);
    console.log(`📚 Endpoints:`);
    console.log(`   GET  /       - Agent info`);
    console.log(`   GET  /health - Health check`);
    console.log(
      `   POST /chat   - Chat with agent (uses runtime.messageService.handleMessage)\n`,
    );
    if (!rt) {
      console.log(`⚠️  Runtime initialization issue: ${initError}\n`);
    }
  });
}
