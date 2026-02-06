/**
 * elizaOS Supabase Edge Function (with optional Rust WASM acceleration)
 *
 * Uses the canonical elizaOS runtime with messageService.handleMessage pattern.
 *
 * NOTE: The WASM module can accelerate parsing and validation operations,
 * but the core message processing goes through the elizaOS runtime.
 *
 * Build the WASM module (optional):
 *   cd examples/supabase/rust
 *   wasm-pack build --target web --out-dir ../functions/eliza-chat-wasm/wasm
 */

// Deno runtime types for Supabase Edge Functions
declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
  serve(handler: (req: Request) => Promise<Response> | Response): void;
};

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

// ============================================================================
// Types
// ============================================================================

interface ChatRequest {
  message: string;
  userId?: string;
}

interface ChatResponse {
  response: string;
  userId: string;
  timestamp: string;
}

interface HealthResponse {
  status: "healthy" | "unhealthy" | "initializing";
  runtime: string;
  version: string;
  wasmEnabled: boolean;
}

interface ErrorResponse {
  error: string;
  code: string;
}

// ============================================================================
// CORS Headers
// ============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// ============================================================================
// WASM Module (Optional - for parsing acceleration)
// ============================================================================

interface WasmModule {
  parse_chat_request: (json: string) => ChatRequest;
  validate_message: (message: string) => boolean;
}

let wasmModule: WasmModule | null = null;

async function initWasm(): Promise<WasmModule | null> {
  if (wasmModule) return wasmModule;

  try {
    // Try to import the WASM module if built
    // const wasm = await import("./wasm/eliza_chat_wasm.js");
    // await wasm.default();
    // wasmModule = wasm;
    console.log("[elizaOS] WASM module not available, using TypeScript");
  } catch {
    console.log("[elizaOS] WASM module not built, using TypeScript fallback");
  }

  return wasmModule;
}

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

let runtime: IAgentRuntime | null = null;
let initPromise: Promise<IAgentRuntime> | null = null;
let initError: string | null = null;

const roomId = stringToUuid("supabase-wasm-room");
const worldId = stringToUuid("supabase-wasm-world");

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

function jsonResponse<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function errorResponse(
  message: string,
  status = 400,
  code = "ERROR",
): Response {
  const error: ErrorResponse = { error: message, code };
  return jsonResponse(error, status);
}

// ============================================================================
// Request Handlers
// ============================================================================

async function handleChat(req: Request): Promise<Response> {
  const wasm = await initWasm();

  try {
    const body = (await req.json()) as Record<string, unknown>;

    // Parse and validate request (use WASM if available)
    let message: string;
    if (wasm) {
      const parsed = wasm.parse_chat_request(JSON.stringify(body));
      message = parsed.message;
    } else {
      if (typeof body.message !== "string" || !body.message.trim()) {
        return errorResponse(
          "Message is required and must be a non-empty string",
          400,
          "BAD_REQUEST",
        );
      }
      message = body.message.trim();
    }

    const userId = (
      typeof body.userId === "string" ? body.userId : crypto.randomUUID()
    ) as UUID;

    console.log(`[elizaOS] Processing message for user ${userId}`);

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
      source: "supabase-wasm",
      channelId: "edge-function-wasm",
      serverId: "supabase-edge-wasm",
      type: ChannelType.API,
    } as Parameters<typeof rt.ensureConnection>[0]);

    // Create message memory using canonical helper
    const messageMemory = createMessageMemory({
      id: crypto.randomUUID() as UUID,
      entityId: userId,
      roomId,
      content: {
        text: message,
        source: "supabase_edge_wasm",
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

    const chatResponse: ChatResponse = {
      response: responseText || "I could not generate a response.",
      userId,
      timestamp: new Date().toISOString(),
    };

    console.log("[elizaOS] Message processed successfully");
    return jsonResponse(chatResponse);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("[elizaOS] Chat error:", errorMessage);
    return errorResponse("Internal server error", 500, "INTERNAL_ERROR");
  }
}

function handleHealth(): Response {
  const health: HealthResponse = {
    status: runtime ? "healthy" : initError ? "unhealthy" : "initializing",
    runtime: "elizaos-supabase-wasm",
    version: "2.0.0",
    wasmEnabled: wasmModule !== null,
  };
  return jsonResponse(health);
}

// ============================================================================
// Main Handler
// ============================================================================

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const method = req.method;
  const path = url.pathname;

  console.log(`[elizaOS] ${method} ${path}`);

  // Handle CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // Health check endpoint
  if (path.endsWith("/health") && method === "GET") {
    return handleHealth();
  }

  // Root health check
  if ((path === "/" || path.endsWith("/eliza-chat-wasm")) && method === "GET") {
    return handleHealth();
  }

  // Chat endpoint
  if (method === "POST") {
    return await handleChat(req);
  }

  return errorResponse(
    `Method ${method} not allowed`,
    405,
    "METHOD_NOT_ALLOWED",
  );
});
