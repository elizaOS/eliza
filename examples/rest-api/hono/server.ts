/**
 * elizaOS REST API Example - Hono
 *
 * A simple REST API server for chat with an AI agent.
 * Uses plugin-eliza-classic for pattern-matching responses.
 * No API keys or external services required.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { v4 as uuidv4 } from "uuid";
import { generateElizaResponse } from "@elizaos/plugin-eliza-classic";

// ============================================================================
// Configuration
// ============================================================================

const PORT = Number(process.env.PORT ?? 3000);

const CHARACTER = {
  name: "Eliza",
  bio: "A classic pattern-matching psychotherapist simulation.",
};

// ============================================================================
// Hono App
// ============================================================================

const app = new Hono();

// CORS middleware
app.use("*", cors());

// ============================================================================
// Routes
// ============================================================================

/**
 * GET / - Info endpoint
 */
app.get("/", (c) => {
  return c.json({
    name: CHARACTER.name,
    bio: CHARACTER.bio,
    version: "1.0.0",
    powered_by: "elizaOS",
    framework: "Hono",
    endpoints: {
      "POST /chat": "Send a message and receive a response",
      "GET /health": "Health check endpoint",
      "GET /": "This info endpoint",
    },
  });
});

/**
 * GET /health - Health check
 */
app.get("/health", (c) => {
  return c.json({
    status: "healthy",
    character: CHARACTER.name,
    timestamp: new Date().toISOString(),
  });
});

interface ChatRequest {
  message: string;
  userId?: string;
}

/**
 * POST /chat - Chat with the agent
 */
app.post("/chat", async (c) => {
  try {
    const body = await c.req.json<ChatRequest>();
    const { message, userId: clientUserId } = body;

    if (!message || typeof message !== "string") {
      return c.json({ error: "Message is required and must be a string" }, 400);
    }

    const userId = clientUserId ?? uuidv4();
    const response = generateElizaResponse(message);

    return c.json({
      response,
      character: CHARACTER.name,
      userId,
    });
  } catch (error) {
    console.error("Chat error:", error);
    return c.json({ error: error instanceof Error ? error.message : "Internal server error" }, 500);
  }
});

// ============================================================================
// Server Startup
// ============================================================================

console.log(`\n🌐 elizaOS REST API (Hono)`);
console.log(`   http://localhost:${PORT}\n`);
console.log(`📚 Endpoints:`);
console.log(`   GET  /       - Agent info`);
console.log(`   GET  /health - Health check`);
console.log(`   POST /chat   - Chat with agent\n`);

export default {
  port: PORT,
  fetch: app.fetch,
};
