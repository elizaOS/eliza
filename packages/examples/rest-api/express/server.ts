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
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { v4 as uuidv4 } from "uuid";

// ============================================================================
// Configuration
// ============================================================================

const PORT = Number(process.env.PORT ?? 3000);

// Character configuration
// Pass environment variables via character.secrets so getSetting() can find them.
// Map ELIZA_API_KEY into the ELIZAOS_CLOUD_API_KEY secret the cloud plugin reads.
// Without POSTGRES_URL, plugin-sql will use PGLite automatically.
const character: Character = createCharacter({
  name: "Eliza",
  bio: "A helpful AI assistant powered by elizaOS.",
  secrets: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "",
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
    ELIZAOS_CLOUD_API_KEY: process.env.ELIZA_API_KEY || "",
  },
});

// ============================================================================
// Runtime State
// ============================================================================

type ProviderName = "openai" | "openrouter" | "anthropic" | "elizacloud";

let runtime: IAgentRuntime | null = null;
let initPromise: Promise<IAgentRuntime | null> | null = null;
let initError: string | null = null;
let selectedProvider: ProviderName | null = null;

// Session identifiers
const roomId = stringToUuid("chat-room");
const worldId = stringToUuid("chat-world");

/**
 * Pick an inference provider from the first API key env var that is set,
 * in priority order. Each entry lazily imports its plugin so only the
 * chosen provider is loaded. Throws when no key is configured.
 */
function selectProvider(): {
  name: ProviderName;
  load: () => Promise<Plugin>;
} {
  if (process.env.OPENAI_API_KEY) {
    return {
      name: "openai",
      load: async () => (await import("@elizaos/plugin-openai")).openaiPlugin,
    };
  }
  if (process.env.OPENROUTER_API_KEY) {
    return {
      name: "openrouter",
      load: async () =>
        (await import("@elizaos/plugin-openrouter")).openrouterPlugin,
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      name: "anthropic",
      load: async () =>
        (await import("@elizaos/plugin-anthropic")).anthropicPlugin,
    };
  }
  if (process.env.ELIZA_API_KEY) {
    return {
      name: "elizacloud",
      load: async () =>
        (await import("@elizaos/plugin-elizacloud")).elizaOSCloudPlugin,
    };
  }
  throw new Error(
    "No inference provider configured. Set one of OPENAI_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY, or ELIZA_API_KEY.",
  );
}

async function getRuntime(): Promise<IAgentRuntime | null> {
  if (runtime) return runtime;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      console.log("🚀 Initializing elizaOS runtime...");

      const { default: sqlPlugin } = await import("@elizaos/plugin-sql");

      const provider = selectProvider();
      selectedProvider = provider.name;
      console.log(`💡 Using "${provider.name}" inference provider`);

      const plugins: Plugin[] = [sqlPlugin as Plugin, await provider.load()];

      const newRuntime = new AgentRuntime({
        character,
        plugins,
      });

      await newRuntime.initialize();

      console.log("✅ elizaOS runtime initialized");
      runtime = newRuntime;
      return newRuntime;
    } catch (error) {
      initError = error instanceof Error ? error.message : "Unknown error";
      console.error("❌ Failed to initialize elizaOS runtime:", initError);
      return null;
    }
  })();

  return initPromise;
}

// ============================================================================
// Express App
// ============================================================================

export const app = express();
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
    mode: rt ? selectedProvider : "unavailable",
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
    mode: rt ? selectedProvider : "unavailable",
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
      response:
        responseText || "I processed your message but have no response.",
      character: character.name,
      userId,
      mode: selectedProvider,
    });
  },
);

// ============================================================================
// Server Startup
// ============================================================================

// Pre-initialize runtime then start server
if (import.meta.main) {
  getRuntime().then((rt) => {
    app.listen(PORT, () => {
      console.log(`\n🌐 elizaOS REST API (Express.js)`);
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
  });
}
