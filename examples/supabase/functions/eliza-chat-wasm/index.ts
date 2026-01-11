/**
 * Supabase Edge Function handler for elizaOS chat worker (Rust WASM version)
 *
 * This Edge Function uses Rust compiled to WebAssembly for performance-critical
 * operations while still running on the Deno runtime.
 *
 * Build the WASM module first:
 *   cd examples/supabase/rust
 *   wasm-pack build --target web --out-dir ../functions/eliza-chat-wasm/wasm
 */

// Import WASM module (will be available after building)
// Note: In production, you would import the actual WASM module
// import init, { ... } from "./wasm/eliza_chat_wasm.js";

// Fallback to pure TypeScript implementation if WASM not available
// This allows the function to work even without the WASM build

// ============================================================================
// Types
// ============================================================================

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

// ============================================================================
// CORS Headers
// ============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// ============================================================================
// WASM Module Loader
// ============================================================================

interface WasmModule {
  parse_chat_request: (json: string) => unknown;
  build_openai_request: (message: string, system: string, model: string) => string;
  generate_conversation_id: () => string;
  create_chat_response: (response: string, convId: string) => string;
  create_health_response: () => string;
  create_error_response: (error: string, code: string) => string;
  process_message: (message: string) => string;
  extract_openai_response: (json: string) => string;
}

let wasmModule: WasmModule | null = null;
let wasmInitPromise: Promise<void> | null = null;

async function initWasm(): Promise<WasmModule | null> {
  if (wasmModule) return wasmModule;
  
  if (wasmInitPromise) {
    await wasmInitPromise;
    return wasmModule;
  }

  wasmInitPromise = (async () => {
    try {
      // Try to import the WASM module
      // In production, this would be: const wasm = await import("./wasm/eliza_chat_wasm.js");
      // await wasm.default();
      // wasmModule = wasm;
      console.log("[elizaOS-WASM] WASM module not built, using TypeScript fallback");
    } catch (error) {
      console.log("[elizaOS-WASM] WASM not available, using TypeScript fallback:", error);
    }
  })();

  await wasmInitPromise;
  return wasmModule;
}

// ============================================================================
// TypeScript Fallback Implementations
// ============================================================================

function generateConversationId(): string {
  return `conv-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function processMessage(message: string): string {
  return message.trim();
}

function getCharacter(): { name: string; bio: string; system: string } {
  return {
    name: Deno.env.get("CHARACTER_NAME") ?? "Eliza",
    bio: Deno.env.get("CHARACTER_BIO") ?? "A helpful AI assistant.",
    system: Deno.env.get("CHARACTER_SYSTEM") ??
      "You are a helpful, concise AI assistant. Respond thoughtfully to user messages.",
  };
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

function errorResponse(message: string, status = 400, code = "ERROR"): Response {
  const error: ErrorResponse = { error: message, code };
  return jsonResponse(error, status);
}

// ============================================================================
// Request Handlers
// ============================================================================

async function handleChat(req: Request): Promise<Response> {
  const wasm = await initWasm();

  try {
    const body = await req.json() as Record<string, unknown>;
    
    // Validate request (use WASM if available)
    let message: string;
    let conversationId: string;

    if (wasm) {
      // Use WASM for parsing and validation
      const parsed = wasm.parse_chat_request(JSON.stringify(body)) as ChatRequest;
      message = wasm.process_message(parsed.message);
      conversationId = parsed.conversationId ?? wasm.generate_conversation_id();
    } else {
      // TypeScript fallback
      if (typeof body.message !== "string" || !body.message.trim()) {
        throw new Error("Message is required and must be a non-empty string");
      }
      message = processMessage(body.message);
      conversationId = (body.conversationId as string) ?? generateConversationId();
    }

    console.log(`[elizaOS-WASM] Processing message for conversation ${conversationId}`);

    // Get character config
    const character = getCharacter();
    const model = Deno.env.get("OPENAI_LARGE_MODEL") ?? "gpt-5";
    const openaiApiKey = Deno.env.get("OPENAI_API_KEY");

    if (!openaiApiKey) {
      throw new Error("OPENAI_API_KEY environment variable is required");
    }

    // Build OpenAI request (use WASM if available)
    let openaiRequestBody: string;
    if (wasm) {
      openaiRequestBody = wasm.build_openai_request(message, character.system, model);
    } else {
      openaiRequestBody = JSON.stringify({
        model,
        messages: [
          { role: "system", content: character.system },
          { role: "user", content: message },
        ],
        max_tokens: 1024,
        temperature: 0.7,
      });
    }

    // Call OpenAI API
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openaiApiKey}`,
      },
      body: openaiRequestBody,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[elizaOS-WASM] OpenAI API error:", errorText);
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    
    // Extract response (use WASM if available)
    let responseText: string;
    if (wasm) {
      responseText = wasm.extract_openai_response(JSON.stringify(data));
    } else {
      responseText = data.choices[0]?.message?.content ??
        "I apologize, but I could not generate a response.";
    }

    // Build response
    const chatResponse: ChatResponse = {
      response: responseText,
      conversationId,
      timestamp: new Date().toISOString(),
    };

    console.log("[elizaOS-WASM] Message processed successfully");
    return jsonResponse(chatResponse);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("[elizaOS-WASM] Chat error:", errorMessage);

    if (errorMessage.includes("required") || errorMessage.includes("must be")) {
      return errorResponse(errorMessage, 400, "BAD_REQUEST");
    }

    return errorResponse("Internal server error", 500, "INTERNAL_ERROR");
  }
}

function handleHealth(): Response {
  const health: HealthResponse = {
    status: "healthy",
    runtime: wasmModule ? "elizaos-rust-wasm" : "elizaos-deno-fallback",
    version: "1.0.0",
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

  console.log(`[elizaOS-WASM] ${method} ${path}`);

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

  try {
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

    return errorResponse(`Method ${method} not allowed`, 405, "METHOD_NOT_ALLOWED");
  } catch (error) {
    console.error("[elizaOS-WASM] Unhandled error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return errorResponse(`Internal server error: ${errorMessage}`, 500, "INTERNAL_ERROR");
  }
});





