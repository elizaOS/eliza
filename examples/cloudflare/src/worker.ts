/**
 * elizaOS Cloudflare Worker
 *
 * A serverless AI agent running on Cloudflare Workers.
 * Uses the canonical elizaOS runtime with messageService.handleMessage().
 *
 * IMPORTANT: This example demonstrates proper elizaOS integration:
 * - Uses AgentRuntime for message processing
 * - Uses runtime.messageService.handleMessage() for the full pipeline
 * - Never calls LLM APIs directly
 * - Never bypasses the elizaOS message pipeline
 */

import {
  AgentRuntime,
  ChannelType,
  type Character,
  type Content,
  createCharacter,
  createMessageMemory,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { openaiPlugin } from "@elizaos/plugin-openai";
import { v4 as uuidv4 } from "uuid";

// ============================================================================
// Environment Configuration
// ============================================================================

export interface Env {
  OPENAI_API_KEY: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;
  CHARACTER_NAME?: string;
  CHARACTER_BIO?: string;
  CHARACTER_SYSTEM?: string;
}

// ============================================================================
// Types
// ============================================================================

interface ChatRequest {
  message: string;
  conversationId?: string;
  userId?: string;
}

interface ChatResponse {
  response: string;
  conversationId: string;
  character: string;
}

// ============================================================================
// Runtime Management
// ============================================================================

// Cache runtime per worker instance (Cloudflare Workers are isolated per request,
// but may reuse instances for subsequent requests to the same worker)
let cachedRuntime: IAgentRuntime | null = null;
let cachedEnvHash: string | null = null;

/**
 * Create a hash of environment variables for cache invalidation
 */
function getEnvHash(env: Env): string {
  return `${env.OPENAI_API_KEY?.slice(-8)}-${env.CHARACTER_NAME}-${env.OPENAI_MODEL}`;
}

/**
 * Create the character configuration from environment variables
 */
function createAgentCharacter(env: Env): Character {
  const name = env.CHARACTER_NAME || "Eliza";
  const bio =
    env.CHARACTER_BIO || "A helpful AI assistant powered by elizaOS.";

  return createCharacter({
    name,
    bio,
    system:
      env.CHARACTER_SYSTEM ||
      `You are ${name}, a helpful AI assistant. ${bio}
      
Be conversational, helpful, and friendly. When asked questions, provide clear and accurate information.
Keep responses concise but informative.`,
    secrets: {
      OPENAI_API_KEY: env.OPENAI_API_KEY,
      OPENAI_BASE_URL: env.OPENAI_BASE_URL,
      OPENAI_SMALL_MODEL: env.OPENAI_MODEL,
    },
  });
}

/**
 * Get or create the AgentRuntime instance
 *
 * The runtime is cached per worker instance to avoid re-initialization
 * overhead on subsequent requests.
 */
async function getRuntime(env: Env): Promise<IAgentRuntime> {
  const envHash = getEnvHash(env);

  // Return cached runtime if environment hasn't changed
  if (cachedRuntime && cachedEnvHash === envHash) {
    return cachedRuntime;
  }

  console.log("[elizaOS] Initializing AgentRuntime...");

  const character = createAgentCharacter(env);

  const runtime = new AgentRuntime({
    character,
    plugins: [
      openaiPlugin, // Provides LLM capabilities through the elizaOS pipeline
    ],
  });

  await runtime.initialize();

  cachedRuntime = runtime;
  cachedEnvHash = envHash;

  console.log("[elizaOS] AgentRuntime initialized successfully");
  return runtime;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if the runtime has a messageService available
 */
function hasMessageService(runtime: IAgentRuntime): boolean {
  return (
    runtime.messageService !== null &&
    typeof runtime.messageService?.handleMessage === "function"
  );
}

/**
 * Create unique identifiers for a conversation
 */
function getConversationIds(conversationId: string | undefined): {
  id: string;
  roomId: UUID;
  worldId: UUID;
} {
  const id = conversationId || uuidv4();
  return {
    id,
    roomId: stringToUuid(`cloudflare-room-${id}`),
    worldId: stringToUuid("cloudflare-worker-world"),
  };
}

// ============================================================================
// Request Handlers
// ============================================================================

/**
 * Handle chat messages using the canonical elizaOS pipeline
 *
 * This is the CORRECT way to process messages in elizaOS:
 * 1. Create a message memory using createMessageMemory()
 * 2. Ensure the connection exists (creates entity, room if needed)
 * 3. Call runtime.messageService.handleMessage() for full pipeline processing
 * 4. Return the response via the callback
 */
async function handleChat(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as ChatRequest;
  const { message, conversationId, userId: clientUserId } = body;

  if (!message || typeof message !== "string") {
    return Response.json(
      { error: "Message is required and must be a string" },
      { status: 400 }
    );
  }

  const runtime = await getRuntime(env);

  if (!hasMessageService(runtime)) {
    return Response.json(
      { error: "MessageService not available - runtime not properly initialized" },
      { status: 500 }
    );
  }

  const { id, roomId, worldId } = getConversationIds(conversationId);
  const entityId = stringToUuid(clientUserId || uuidv4());

  // Ensure the connection exists (creates entity, room, world if needed)
  await runtime.ensureConnection({
    entityId,
    roomId,
    worldId,
    userName: "User",
    name: "Cloudflare User",
    source: "cloudflare-worker",
    channelId: id,
    type: ChannelType.DM,
    worldName: "Cloudflare Workers",
  });

  // Create the incoming message memory using the canonical helper
  const messageMemory = createMessageMemory({
    id: stringToUuid(uuidv4()) as UUID,
    entityId,
    agentId: runtime.agentId,
    roomId,
    content: {
      text: message,
      source: "cloudflare-worker",
      channelType: ChannelType.DM,
      metadata: {
        conversationId: id,
        platform: "cloudflare-workers",
      },
    },
  });

  // Collect response from the elizaOS pipeline
  let responseText = "";

  /**
   * Callback function called by messageService when a response is generated
   */
  const callback: HandlerCallback = async (content: Content): Promise<Memory[]> => {
    if (content.text?.trim()) {
      responseText = content.text;
    }

    // Create memory for the response
    const responseMemory: Memory = {
      id: stringToUuid(uuidv4()) as UUID,
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId,
      content: {
        ...content,
        text: responseText,
        inReplyTo: messageMemory.id,
        metadata: {
          conversationId: id,
          platform: "cloudflare-workers",
        },
      },
      createdAt: Date.now(),
    };

    return [responseMemory];
  };

  // Process through the FULL elizaOS pipeline
  try {
    const result = await runtime.messageService?.handleMessage(
      runtime,
      messageMemory,
      callback
    );

    // Extract response from result if callback didn't capture it
    if (!responseText && result?.responseContent?.text) {
      responseText = result.responseContent.text;
    }

    if (!responseText) {
      responseText = "I apologize, but I was unable to generate a response.";
    }

    const response: ChatResponse = {
      response: responseText,
      conversationId: id,
      character: runtime.character.name,
    };

    return Response.json(response);
  } catch (error) {
    console.error("[elizaOS] Error processing message:", error);
    return Response.json(
      {
        error: "Failed to process message",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

/**
 * Handle streaming chat using the elizaOS pipeline
 *
 * Streaming responses are handled through the callback mechanism.
 */
async function handleStreamChat(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as ChatRequest;
  const { message, conversationId, userId: clientUserId } = body;

  if (!message || typeof message !== "string") {
    return Response.json(
      { error: "Message is required and must be a string" },
      { status: 400 }
    );
  }

  const runtime = await getRuntime(env);

  if (!hasMessageService(runtime)) {
    return Response.json(
      { error: "MessageService not available - runtime not properly initialized" },
      { status: 500 }
    );
  }

  const { id, roomId, worldId } = getConversationIds(conversationId);
  const entityId = stringToUuid(clientUserId || uuidv4());

  await runtime.ensureConnection({
    entityId,
    roomId,
    worldId,
    userName: "User",
    name: "Cloudflare User",
    source: "cloudflare-worker",
    channelId: id,
    type: ChannelType.DM,
    worldName: "Cloudflare Workers",
  });

  const messageMemory = createMessageMemory({
    id: stringToUuid(uuidv4()) as UUID,
    entityId,
    agentId: runtime.agentId,
    roomId,
    content: {
      text: message,
      source: "cloudflare-worker",
      channelType: ChannelType.DM,
      metadata: {
        conversationId: id,
        platform: "cloudflare-workers",
      },
    },
  });

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // Send initial metadata
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            conversationId: id,
            character: runtime.character.name,
          })}\n\n`
        )
      );

      let fullResponse = "";

      const callback: HandlerCallback = async (content: Content): Promise<Memory[]> => {
        if (content.text?.trim()) {
          fullResponse = content.text;
          // Send the complete response as a chunk
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ text: content.text })}\n\n`)
          );
        }

        return [];
      };

      try {
        const result = await runtime.messageService?.handleMessage(
          runtime,
          messageMemory,
          callback
        );

        // If response wasn't sent via callback, send it from result
        if (!fullResponse && result?.responseContent?.text) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ text: result.responseContent.text })}\n\n`
            )
          );
        }
      } catch (error) {
        console.error("[elizaOS] Error in streaming:", error);
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              error: error instanceof Error ? error.message : "Unknown error",
            })}\n\n`
          )
        );
      }

      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Health check endpoint
 */
async function handleHealth(env: Env): Promise<Response> {
  try {
    const runtime = await getRuntime(env);
    return Response.json({
      status: "healthy",
      character: runtime.character.name,
      runtimeInitialized: true,
      messageServiceAvailable: hasMessageService(runtime),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json({
      status: "unhealthy",
      error: error instanceof Error ? error.message : "Unknown error",
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Info endpoint
 */
function handleInfo(env: Env): Response {
  const name = env.CHARACTER_NAME || "Eliza";
  const bio = env.CHARACTER_BIO || "A helpful AI assistant powered by elizaOS.";

  return Response.json({
    name,
    bio,
    version: "2.0.0",
    powered_by: "elizaOS",
    implementation: "canonical",
    description:
      "This worker uses the canonical elizaOS implementation with runtime.messageService.handleMessage()",
    endpoints: {
      "POST /chat": "Send a message and receive a response via elizaOS pipeline",
      "POST /chat/stream": "Send a message and receive a streaming response",
      "GET /health": "Health check endpoint with runtime status",
      "GET /": "This info endpoint",
    },
  });
}

// ============================================================================
// Main Worker Export
// ============================================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Validate API key is configured
    if (!env.OPENAI_API_KEY) {
      return Response.json(
        { error: "OPENAI_API_KEY is not configured" },
        { status: 500 }
      );
    }

    try {
      // Route handling
      if (path === "/" && request.method === "GET") {
        return handleInfo(env);
      }

      if (path === "/health" && request.method === "GET") {
        return await handleHealth(env);
      }

      if (path === "/chat" && request.method === "POST") {
        return await handleChat(request, env);
      }

      if (path === "/chat/stream" && request.method === "POST") {
        return await handleStreamChat(request, env);
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      console.error("[elizaOS] Unhandled error:", error);
      return Response.json(
        {
          error: "Internal server error",
          details: error instanceof Error ? error.message : String(error),
        },
        { status: 500 }
      );
    }
  },
};
