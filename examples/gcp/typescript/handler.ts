/**
 * GCP Cloud Run handler for elizaOS chat worker
 *
 * This Cloud Run service processes chat messages and returns AI responses
 * using the elizaOS runtime with OpenAI as the LLM provider.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  AgentRuntime,
  ChannelType,
  type Character,
  createCharacter,
  createMessageMemory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { openaiPlugin } from "@elizaos/plugin-openai";
import sqlPlugin from "@elizaos/plugin-sql";
import { v4 as uuidv4 } from "uuid";

// Types for request/response
interface ChatRequest {
  message: string;
  userId?: string;
  conversationId?: string;
}

interface ChatResponse {
  response: string;
  conversationId: string;
  timestamp: string;
}

interface HealthResponse {
  status: "healthy" | "unhealthy";
  runtime: string;
  version: string;
}

interface InfoResponse {
  name: string;
  bio: string;
  version: string;
  powered_by: string;
  endpoints: Record<string, string>;
}

// Character configuration from environment
function getCharacter(): Character {
  return createCharacter({
    name: process.env.CHARACTER_NAME ?? "Eliza",
    bio: process.env.CHARACTER_BIO ?? "A helpful AI assistant.",
    system:
      process.env.CHARACTER_SYSTEM ??
      "You are a helpful, concise AI assistant. Respond thoughtfully to user messages.",
  });
}

// Singleton runtime instance
let runtime: AgentRuntime | null = null;
let initializationPromise: Promise<void> | null = null;

/**
 * Initialize the elizaOS runtime (lazy, singleton pattern)
 */
async function initializeRuntime(): Promise<AgentRuntime> {
  if (runtime) {
    return runtime;
  }

  if (initializationPromise) {
    await initializationPromise;
    if (!runtime) {
      throw new Error("elizaOS runtime initialization failed");
    }
    return runtime;
  }

  initializationPromise = (async () => {
    console.log("Initializing elizaOS runtime...");

    const character = getCharacter();
    runtime = new AgentRuntime({
      character,
      plugins: [sqlPlugin, openaiPlugin],
    });

    await runtime.initialize();
    console.log("elizaOS runtime initialized successfully");
  })();

  await initializationPromise;
  if (!runtime) {
    throw new Error("elizaOS runtime initialization failed");
  }
  return runtime;
}

/**
 * Parse JSON request body
 */
async function parseBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body) as T);
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Parse and validate chat request
 */
function validateChatRequest(body: Record<string, unknown>): ChatRequest {
  if (typeof body.message !== "string" || !body.message.trim()) {
    throw new Error("Message is required and must be a non-empty string");
  }

  return {
    message: body.message.trim(),
    userId: typeof body.userId === "string" ? body.userId : undefined,
    conversationId:
      typeof body.conversationId === "string" ? body.conversationId : undefined,
  };
}

/**
 * Send JSON response
 */
function sendJson(res: ServerResponse, statusCode: number, body: object): void {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(body));
}

/**
 * Handle chat message using full elizaOS runtime
 */
async function handleChat(request: ChatRequest): Promise<ChatResponse> {
  const rt = await initializeRuntime();

  // Generate IDs (using same pattern as AWS Lambda)
  const userId = uuidv4() as UUID;
  const conversationId =
    request.conversationId ??
    `conv-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const roomId = stringToUuid(conversationId);
  const worldId = stringToUuid("cloud-run-world");

  // Ensure connection exists
  await rt.ensureConnection({
    entityId: userId,
    roomId,
    worldId,
    userName: "User",
    source: "gcp-cloud-run",
    channelId: conversationId,
    serverId: "cloud-run-worker",
    type: ChannelType.DM,
  } as Parameters<typeof rt.ensureConnection>[0]);

  // Create message memory
  const message = createMessageMemory({
    id: uuidv4() as UUID,
    entityId: userId,
    roomId,
    content: {
      text: request.message,
      source: "client_chat",
      channelType: ChannelType.DM,
    },
  });

  // Process message and collect response
  let responseText = "";

  await rt.messageService?.handleMessage(rt, message, async (content) => {
    if (content?.text) {
      responseText += content.text;
    }
    return [];
  });

  return {
    response:
      responseText || "I apologize, but I could not generate a response.",
    conversationId,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Handle health check
 */
function handleHealth(): HealthResponse {
  return {
    status: "healthy",
    runtime: "elizaos-typescript",
    version: "1.0.0",
  };
}

/**
 * Handle info endpoint
 */
function handleInfo(): InfoResponse {
  const character = getCharacter();
  const bio = character.bio;
  const bioStr = Array.isArray(bio)
    ? bio.join(" ")
    : (bio ?? "A helpful AI assistant.");
  return {
    name: character.name ?? "elizaos",
    bio: bioStr,
    version: "1.0.0",
    powered_by: "elizaOS",
    endpoints: {
      "POST /chat": "Send a message and receive a response",
      "GET /health": "Health check endpoint",
      "GET /": "This info endpoint",
    },
  };
}

/**
 * Request router
 */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  const path = url.pathname;
  const method = req.method ?? "GET";

  console.log(`${method} ${path}`);

  // Handle CORS preflight
  if (method === "OPTIONS") {
    sendJson(res, 200, { message: "OK" });
    return;
  }

  // Info endpoint
  if (path === "/" && method === "GET") {
    sendJson(res, 200, handleInfo());
    return;
  }

  // Health check
  if (path === "/health" && method === "GET") {
    sendJson(res, 200, handleHealth());
    return;
  }

  // Chat endpoint
  if (path === "/chat" && method === "POST") {
    const body = await parseBody<Record<string, unknown>>(req);
    const request = validateChatRequest(body);
    const response = await handleChat(request);
    sendJson(res, 200, response);
    return;
  }

  // Not found
  sendJson(res, 404, { error: "Not found", code: "NOT_FOUND" });
}

// Start server
const PORT = parseInt(process.env.PORT ?? "8080", 10);

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("Unhandled error:", err);
    if (!res.headersSent) {
      sendJson(res, 500, {
        error: "Internal server error",
        code: "INTERNAL_ERROR",
      });
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 elizaOS Cloud Run worker started on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`💬 Chat endpoint: http://localhost:${PORT}/chat`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

export { handleRequest, handleChat, handleHealth, handleInfo };
