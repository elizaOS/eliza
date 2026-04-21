/**
 * AWS Lambda handler for elizaOS chat worker
 *
 * This Lambda function processes chat messages and returns AI responses
 * using the full elizaOS runtime with OpenAI as the LLM provider.
 *
 * This is identical to the chat demo pattern but exposed as an HTTP API.
 */

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
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context,
} from "aws-lambda";
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

interface ErrorResponse {
  error: string;
  code: string;
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

// Singleton runtime instance (reused across Lambda invocations)
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
      throw new Error("Runtime initialization failed");
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
    throw new Error("Runtime initialization failed");
  }
  return runtime;
}

/**
 * Parse and validate the incoming request body
 */
function parseRequestBody(body: string | undefined): ChatRequest {
  if (!body) {
    throw new Error("Request body is required");
  }

  const parsed = JSON.parse(body) as Record<string, unknown>;

  if (typeof parsed.message !== "string" || !parsed.message.trim()) {
    throw new Error("Message is required and must be a non-empty string");
  }

  return {
    message: parsed.message.trim(),
    userId: typeof parsed.userId === "string" ? parsed.userId : undefined,
    conversationId:
      typeof parsed.conversationId === "string"
        ? parsed.conversationId
        : undefined,
  };
}

/**
 * Create a JSON response with proper headers
 */
function jsonResponse(
  statusCode: number,
  body: object,
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

/**
 * Handle chat message using full elizaOS runtime (same as chat demo)
 */
async function handleChat(
  request: ChatRequest,
  _context: Context,
): Promise<ChatResponse> {
  const rt = await initializeRuntime();

  // Generate IDs (using same pattern as chat demo)
  const userId = uuidv4() as UUID;
  const conversationId =
    request.conversationId ??
    `conv-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const roomId = stringToUuid(conversationId);
  const worldId = stringToUuid("lambda-world");

  // Ensure connection exists (same as chat demo)
  await rt.ensureConnection({
    entityId: userId,
    roomId,
    worldId,
    userName: "User",
    source: "aws-lambda",
    channelId: conversationId,
    serverId: "lambda-worker",
    type: ChannelType.DM,
  } as Parameters<typeof rt.ensureConnection>[0]);

  // Create message memory (same as chat demo)
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

  // Process message and collect response (same as chat demo)
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
 * Main Lambda handler
 */
export async function handler(
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyResultV2> {
  const path = event.rawPath ?? event.requestContext?.http?.path ?? "/";
  const method = event.requestContext?.http?.method ?? "GET";

  console.log(`${method} ${path}`);

  // Handle CORS preflight
  if (method === "OPTIONS") {
    return jsonResponse(200, { message: "OK" });
  }

  // Health check endpoint
  if (path === "/health" || path === "/") {
    if (method === "GET") {
      const response: HealthResponse = {
        status: "healthy",
        runtime: "elizaos-typescript",
        version: "1.0.0",
      };
      return jsonResponse(200, response);
    }
  }

  // Chat endpoint
  if (path === "/chat") {
    if (method !== "POST") {
      const error: ErrorResponse = {
        error: "Method not allowed",
        code: "METHOD_NOT_ALLOWED",
      };
      return jsonResponse(405, error);
    }

    try {
      const request = parseRequestBody(event.body);
      const response = await handleChat(request, context);
      return jsonResponse(200, response);
    } catch (err) {
      const error = err instanceof Error ? err.message : "Unknown error";
      console.error("Chat error:", error);

      if (error.includes("required") || error.includes("must be")) {
        return jsonResponse(400, { error, code: "BAD_REQUEST" });
      }

      return jsonResponse(500, {
        error: "Internal server error",
        code: "INTERNAL_ERROR",
      });
    }
  }

  // Not found
  return jsonResponse(404, {
    error: "Not found",
    code: "NOT_FOUND",
  });
}

// Export for testing
export { initializeRuntime, parseRequestBody, handleChat };
