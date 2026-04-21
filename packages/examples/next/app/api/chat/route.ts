/**
 * elizaOS Next.js API Route
 *
 * Uses the canonical elizaOS runtime with messageService.handleMessage pattern.
 *
 * NOTE: If PGLite bundling fails with Next.js, set POSTGRES_URL for external database,
 * or run `elizaos start` separately and connect to its API.
 */

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
import sqlPlugin from "@elizaos/plugin-sql";

import { v4 as uuidv4 } from "uuid";

// Type assertion needed due to namespace import inference
const typedSqlPlugin = sqlPlugin as Plugin;

// Character configuration
// Pass environment variables via character.secrets so getSetting() can find them
const character: Character = createCharacter({
  name: "Eliza",
  bio: "A helpful AI assistant powered by elizaOS.",
  system:
    "You are Eliza, a helpful AI assistant. Be friendly, knowledgeable, and conversational.",
  secrets: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
    POSTGRES_URL: process.env.POSTGRES_URL || "",
  },
});

// Runtime state (singleton for the Next.js server)
let runtime: IAgentRuntime | null = null;
let initPromise: Promise<IAgentRuntime> | null = null;
let initError: string | null = null;

// Session info
const roomId = stringToUuid("chat-room");
const worldId = stringToUuid("chat-world");

async function getRuntime(): Promise<IAgentRuntime> {
  if (runtime) return runtime;

  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      console.log("🚀 Initializing elizaOS runtime...");

      const newRuntime = new AgentRuntime({
        character,
        plugins: [typedSqlPlugin, openaiPlugin],
      });

      await newRuntime.initialize();

      console.log("✅ elizaOS runtime initialized");
      runtime = newRuntime;
      return newRuntime;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("❌ Failed to initialize elizaOS runtime:", message);

      // Check if it's the PGLite extension error
      if (
        message.includes("Extension bundle not found") ||
        message.includes("migrations")
      ) {
        initError =
          "PGLite extensions not compatible with Next.js bundling. " +
          "Please set POSTGRES_URL environment variable for external database, " +
          "or run `elizaos start` separately.";
      } else {
        initError = message;
      }

      throw new Error(initError);
    }
  })();

  return initPromise;
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    action?: string;
    message?: string;
    userId?: string;
  };

  // Handle initialization request
  if (body.action === "init") {
    try {
      await getRuntime();
      return Response.json({
        success: true,
        mode: "elizaos",
        message: "elizaOS runtime initialized",
      });
    } catch (_error) {
      return Response.json({
        success: false,
        mode: "error",
        message: initError || "Failed to initialize runtime",
      });
    }
  }

  // Handle chat message
  const { message, userId: clientUserId } = body;

  if (!message || typeof message !== "string") {
    return Response.json({ error: "Message is required" }, { status: 400 });
  }

  // Get or initialize runtime
  let rt: IAgentRuntime;
  try {
    rt = await getRuntime();
  } catch {
    return Response.json(
      {
        error: "elizaOS runtime not available",
        details: initError,
        suggestion:
          "Set POSTGRES_URL environment variable or run `elizaos start` separately",
      },
      { status: 503 },
    );
  }

  const userId = (clientUserId || uuidv4()) as UUID;

  // Create streaming response
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Ensure connection for this user
        await rt.ensureConnection({
          entityId: userId,
          roomId,
          worldId,
          userName: "User",
          source: "next",
          channelId: "chat",
          serverId: "server",
          type: ChannelType.DM,
        } as Parameters<typeof rt.ensureConnection>[0]);

        // Create message memory using canonical helper
        const messageMemory = createMessageMemory({
          id: uuidv4() as UUID,
          entityId: userId,
          roomId,
          content: {
            text: message,
            source: "next_app",
            channelType: ChannelType.DM,
          },
        });

        // Process through the FULL elizaOS pipeline
        await rt.messageService?.handleMessage(
          rt,
          messageMemory,
          async (content) => {
            if (content?.text) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ text: content.text })}\n\n`,
                ),
              );
            }
            return [];
          },
        );

        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`),
        );
        controller.close();
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ error: errorMessage })}\n\n`,
          ),
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// Health check
export async function GET() {
  try {
    const rt = await getRuntime();
    return Response.json({
      status: "ready",
      mode: "elizaos",
      character: rt.character.name,
      messageServiceAvailable: !!rt.messageService,
    });
  } catch {
    return Response.json({
      status: "error",
      mode: "unavailable",
      character: character.name,
      error: initError,
    });
  }
}
