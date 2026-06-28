/**
 * elizaOS REST API Example - Hono
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
import { Hono } from "hono";
import { cors } from "hono/cors";
import { v4 as uuidv4 } from "uuid";

// ============================================================================
// Configuration
// ============================================================================

const PORT = Number(process.env.PORT ?? 3000);

// Character configuration
// Pass environment variables via character.secrets so getSetting() can find them
// Without POSTGRES_URL, plugin-sql will use PGLite automatically.
// The inference provider's API key is injected in getRuntime() once selected.
const character: Character = createCharacter({
  name: "Eliza",
  bio: "A helpful AI assistant powered by elizaOS.",
  secrets: {},
});

// ============================================================================
// Inference Provider Selection
// ============================================================================

type ProviderName = "openai" | "openrouter" | "anthropic" | "elizacloud";

interface ProviderSelection {
  name: ProviderName;
  /** Character secret key the provider plugin reads at init. */
  secretKey: string;
  secretValue: string;
  /** Lazily import the provider plugin so only the chosen one is loaded. */
  load: () => Promise<Plugin>;
}

/**
 * Pick the inference provider from the first API key present, in priority order.
 * Throws when no provider is configured — there is no offline fallback.
 */
function selectProvider(): ProviderSelection {
  if (process.env.OPENAI_API_KEY) {
    return {
      name: "openai",
      secretKey: "OPENAI_API_KEY",
      secretValue: process.env.OPENAI_API_KEY,
      load: async () => (await import("@elizaos/plugin-openai")).openaiPlugin,
    };
  }
  if (process.env.OPENROUTER_API_KEY) {
    return {
      name: "openrouter",
      secretKey: "OPENROUTER_API_KEY",
      secretValue: process.env.OPENROUTER_API_KEY,
      load: async () =>
        (await import("@elizaos/plugin-openrouter")).openrouterPlugin,
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      name: "anthropic",
      secretKey: "ANTHROPIC_API_KEY",
      secretValue: process.env.ANTHROPIC_API_KEY,
      load: async () =>
        (await import("@elizaos/plugin-anthropic")).anthropicPlugin,
    };
  }
  if (process.env.ELIZA_API_KEY) {
    return {
      name: "elizacloud",
      // The cloud plugin reads ELIZAOS_CLOUD_API_KEY at init.
      secretKey: "ELIZAOS_CLOUD_API_KEY",
      secretValue: process.env.ELIZA_API_KEY,
      load: async () =>
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
let selectedProvider: ProviderName | null = null;

// Session identifiers
const roomId = stringToUuid("chat-room");
const worldId = stringToUuid("chat-world");

async function getRuntime(): Promise<IAgentRuntime | null> {
  if (runtime) return runtime;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      console.log("🚀 Initializing elizaOS runtime...");

      const selection = selectProvider();
      selectedProvider = selection.name;
      character.secrets = {
        ...character.secrets,
        [selection.secretKey]: selection.secretValue,
      };
      console.log(`💡 Using ${selection.name} for inference`);

      const { default: sqlPlugin } = await import("@elizaos/plugin-sql");
      const providerPlugin = await selection.load();
      const plugins: Plugin[] = [sqlPlugin as Plugin, providerPlugin];

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
// Hono App
// ============================================================================

export const app = new Hono();

// CORS middleware
app.use("*", cors());

// ============================================================================
// Routes
// ============================================================================

/**
 * GET / - Info endpoint
 */
app.get("/", async (c) => {
  const _rt = await getRuntime();
  return c.json({
    name: character.name,
    bio: character.bio,
    version: "2.0.0",
    powered_by: "elizaOS",
    framework: "Hono",
    mode: selectedProvider ?? "uninitialized",
    endpoints: {
      "POST /chat": "Send a message and receive a response",
      "GET /health": "Health check endpoint",
      "GET /": "This info endpoint",
    },
  });
});

/**
 * GET /health - Health check
 */
app.get("/health", async (c) => {
  const rt = await getRuntime();
  return c.json({
    status: rt ? "healthy" : "degraded",
    mode: selectedProvider ?? "uninitialized",
    character: character.name,
    error: initError,
    timestamp: new Date().toISOString(),
  });
});

interface ChatRequest {
  message: string;
  userId?: string;
}

/**
 * POST /chat - Chat with the agent using runtime.messageService.handleMessage
 */
app.post("/chat", async (c) => {
  const body = await c.req.json<ChatRequest>();
  const { message, userId: clientUserId } = body;

  if (!message || typeof message !== "string") {
    return c.json({ error: "Message is required and must be a string" }, 400);
  }

  const rt = await getRuntime();

  if (!rt) {
    return c.json(
      {
        error: "Runtime not initialized",
        details: initError,
      },
      503,
    );
  }

  const userId = (clientUserId || uuidv4()) as UUID;

  // Ensure connection exists
  await rt.ensureConnection({
    entityId: userId,
    roomId,
    worldId,
    userName: "User",
    source: "hono",
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
      source: "hono_rest_api",
      channelType: ChannelType.DM,
    },
  });

  // Process message through the canonical elizaOS pipeline
  let responseText = "";

  await rt.messageService?.handleMessage(rt, messageMemory, async (content) => {
    if (content?.text) {
      responseText += content.text;
    }
    return [];
  });

  return c.json({
    response: responseText || "I processed your message but have no response.",
    character: character.name,
    userId,
    mode: selectedProvider ?? "uninitialized",
  });
});

// ============================================================================
// Server Startup
// ============================================================================

// Pre-initialize runtime
if (import.meta.main) {
  getRuntime().then((rt) => {
    if (rt) {
      console.log(`\n🌐 elizaOS REST API (Hono)`);
      console.log(`   http://localhost:${PORT}\n`);
      console.log(`📚 Endpoints:`);
      console.log(`   GET  /       - Agent info`);
      console.log(`   GET  /health - Health check`);
      console.log(
        `   POST /chat   - Chat with agent (uses runtime.messageService.handleMessage)\n`,
      );
    }
  });
}

export default {
  port: PORT,
  fetch: app.fetch,
};
