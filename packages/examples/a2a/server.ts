/**
 * elizaOS A2A (Agent-to-Agent) Server - TypeScript
 *
 * An HTTP server that exposes an elizaOS agent for agent-to-agent communication.
 * Uses the real elizaOS runtime backed by a real LLM provider.
 *
 * The inference provider is chosen by which API key env var is set, in priority
 * order: `OPENAI_API_KEY` → `OPENROUTER_API_KEY` → `ANTHROPIC_API_KEY` →
 * `ELIZA_API_KEY`. If none is set, the server refuses to start.
 */

import {
  AgentRuntime,
  ChannelType,
  type ContentValue,
  createCharacter,
  createMessageMemory,
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

// ============================================================================
// Provider selection
// ============================================================================

type ProviderName = "openai" | "openrouter" | "anthropic" | "elizacloud";

interface ProviderSelection {
  name: ProviderName;
  secrets: Record<string, string>;
  loadPlugin: () => Promise<Plugin>;
}

/**
 * Picks the inference provider from the first API key env var that is set, in
 * priority order. Throws when none is configured — there is no offline fallback.
 */
function selectProvider(): ProviderSelection {
  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  if (openaiKey) {
    return {
      name: "openai",
      secrets: { OPENAI_API_KEY: openaiKey },
      loadPlugin: () =>
        import("@elizaos/plugin-openai").then((mod) => mod.openaiPlugin),
    };
  }

  const openrouterKey = process.env.OPENROUTER_API_KEY?.trim();
  if (openrouterKey) {
    return {
      name: "openrouter",
      secrets: { OPENROUTER_API_KEY: openrouterKey },
      loadPlugin: () =>
        import("@elizaos/plugin-openrouter").then(
          (mod) => mod.openrouterPlugin,
        ),
    };
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (anthropicKey) {
    return {
      name: "anthropic",
      secrets: { ANTHROPIC_API_KEY: anthropicKey },
      loadPlugin: () =>
        import("@elizaos/plugin-anthropic").then((mod) => mod.anthropicPlugin),
    };
  }

  // The Eliza Cloud plugin reads `ELIZAOS_CLOUD_API_KEY` at init; map the
  // public `ELIZA_API_KEY` env var into that secret.
  const elizaKey = process.env.ELIZA_API_KEY?.trim();
  if (elizaKey) {
    return {
      name: "elizacloud",
      secrets: { ELIZAOS_CLOUD_API_KEY: elizaKey },
      loadPlugin: () =>
        import("@elizaos/plugin-elizacloud").then(
          (mod) => mod.elizaOSCloudPlugin,
        ),
    };
  }

  throw new Error(
    "No inference provider configured. Set one of OPENAI_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY, or ELIZA_API_KEY.",
  );
}

let providerSelection: ProviderSelection | null = null;
function getProvider(): ProviderSelection {
  providerSelection ??= selectProvider();
  return providerSelection;
}

const CHARACTER = createCharacter({
  name: "Eliza",
  bio: "A helpful AI assistant powered by elizaOS, available via A2A protocol.",
  system:
    "You are a helpful, friendly AI assistant participating in agent-to-agent communication. Be concise, informative, and cooperative.",
});

// ============================================================================
// Agent Runtime
// ============================================================================

let runtime: AgentRuntime | null = null;
const sessions: Map<string, { roomId: UUID; userId: UUID }> = new Map();
const worldId = stringToUuid("a2a-world");
const messageServerId = stringToUuid("a2a-server");

type JsonObject = Record<string, ContentValue>;

function serializeBio(): string | null {
  const bio = CHARACTER.bio;
  if (Array.isArray(bio)) return bio.join("\n");
  return typeof bio === "string" ? bio : null;
}

async function initializeRuntime(): Promise<AgentRuntime> {
  if (runtime) return runtime;

  const provider = getProvider();
  console.log(
    `🚀 Initializing elizaOS runtime (provider: ${provider.name})...`,
  );

  // Wire the selected provider's API key into the character secrets so the
  // provider plugin can read it via runtime settings.
  CHARACTER.secrets = { ...CHARACTER.secrets, ...provider.secrets };

  const plugins: Plugin[] = await Promise.all([
    import("@elizaos/plugin-sql").then((mod) => mod.default),
    provider.loadPlugin(),
  ]);

  runtime = new AgentRuntime({
    character: CHARACTER,
    enableDocuments: true,
    enableRelationships: true,
    enableTrajectories: true,
    plugins,
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
  opts?: { callerAgentId?: string; context?: JsonObject },
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
    messageServerId,
    type: ChannelType.DM,
    metadata: opts?.callerAgentId ? { callerAgentId: opts.callerAgentId } : {},
  });

  // Create message memory
  const content: {
    text: string;
    source: string;
    channelType: ChannelType;
  } & JsonObject = {
    text: message,
    source: "a2a",
    channelType: ChannelType.DM,
  };

  if (opts?.callerAgentId) {
    content.callerAgentId = opts.callerAgentId;
  }
  if (opts?.context) {
    content.context = opts.context;
  }

  const messageMemory = createMessageMemory({
    id: stringToUuid(uuidv4()),
    entityId: userId,
    roomId,
    content,
  });

  // Process message and collect response
  let response = "";

  const messageService = rt.messageService;
  if (!messageService) {
    throw new Error("Message service not initialized");
  }

  await messageService.handleMessage(
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

export function createApp(): express.Express {
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
      bio: serializeBio(),
      agentId: rt.agentId,
      version: "1.0.0",
      capabilities: ["chat", "reasoning", "multi-turn"],
      powered_by: "elizaOS",
      mode: getProvider().name,
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
    context?: JsonObject;
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

      const sessionId = clientSessionId ?? req.get("x-session-id") ?? uuidv4();
      const callerAgentId = req.get("x-agent-id") ?? undefined;

      const response = await handleChat(message, sessionId, {
        callerAgentId,
        context,
      });
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

      const sessionId = clientSessionId ?? req.get("x-session-id") ?? uuidv4();
      const callerAgentId = req.get("x-agent-id") ?? undefined;

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
        messageServerId,
        type: ChannelType.DM,
        metadata: callerAgentId ? { callerAgentId } : {},
      });

      const content: {
        text: string;
        source: string;
        channelType: ChannelType;
      } & JsonObject = {
        text: message,
        source: "a2a",
        channelType: ChannelType.DM,
      };
      if (callerAgentId) {
        content.callerAgentId = callerAgentId;
      }
      if (context) {
        content.context = context;
      }

      const messageMemory = createMessageMemory({
        id: stringToUuid(uuidv4()),
        entityId: userId,
        roomId,
        content,
      });

      // Stream response
      const messageService = rt.messageService;
      if (!messageService) {
        res.write(
          `data: ${JSON.stringify({ error: "Message service not initialized" })}\n\n`,
        );
        res.end();
        return;
      }

      await messageService.handleMessage(
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

  return app;
}

// ============================================================================
// Server Startup
// ============================================================================

export async function startServer(opts?: {
  port?: number;
}): Promise<{ port: number; close: () => Promise<void> }> {
  const app = createApp();
  const listenPort = opts?.port ?? PORT;

  // Pre-initialize the runtime so the server is ready immediately.
  await initializeRuntime();

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    resolve(app.listen(listenPort));
  });

  const address = server.address();
  const actualPort =
    typeof address === "object" && address && "port" in address
      ? Number(address.port)
      : listenPort;

  console.log(`\n🌐 elizaOS A2A Server (Express.js)`);
  console.log(`   http://localhost:${actualPort}\n`);
  console.log(`📚 Endpoints:`);
  console.log(`   GET  /            - Agent info`);
  console.log(`   GET  /health      - Health check`);
  console.log(`   POST /chat        - Chat with agent`);
  console.log(`   POST /chat/stream - Stream response (SSE)\n`);

  return {
    port: actualPort,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      if (runtime) {
        await runtime.stop();
        runtime = null;
      }
    },
  };
}

if (import.meta.main) {
  const { close } = await startServer();

  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\n👋 Shutting down...");
    await close();
    process.exit(0);
  });
}
