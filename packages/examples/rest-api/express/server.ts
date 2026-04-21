/**
 * elizaOS REST API Example - Express.js
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
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
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
// Express App
// ============================================================================

const app = express();
app.use(express.json());

// CORS middleware
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (_req.method === "OPTIONS") {
    res.sendStatus(200);
    return;
  }
  next();
});

// ============================================================================
// Routes
// ============================================================================

/**
 * GET / - Info endpoint
 */
app.get("/", async (_req: Request, res: Response) => {
  const rt = await getRuntime();
  res.json({
    name: character.name,
    bio: character.bio,
    version: "2.0.0",
    powered_by: "elizaOS",
    framework: "Express.js",
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
app.get("/health", async (_req: Request, res: Response) => {
  const rt = await getRuntime();
  res.json({
    status: rt ? "healthy" : "degraded",
    mode: rt ? "elizaos" : "classic",
    character: character.name,
    error: initError,
    timestamp: new Date().toISOString(),
  });
});

interface ChatRequestBody {
  message: string;
  userId?: string;
}

/**
 * POST /chat - Chat with the agent using runtime.messageService.handleMessage
 */
app.post(
  "/chat",
  async (req: Request<object, object, ChatRequestBody>, res: Response) => {
    const { message, userId: clientUserId } = req.body;

    if (!message || typeof message !== "string") {
      res
        .status(400)
        .json({ error: "Message is required and must be a string" });
      return;
    }

    const rt = await getRuntime();

    if (!rt) {
      res.status(503).json({
        error: "Runtime not initialized",
        details: initError,
      });
      return;
    }

    const userId = (clientUserId || uuidv4()) as UUID;

    // Ensure connection exists
    await rt.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      userName: "User",
      source: "express",
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
        source: "express_rest_api",
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

    res.json({
      response: responseText || "I processed your message but have no response.",
      character: character.name,
      userId,
      mode: "elizaos",
    });
  },
);

// ============================================================================
// Server Startup
// ============================================================================

// Pre-initialize runtime then start server
getRuntime().then((rt) => {
  app.listen(PORT, () => {
    console.log(`\n🌐 elizaOS REST API (Express.js)`);
    console.log(`   http://localhost:${PORT}\n`);
    console.log(`📚 Endpoints:`);
    console.log(`   GET  /       - Agent info`);
    console.log(`   GET  /health - Health check`);
    console.log(`   POST /chat   - Chat with agent (uses runtime.messageService.handleMessage)\n`);
    if (!rt) {
      console.log(`⚠️  Runtime initialization issue: ${initError}\n`);
    }
  });
});
