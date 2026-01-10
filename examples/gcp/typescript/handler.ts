/**
 * GCP Cloud Run handler for elizaOS chat worker
 *
 * This Cloud Run service processes chat messages and returns AI responses
 * using the elizaOS runtime with OpenAI as the LLM provider.
 */

import {
  AgentRuntime,
  ChannelType,
  createMessageMemory,
  stringToUuid,
  bootstrapPlugin,
  type Character,
  type UUID,
  type Content,
} from "@elizaos/core";
import { openaiPlugin } from "@elizaos/plugin-openai";
import { createServer, type IncomingMessage, type ServerResponse } from "http";

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

interface ErrorResponse {
  error: string;
  code: string;
}

interface StreamMetadata {
  conversationId: string;
  character: string;
}

// In-memory conversation store for streaming context
interface ConversationState {
  messages: Array<{ role: string; content: string }>;
  createdAt: number;
}

const conversations = new Map<string, ConversationState>();

// Character configuration from environment
function getCharacter(): Character {
  return {
    name: process.env.CHARACTER_NAME ?? "Eliza",
    bio: process.env.CHARACTER_BIO ?? "A helpful AI assistant.",
    system:
      process.env.CHARACTER_SYSTEM ??
      "You are a helpful, concise AI assistant. Respond thoughtfully to user messages.",
  };
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
    return runtime!;
  }

  initializationPromise = (async () => {
    console.log("Initializing elizaOS runtime...");

    const character = getCharacter();
    runtime = new AgentRuntime({
      character,
      plugins: [bootstrapPlugin, openaiPlugin],
    });

    await runtime.initialize();
    console.log("elizaOS runtime initialized successfully");
  })();

  await initializationPromise;
  return runtime!;
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
function sendJson<T extends Record<string, unknown>>(
  res: ServerResponse,
  statusCode: number,
  body: T
): void {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(body));
}

/**
 * Handle chat message (non-streaming)
 */
async function handleChat(request: ChatRequest): Promise<ChatResponse> {
  const rt = await initializeRuntime();
  const character = getCharacter();

  // Generate deterministic IDs for stateless operation
  const userId = stringToUuid(request.userId ?? `user-${Date.now()}`);
  const conversationId =
    request.conversationId ??
    `conv-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const roomId = stringToUuid(conversationId);

  // Ensure connection exists
  await rt.ensureConnection({
    entityId: userId,
    roomId,
    userName: "User",
    source: "gcp-cloud-run",
    channelId: conversationId,
    serverId: "cloud-run-worker",
    type: ChannelType.DM,
  });

  // Create message memory
  const message = createMessageMemory({
    id: stringToUuid(`msg-${Date.now()}`) as UUID,
    entityId: userId,
    roomId,
    content: { text: request.message } as Content,
  });

  // Process message and collect response
  let responseText = "";

  await rt.messageService!.handleMessage(rt, message, async (content) => {
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
 * Handle streaming chat (SSE)
 */
async function handleStreamChat(
  request: ChatRequest,
  res: ServerResponse
): Promise<void> {
  const character = getCharacter();

  // Set up SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const conversationId =
    request.conversationId ??
    `conv-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  // Get or create conversation state
  let state = conversations.get(conversationId);
  if (!state) {
    state = {
      messages: [{ role: "system", content: character.system ?? "" }],
      createdAt: Date.now(),
    };
    conversations.set(conversationId, state);
  }

  // Add user message
  state.messages.push({ role: "user", content: request.message });

  // Send metadata
  const metadata: StreamMetadata = {
    conversationId,
    character: character.name,
  };
  res.write(`data: ${JSON.stringify(metadata)}\n\n`);

  // Call OpenAI directly for streaming
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    res.write(`data: ${JSON.stringify({ error: "OPENAI_API_KEY not set" })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: state.messages,
        temperature: 0.7,
        max_tokens: 1024,
        stream: true,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      res.write(`data: ${JSON.stringify({ error: `OpenAI error: ${error}` })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    const decoder = new TextDecoder();
    let fullResponse = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") {
            continue;
          }

          try {
            const parsed = JSON.parse(data) as {
              choices: Array<{ delta: { content?: string } }>;
            };
            const content = parsed.choices[0]?.delta?.content;
            if (content) {
              fullResponse += content;
              res.write(`data: ${JSON.stringify({ text: content })}\n\n`);
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    }

    // Store assistant response
    state.messages.push({ role: "assistant", content: fullResponse });

    // Prune old conversations
    if (conversations.size > 100) {
      const sorted = [...conversations.entries()].sort(
        (a, b) => a[1].createdAt - b[1].createdAt
      );
      for (let i = 0; i < sorted.length - 100; i++) {
        conversations.delete(sorted[i][0]);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
  }

  res.write("data: [DONE]\n\n");
  res.end();
}

/**
 * Handle health check
 */
function handleHealth(): HealthResponse {
  return {
    status: "healthy",
    runtime: "typescript",
    version: "1.0.0",
  };
}

/**
 * Handle info endpoint
 */
function handleInfo(): InfoResponse {
  const character = getCharacter();
  return {
    name: character.name,
    bio: character.bio ?? "A helpful AI assistant.",
    version: "1.0.0",
    powered_by: "elizaOS",
    endpoints: {
      "POST /chat": "Send a message and receive a response",
      "POST /chat/stream": "Send a message and receive a streaming response",
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
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  console.log(`${method} ${path}`);

  // Handle CORS preflight
  if (method === "OPTIONS") {
    sendJson(res, 200, { message: "OK" });
    return;
  }

  try {
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

    // Streaming chat endpoint
    if (path === "/chat/stream" && method === "POST") {
      const body = await parseBody<Record<string, unknown>>(req);
      const request = validateChatRequest(body);
      await handleStreamChat(request, res);
      return;
    }

    // Not found
    sendJson(res, 404, { error: "Not found", code: "NOT_FOUND" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Request error:", message);

    if (message.includes("required") || message.includes("must be")) {
      sendJson(res, 400, { error: message, code: "BAD_REQUEST" });
      return;
    }

    sendJson(res, 500, { error: "Internal server error", code: "INTERNAL_ERROR" });
  }
}

// Start server
const PORT = parseInt(process.env.PORT ?? "8080", 10);

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("Unhandled error:", err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "Internal server error", code: "INTERNAL_ERROR" });
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 elizaOS Cloud Run worker started on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`💬 Chat endpoint: http://localhost:${PORT}/chat`);
  console.log(`📡 Stream endpoint: http://localhost:${PORT}/chat/stream`);
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

