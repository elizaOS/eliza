/**
 * Serverless AgentRuntime Manager for Supabase Edge Functions
 *
 * This is a lightweight elizaOS runtime for serverless environments.
 * It provides the same chat capabilities as the full runtime but optimized
 * for edge function cold starts and stateless execution.
 */

import type {
  Character,
  ChatRequest,
  ChatResponse,
  ErrorResponse,
  HealthResponse,
  OpenAIChatMessage,
  UUID,
} from "./types.ts";


// ============================================================================
// Global State for Warm Container Reuse
// ============================================================================

interface GlobalRuntimeState {
  __elizaRuntime?: ElizaRuntimeManager | null;
  __runtimeInitialized?: boolean;
}

// Helper function to safely access global state with proper typing
function getGlobalState(): GlobalRuntimeState {
  // Type assertion needed because Deno's globalThis doesn't have our custom properties
  // We verify the properties exist at runtime before using them
  return globalThis as GlobalRuntimeState;
}

// Deno global state for warm container reuse
const globalState = getGlobalState();
if (typeof globalState.__runtimeInitialized === "undefined") {
  globalState.__runtimeInitialized = false;
}

// ============================================================================
// Logger
// ============================================================================

const logger = {
  info: (message: string, ...args: unknown[]) =>
    console.log(`[elizaOS] ${message}`, ...args),
  warn: (message: string, ...args: unknown[]) =>
    console.warn(`[elizaOS] ${message}`, ...args),
  error: (message: string, ...args: unknown[]) =>
    console.error(`[elizaOS] ${message}`, ...args),
  debug: (message: string, ...args: unknown[]) =>
    console.debug(`[elizaOS] ${message}`, ...args),
};

// ============================================================================
// Character Configuration
// ============================================================================

function getCharacter(): Character {
  return {
    name: Deno.env.get("CHARACTER_NAME") ?? "Eliza",
    bio: Deno.env.get("CHARACTER_BIO") ?? "A helpful AI assistant.",
    system:
      Deno.env.get("CHARACTER_SYSTEM") ??
      "You are a helpful, concise AI assistant. Respond thoughtfully to user messages.",
  };
}

// ============================================================================
// ElizaOS Runtime Manager
// ============================================================================

class ElizaRuntimeManager {
  private static instance: ElizaRuntimeManager;

  private agentId: UUID;
  private character: Character;
  private openaiApiKey: string;
  private model: string;
  private isInitialized = false;

  private constructor() {
    const openaiApiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiApiKey) {
      throw new Error("OPENAI_API_KEY environment variable is required");
    }

    this.openaiApiKey = openaiApiKey;
    this.character = getCharacter();
    this.model = Deno.env.get("OPENAI_LARGE_MODEL") ?? "gpt-5";
    this.agentId = crypto.randomUUID() as UUID;

    logger.info("ElizaRuntimeManager instance created");
  }

  /**
   * Get or create the singleton instance
   */
  public static getInstance(): ElizaRuntimeManager {
    // Check global state first (warm container reuse)
    if (globalState.__elizaRuntime) {
      return globalState.__elizaRuntime;
    }

    if (!ElizaRuntimeManager.instance) {
      ElizaRuntimeManager.instance = new ElizaRuntimeManager();
      globalState.__elizaRuntime = ElizaRuntimeManager.instance;
    }

    return ElizaRuntimeManager.instance;
  }

  /**
   * Initialize the runtime
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    logger.info("Initializing elizaOS runtime...");

    // In a full implementation, this would initialize:
    // - Database connections
    // - Plugin loading
    // - Memory services
    // For serverless, we keep it minimal

    this.isInitialized = true;
    globalState.__runtimeInitialized = true;

    logger.info("elizaOS runtime initialized successfully");
  }

  /**
   * Handle a chat message and generate a response
   */
  public async handleChat(request: ChatRequest): Promise<ChatResponse> {
    await this.initialize();

    const conversationId =
      request.conversationId ??
      `conv-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    logger.info(`Processing message for conversation ${conversationId}`);

    // Build messages for OpenAI
    const messages: OpenAIChatMessage[] = [
      {
        role: "system",
        content: this.character.system,
      },
      {
        role: "user",
        content: request.message,
      },
    ];

    // Call OpenAI API
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.openaiApiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: 1024,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error("OpenAI API error:", errorText);
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    const responseText =
      data.choices[0]?.message?.content ??
      "I apologize, but I could not generate a response.";

    logger.info("Message processed successfully");

    return {
      response: responseText,
      conversationId,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Health check
   */
  public getHealth(): HealthResponse {
    return {
      status: "healthy",
      runtime: "elizaos-deno",
      version: "1.0.0",
    };
  }

  /**
   * Get character configuration
   */
  public getCharacter(): Character {
    return this.character;
  }

  /**
   * Get agent ID
   */
  public getAgentId(): UUID {
    return this.agentId;
  }
}

// ============================================================================
// Response Helpers
// ============================================================================

import { corsHeaders as cors } from "./types.ts";

export function jsonResponse<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors,
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
 * Parse and validate the incoming request body
 */
function parseRequestBody(body: Record<string, unknown>): ChatRequest {
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
 * Handle POST /chat request
 */
export async function handleChat(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const request = parseRequestBody(body);

    const runtime = ElizaRuntimeManager.getInstance();
    const response = await runtime.handleChat(request);

    return jsonResponse(response);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    logger.error("Chat error:", errorMessage);

    if (errorMessage.includes("required") || errorMessage.includes("must be")) {
      return errorResponse(errorMessage, 400, "BAD_REQUEST");
    }

    return errorResponse("Internal server error", 500, "INTERNAL_ERROR");
  }
}

/**
 * Handle GET /health request
 */
export function handleHealth(): Response {
  const runtime = ElizaRuntimeManager.getInstance();
  const health = runtime.getHealth();
  return jsonResponse(health);
}

// Export the runtime manager for advanced use cases
export { ElizaRuntimeManager };
