import {
  AgentRuntime,
  ChannelType,
  type Character,
  createMessageMemory,
  type IAgentRuntime,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { openaiPlugin } from "@elizaos/plugin-openai";
import { plugin as sqlPlugin } from "@elizaos/plugin-sql";
import { v4 as uuidv4 } from "uuid";
import { generateElizaResponse } from "@/lib/eliza-classic";

// Character configuration (same as chat.ts)
// Pass environment variables via character.secrets so getSetting() can find them
// Note: Without POSTGRES_URL, plugin-sql will use PGLite automatically
const character: Character = {
  name: "Eliza",
  bio: "A helpful AI assistant.",
  secrets: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
  },
};

// Runtime state
let runtime: IAgentRuntime | null = null;
let initPromise: Promise<IAgentRuntime | null> | null = null;
let initError: string | null = null;
let useClassicFallback = false;

// Session info
const roomId = stringToUuid("chat-room");
const worldId = stringToUuid("chat-world");

async function getRuntime(): Promise<IAgentRuntime | null> {
  if (runtime) return runtime;
  if (useClassicFallback) return null;

  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      console.log("🚀 Initializing elizaOS runtime...");

      const newRuntime = new AgentRuntime({
        character,
        plugins: [sqlPlugin, openaiPlugin],
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
        console.log(
          "⚠️ PGLite extensions not compatible with Next.js bundling.",
        );
        console.log("💡 Falling back to classic ELIZA mode.");
        console.log(
          "💡 For full LLM mode, set POSTGRES_URL or run `elizaos start` separately.",
        );
        useClassicFallback = true;
        initError =
          "PGLite extensions not compatible with Next.js. Using classic mode.";
      } else {
        initError = message;
      }
      return null;
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
    const rt = await getRuntime();
    return Response.json({
      success: true,
      mode: rt ? "elizaos" : "classic",
      message: rt
        ? "elizaOS runtime initialized"
        : initError || "Using classic ELIZA mode",
    });
  }

  // Handle chat message
  const { message, userId: clientUserId } = body;

  if (!message || typeof message !== "string") {
    return Response.json({ error: "Message is required" }, { status: 400 });
  }

  const rt = await getRuntime();

  // Create streaming response
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      if (rt) {
        // Use elizaOS runtime
        const userId = (clientUserId || uuidv4()) as UUID;

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

        const messageMemory = createMessageMemory({
          id: uuidv4() as UUID,
          entityId: userId,
          roomId,
          content: { text: message },
        });

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
      } else {
        // Use classic ELIZA fallback
        await new Promise((resolve) =>
          setTimeout(resolve, 300 + Math.random() * 500),
        );
        const response = generateElizaResponse(message);

        // Stream word by word
        const words = response.split(" ");
        for (let i = 0; i < words.length; i++) {
          const word = words[i] + (i < words.length - 1 ? " " : "");
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ text: word })}\n\n`),
          );
          await new Promise((resolve) =>
            setTimeout(resolve, 20 + Math.random() * 40),
          );
        }
      }

      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`),
      );
      controller.close();
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
  const rt = await getRuntime();
  return Response.json({
    status: "ready",
    mode: rt ? "elizaos" : "classic",
    character: character.name,
    error: initError,
  });
}
