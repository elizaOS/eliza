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
import { openaiPlugin } from "@elizaos/plugin-openai";
import sqlPlugin from "@elizaos/plugin-sql";
import { elizaClassicPlugin } from "@elizaos/plugin-eliza-classic";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { v4 as uuidv4 } from "uuid";

// Type assertion for plugin
const typedSqlPlugin = sqlPlugin as Plugin;

// ============================================================================
// Configuration
// ============================================================================

const PORT = Number(process.env.PORT ?? 3000);

// Character configuration
// Pass environment variables via character.secrets so getSetting() can find them
// Without POSTGRES_URL, plugin-sql will use PGLite automatically
const character: Character = createCharacter({
  name: "Eliza",
  bio: "A helpful AI assistant powered by elizaOS.",
  secrets: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
  },
});

// ============================================================================
// Runtime State
// ============================================================================

let runtime: IAgentRuntime | null = null;
let initPromise: Promise<IAgentRuntime | null> | null = null;
let initError: string | null = null;
let useClassicFallback = false;

// Session identifiers
const roomId = stringToUuid("chat-room");
const worldId = stringToUuid("chat-world");

async function getRuntime(): Promise<IAgentRuntime | null> {
  if (runtime) return runtime;
  if (useClassicFallback) return null;

  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      console.log("🚀 Initializing elizaOS runtime...");

      // Choose plugins based on whether OpenAI key is available
      const plugins: Plugin[] = [typedSqlPlugin];
      if (process.env.OPENAI_API_KEY) {
        plugins.push(openaiPlugin);
      } else {
        console.log("💡 No OPENAI_API_KEY found, using elizaClassicPlugin for responses");
        plugins.push(elizaClassicPlugin);
      }

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

      // Check if it's a recoverable error
      if (message.includes("Extension bundle not found") || message.includes("migrations")) {
        console.log("⚠️ Database initialization issue.");
        console.log("💡 Falling back to classic ELIZA mode.");
        useClassicFallback = true;
        initError = "Database not compatible. Using classic mode.";
      } else {
        initError = message;
        useClassicFallback = true;
      }
      return null;
    }
  })();

  return initPromise;
}

// ============================================================================
// Hono App
// ============================================================================

const app = new Hono();

// CORS middleware
app.use("*", cors());

// ============================================================================
// Routes
// ============================================================================

/**
 * GET / - Info endpoint
 */
app.get("/", async (c) => {
  const rt = await getRuntime();
  return c.json({
    name: character.name,
    bio: character.bio,
    version: "2.0.0",
    powered_by: "elizaOS",
    framework: "Hono",
    mode: rt ? "elizaos" : "classic",
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
    mode: rt ? "elizaos" : "classic",
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
    return c.json({
      error: "Runtime not initialized",
      details: initError,
    }, 503);
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

  return c.json({
    response: responseText || "I processed your message but have no response.",
    character: character.name,
    userId,
    mode: "elizaos",
  });
});

// ============================================================================
// Server Startup
// ============================================================================

// Pre-initialize runtime
getRuntime().then((rt) => {
  if (rt) {
    console.log(`\n🌐 elizaOS REST API (Hono)`);
    console.log(`   http://localhost:${PORT}\n`);
    console.log(`📚 Endpoints:`);
    console.log(`   GET  /       - Agent info`);
    console.log(`   GET  /health - Health check`);
    console.log(`   POST /chat   - Chat with agent (uses runtime.messageService.handleMessage)\n`);
  }
});

export default {
  port: PORT,
  fetch: app.fetch,
};
