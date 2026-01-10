/**
 * elizaOS REST API Example - Express.js
 *
 * A simple REST API server for chat with an AI agent.
 * Uses plugin-eliza-classic for pattern-matching responses.
 * No API keys or external services required.
 */

import express, { Request, Response, NextFunction } from "express";
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
// Express App
// ============================================================================

const app = express();
app.use(express.json());

// CORS middleware
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (_req.method === "OPTIONS") {
    res.sendStatus(200);
    return;
  }
  next();
});

// ============================================================================
// Routes
// ============================================================================

/**
 * GET / - Info endpoint
 */
app.get("/", (_req: Request, res: Response) => {
  res.json({
    name: CHARACTER.name,
    bio: CHARACTER.bio,
    version: "1.0.0",
    powered_by: "elizaOS",
    framework: "Express.js",
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
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "healthy",
    character: CHARACTER.name,
    timestamp: new Date().toISOString(),
  });
});

interface ChatRequestBody {
  message: string;
  userId?: string;
}

/**
 * POST /chat - Chat with the agent
 */
app.post("/chat", (req: Request<object, object, ChatRequestBody>, res: Response) => {
  try {
    const { message, userId: clientUserId } = req.body;

    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "Message is required and must be a string" });
      return;
    }

    const userId = clientUserId ?? uuidv4();
    const response = generateElizaResponse(message);

    res.json({
      response,
      character: CHARACTER.name,
      userId,
    });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

// ============================================================================
// Server Startup
// ============================================================================

app.listen(PORT, () => {
  console.log(`\n🌐 elizaOS REST API (Express.js)`);
  console.log(`   http://localhost:${PORT}\n`);
  console.log(`📚 Endpoints:`);
  console.log(`   GET  /       - Agent info`);
  console.log(`   GET  /health - Health check`);
  console.log(`   POST /chat   - Chat with agent\n`);
});
