/**
 * elizaOS A2A (Agent-to-Agent) Server - TypeScript
 *
 * An HTTP server that exposes an elizaOS agent for agent-to-agent communication.
 * Uses real elizaOS runtime with OpenAI and SQL plugins.
 */

import {
  AgentRuntime,
  ChannelType,
  type Character,
  createMessageMemory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { openaiPlugin } from "@elizaos/plugin-openai";
import sqlPlugin from "@elizaos/plugin-sql";
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

const CHARACTER: Character = {
  name: "Eliza",
  bio: "A helpful AI assistant powered by elizaOS, available via A2A protocol.",
  system:
    "You are a helpful, friendly AI assistant participating in agent-to-agent communication. Be concise, informative, and cooperative.",
};

// ============================================================================
// Agent Runtime
// ============================================================================

let runtime: AgentRuntime | null = null;
const sessions: Map<string, { roomId: UUID; userId: UUID }> = new Map();
const worldId = stringToUuid("a2a-world");

async function initializeRuntime(): Promise<AgentRuntime> {
  if (runtime) return runtime;

  console.log("🚀 Initializing elizaOS runtime...");

  runtime = new AgentRuntime({
    character: CHARACTER,
    plugins: [sqlPlugin, openaiPlugin],
  });

  await runtime.initialize();

  console.log("✅ elizaOS runtime initialized");
  return runtime;
}

function getOrCreateSession(sessionId: string): { roomId: UUID; userId: UUID } {
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      roomId: stringToUuid(`room-${sessionId}`),
      userId: stringToUuid(`user-${sessionId}`),
    };
    sessions.set(sessionId, session);
  }
  return session;
}

async function handleChat(
  message: string,
  sessionId: string,
): Promise<string> {
  const rt = await initializeRuntime();
  const { roomId, userId } = getOrCreateSession(sessionId);

  // Ensure connection
  await rt.ensureConnection({
    entityId: userId,
    roomId,
    worldId,
    userName: `Agent-${sessionId}`,
    source: "a2a",
    channelId: "a2a",
    serverId: "a2a-server",
    type: ChannelType.DM,
  } as Parameters<typeof rt.ensureConnection>[0]);

  // Create message memory
  const messageMemory = createMessageMemory({
    id: uuidv4() as UUID,
    entityId: userId,
    roomId,
    content: {
      text: message,
      source: "client_chat",
      channelType: ChannelType.DM,
    },
  });

  // Process message and collect response
  let response = "";

  await rt.messageService!.handleMessage(
    rt,
    messageMemory,
    async (responseContent) => {
      if (responseContent?.text) {
        response += responseContent.text;
      }
      return [];
    },
  );

  return response || "No response generated.";
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
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Agent-Id, X-Session-Id",
  );
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
 * GET / - Agent info endpoint
 */
app.get("/", async (_req: Request, res: Response) => {
  const rt = await initializeRuntime();
  res.json({
    name: CHARACTER.name,
    bio: CHARACTER.bio,
    agentId: rt.agentId,
    version: "1.0.0",
    capabilities: ["chat", "reasoning", "multi-turn"],
    powered_by: "elizaOS",
    endpoints: {
      "POST /chat": "Send a message and receive a response",
      "POST /chat/stream": "Stream a response (SSE)",
      "GET /health": "Health check endpoint",
      "GET /": "This info endpoint",
    },
  });
});

/**
 * GET /health - Health check
 */
app.get("/health", async (_req: Request, res: Response) => {
  try {
    await initializeRuntime();
    res.json({
      status: "healthy",
      agent: CHARACTER.name,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      status: "unhealthy",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

interface ChatRequestBody {
  message: string;
  sessionId?: string;
  context?: Record<string, unknown>;
}

/**
 * POST /chat - Chat with the agent
 */
app.post(
  "/chat",
  async (req: Request<object, object, ChatRequestBody>, res: Response) => {
    const { message, sessionId: clientSessionId, context } = req.body;

    if (!message || typeof message !== "string") {
      res
        .status(400)
        .json({ error: "Message is required and must be a string" });
      return;
    }

  const sessionId =
    clientSessionId ?? (req.headers["x-session-id"] as string) ?? uuidv4();

  const response = await handleChat(message, sessionId);
    const rt = await initializeRuntime();

    res.json({
      response,
      agentId: rt.agentId,
      sessionId,
      timestamp: new Date().toISOString(),
    });
  },
);

/**
 * POST /chat/stream - Stream response from the agent (SSE)
 */
app.post(
  "/chat/stream",
  async (req: Request<object, object, ChatRequestBody>, res: Response) => {
    const { message, sessionId: clientSessionId, context } = req.body;

    if (!message || typeof message !== "string") {
      res
        .status(400)
        .json({ error: "Message is required and must be a string" });
      return;
    }

    const sessionId = clientSessionId ?? uuidv4();

    // Set up SSE
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const rt = await initializeRuntime();
    const { roomId, userId } = getOrCreateSession(sessionId);

    // Ensure connection
    await rt.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      userName: `Agent-${sessionId}`,
      source: "a2a",
      channelId: "a2a",
      serverId: "a2a-server",
      type: ChannelType.DM,
    } as Parameters<typeof rt.ensureConnection>[0]);

    const messageMemory = createMessageMemory({
      id: uuidv4() as UUID,
      entityId: userId,
      roomId,
      content: { text: message, ...context },
    });

  // Stream response
  await rt.messageService!.handleMessage(
      rt,
      messageMemory,
      async (responseContent) => {
        if (responseContent?.text) {
          res.write(
            `data: ${JSON.stringify({ text: responseContent.text })}\n\n`,
          );
        }
        return [];
      },
    );

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  },
);

// ============================================================================
// Server Startup
// ============================================================================

const server = app.listen(PORT, async () => {
  // Pre-initialize the runtime
  await initializeRuntime();

  console.log(`\n🌐 elizaOS A2A Server (Express.js)`);
  console.log(`   http://localhost:${PORT}\n`);
  console.log(`📚 Endpoints:`);
  console.log(`   GET  /            - Agent info`);
  console.log(`   GET  /health      - Health check`);
  console.log(`   POST /chat        - Chat with agent`);
  console.log(`   POST /chat/stream - Stream response (SSE)\n`);
});

// Handle graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n👋 Shutting down...");
  if (runtime) {
    await runtime.stop();
  }
  server.close();
  process.exit(0);
});
