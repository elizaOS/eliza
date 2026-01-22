/**
 * elizaOS Runtime for Supabase Edge Functions
 *
 * Uses the canonical elizaOS runtime with messageService.handleMessage pattern.
 *
 * NOTE: Due to Supabase Edge Functions (Deno) constraints, some features may be limited.
 * For full elizaOS features, consider running elizaOS on a dedicated server.
 */

// Import elizaOS packages via npm specifiers (Deno-compatible)
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

import type {
  ChatResponse,
  ErrorResponse,
  HealthResponse,
} from "./types.ts";

// ============================================================================
// Configuration
// ============================================================================

function getCharacter(): Character {
  const name = Deno.env.get("CHARACTER_NAME") ?? "Eliza";
  const bio = Deno.env.get("CHARACTER_BIO") ?? "A helpful AI assistant.";

  return createCharacter({
    name,
    bio,
    system:
      Deno.env.get("CHARACTER_SYSTEM") ??
      `You are ${name}, a helpful AI assistant. ${bio}`,
    secrets: {
      OPENAI_API_KEY: Deno.env.get("OPENAI_API_KEY") ?? "",
      OPENAI_MODEL: Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini",
    },
  });
}

// ============================================================================
// Runtime Management
// ============================================================================

// Singleton runtime (reused across warm function invocations)
let runtime: IAgentRuntime | null = null;
let initPromise: Promise<IAgentRuntime> | null = null;
let initError: string | null = null;

// Session IDs
const roomId = stringToUuid("supabase-room");
const worldId = stringToUuid("supabase-world");

async function getRuntime(): Promise<IAgentRuntime> {
  if (runtime) return runtime;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    console.log("[elizaOS] Initializing runtime...");

    const character = getCharacter();

    const newRuntime = new AgentRuntime({
      character,
      plugins: [openaiPlugin as Plugin],
    });

    await newRuntime.initialize();

    console.log("[elizaOS] Runtime initialized successfully");
    runtime = newRuntime;
    return newRuntime;
  })();

  try {
    return await initPromise;
  } catch (error) {
    initError = error instanceof Error ? error.message : "Unknown error";
    console.error("[elizaOS] Runtime initialization failed:", initError);
    throw error;
  }
}

// ============================================================================
// Response Helpers
// ============================================================================

export function jsonResponse<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Content-Type": "application/json",
    },
  });
}

export function errorResponse(
  message: string,
  status = 400,
  code?: string,
): Response {
  const error: ErrorResponse = {
    error: message,
    code: code ?? "ERROR",
  };
  return jsonResponse(error, status);
}

// ============================================================================
// Request Handlers
// ============================================================================

/**
 * Handle POST /chat request using the canonical elizaOS pattern
 */
export async function handleChat(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as Record<string, unknown>;

    // Validate request
    if (typeof body.message !== "string" || !body.message.trim()) {
      return errorResponse(
        "Message is required and must be a non-empty string",
        400,
        "BAD_REQUEST",
      );
    }

    const message = body.message.trim();
    const userId = (
      typeof body.userId === "string" ? body.userId : crypto.randomUUID()
    ) as UUID;

    // Get runtime
    let rt: IAgentRuntime;
    try {
      rt = await getRuntime();
    } catch {
      return errorResponse(
        `Runtime initialization failed: ${initError}`,
        503,
        "SERVICE_UNAVAILABLE",
      );
    }

    // Ensure connection for this user
    await rt.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      userName: "User",
      source: "supabase",
      channelId: "edge-function",
      serverId: "supabase-edge",
      type: ChannelType.API,
    } as Parameters<typeof rt.ensureConnection>[0]);

    // Create message memory using canonical helper
    const messageMemory = createMessageMemory({
      id: crypto.randomUUID() as UUID,
      entityId: userId,
      roomId,
      content: {
        text: message,
        source: "supabase_edge",
        channelType: ChannelType.API,
      },
    });

    // Process through the FULL elizaOS pipeline
    let responseText = "";
    await rt.messageService?.handleMessage(rt, messageMemory, async (content) => {
      if (content?.text) {
        responseText += content.text;
      }
      return [];
    });

    const response: ChatResponse = {
      response: responseText || "I could not generate a response.",
      conversationId: `${userId}-${Date.now()}`,
      timestamp: new Date().toISOString(),
    };

    console.log("[elizaOS] Message processed successfully");
    return jsonResponse(response);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("[elizaOS] Chat error:", errorMessage);
    return errorResponse("Internal server error", 500, "INTERNAL_ERROR");
  }
}

/**
 * Handle GET /health request
 */
export function handleHealth(): Response {
  const health: HealthResponse = {
    status: runtime ? "healthy" : initError ? "unhealthy" : "initializing",
    runtime: "elizaos-supabase",
    version: "2.0.0",
  };
  return jsonResponse(health);
}
