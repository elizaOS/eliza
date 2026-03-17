/**
 * Vercel Edge Function - Chat Endpoint
 *
 * Uses the elizaOS runtime with edge-compatible imports (InMemory adapter, no SQL).
 * For persistent storage use a Node.js API route with POSTGRES_URL and createDatabaseAdapter.
 */

import {
  AgentRuntime,
  ChannelType,
  type Character,
  createCharacter,
  createMessageMemory,
  InMemoryDatabaseAdapter,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { openaiPlugin } from "@elizaos/plugin-openai";
import { v4 as uuidv4 } from "uuid";

export const config = {
  runtime: "edge",
};

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

function getCharacter(): Character {
  const secrets: Record<string, string> = {};
  if (typeof process !== "undefined" && process.env?.OPENAI_API_KEY) {
    secrets.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  }
  const name =
    typeof process !== "undefined" && process.env?.CHARACTER_NAME
      ? process.env.CHARACTER_NAME
      : "Eliza";
  const bio =
    typeof process !== "undefined" && process.env?.CHARACTER_BIO
      ? process.env.CHARACTER_BIO
      : "A helpful AI assistant.";
  const system =
    typeof process !== "undefined" && process.env?.CHARACTER_SYSTEM
      ? process.env.CHARACTER_SYSTEM
      : "You are a helpful, concise AI assistant. Respond thoughtfully to user messages.";
  return createCharacter({
    name,
    bio,
    system,
    secrets,
  });
}

let runtime: AgentRuntime | null = null;
let initializationPromise: Promise<AgentRuntime> | null = null;

async function initializeRuntime(): Promise<AgentRuntime> {
  if (runtime) return runtime;
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    const character = getCharacter();
    const agentId = stringToUuid(character.name ?? "Eliza");
    const adapter = new InMemoryDatabaseAdapter();
    await adapter.initialize();

    const newRuntime = new AgentRuntime({
      character,
      adapter,
      plugins: [openaiPlugin],
    });
    await newRuntime.initialize();

    runtime = newRuntime;
    return newRuntime;
  })();

  return initializationPromise;
}

function jsonResponse<T extends object>(statusCode: number, body: T): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    },
  });
}

async function handleChat(request: ChatRequest): Promise<ChatResponse> {
  const rt = await initializeRuntime();

  const userId = uuidv4() as UUID;
  const conversationId =
    request.conversationId ??
    `conv-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const roomId = stringToUuid(conversationId);
  const worldId = stringToUuid("vercel-world");

  await rt.ensureConnection({
    entityId: userId,
    roomId,
    worldId,
    userName: "User",
    source: "vercel-edge",
    channelId: conversationId,
    serverId: "vercel-worker",
    type: ChannelType.DM,
  } as Parameters<typeof rt.ensureConnection>[0]);

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

export default async function handler(request: Request): Promise<Response> {
  const method = request.method;

  // Handle CORS preflight
  if (method === "OPTIONS") {
    return jsonResponse(200, { message: "OK" });
  }

  // Only allow POST
  if (method !== "POST") {
    return jsonResponse(405, {
      error: "Method not allowed",
      code: "METHOD_NOT_ALLOWED",
    } as Record<string, unknown>);
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;

    if (typeof body.message !== "string" || !body.message.trim()) {
      return jsonResponse(400, {
        error: "Message is required and must be a non-empty string",
        code: "BAD_REQUEST",
      });
    }

    const chatRequest: ChatRequest = {
      message: body.message.trim(),
      userId: typeof body.userId === "string" ? body.userId : undefined,
      conversationId:
        typeof body.conversationId === "string"
          ? body.conversationId
          : undefined,
    };

    const response = await handleChat(chatRequest);
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
