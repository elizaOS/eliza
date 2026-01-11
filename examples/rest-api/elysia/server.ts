/**
 * elizaOS REST API Example - Elysia
 *
 * A simple REST API server for chat with an AI agent.
 * Uses plugin-eliza-classic for pattern-matching responses.
 * No API keys or external services required.
 */

import { generateElizaResponse } from "@elizaos/plugin-eliza-classic";
import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { v4 as uuidv4 } from "uuid";

// ============================================================================
// Configuration
// ============================================================================

const PORT = Number(process.env.PORT ?? 3000);

const CHARACTER = {
  name: "Eliza",
  bio: "A classic pattern-matching psychotherapist simulation.",
};

// ============================================================================
// Types
// ============================================================================

interface ChatRequest {
  message: string;
  userId?: string;
}

// ============================================================================
// Elysia App
// ============================================================================

const _app = new Elysia()
  .use(cors())

  // GET / - Info endpoint
  .get("/", () => ({
    name: CHARACTER.name,
    bio: CHARACTER.bio,
    version: "1.0.0",
    powered_by: "elizaOS",
    framework: "Elysia",
    endpoints: {
      "POST /chat": "Send a message and receive a response",
      "GET /health": "Health check endpoint",
      "GET /": "This info endpoint",
    },
  }))

  // GET /health - Health check
  .get("/health", () => ({
    status: "healthy",
    character: CHARACTER.name,
    timestamp: new Date().toISOString(),
  }))

  // POST /chat - Chat with the agent
  .post("/chat", async ({ body, set }) => {
    const { message, userId: clientUserId } = body as ChatRequest;

    if (!message || typeof message !== "string") {
      set.status = 400;
      return { error: "Message is required and must be a string" };
    }

    const userId = clientUserId ?? uuidv4();
    const response = generateElizaResponse(message);

    return {
      response,
      character: CHARACTER.name,
      userId,
    };
  })

  .listen(PORT);

// ============================================================================
// Server Startup
// ============================================================================

console.log(`\n🌐 elizaOS REST API (Elysia)`);
console.log(`   http://localhost:${PORT}\n`);
console.log(`📚 Endpoints:`);
console.log(`   GET  /       - Agent info`);
console.log(`   GET  /health - Health check`);
console.log(`   POST /chat   - Chat with agent\n`);
