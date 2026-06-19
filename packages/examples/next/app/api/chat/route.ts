/**
 * elizaOS Next.js API Route
 *
 * Uses the canonical elizaOS runtime with messageService.handleMessage pattern.
 *
 * NOTE: If PGLite bundling fails with Next.js, set POSTGRES_URL for external database,
 * or connect to a running generated elizaOS project API.
 *
 * Heavy `@elizaos/*` imports are dynamic so `next build` does not execute native/GPU
 * dependency graphs during route-module evaluation.
 */

import type { Character, IAgentRuntime, UUID } from "@elizaos/core";

import { v4 as uuidv4 } from "uuid";

// Runtime state (singleton for the Next.js server)
let runtime: IAgentRuntime | null = null;
let initPromise: Promise<IAgentRuntime> | null = null;
let initError: string | null = null;

let characterCache: Character | null = null;
let roomIdCache: UUID | null = null;
let worldIdCache: UUID | null = null;

function skipRuntimeDuringNextBuild(): boolean {
  return process.env.NEXT_BUILD_SKIP_RUNTIME === "1";
}

async function getCharacter(): Promise<Character> {
  if (characterCache) {
    return characterCache;
  }
  const { createCharacter } = await import("@elizaos/core");
  characterCache = createCharacter({
    name: "Eliza",
    bio: "A helpful AI assistant powered by elizaOS.",
    system:
      "You are Eliza, a helpful AI assistant. Be friendly, knowledgeable, and conversational.",
    secrets: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
      POSTGRES_URL: process.env.POSTGRES_URL || "",
    },
  });
  return characterCache;
}

async function getRoomWorldIds(): Promise<{ roomId: UUID; worldId: UUID }> {
  if (roomIdCache && worldIdCache) {
    return { roomId: roomIdCache, worldId: worldIdCache };
  }
  const { stringToUuid } = await import("@elizaos/core");
  roomIdCache = stringToUuid("chat-room");
  worldIdCache = stringToUuid("chat-world");
  return { roomId: roomIdCache, worldId: worldIdCache };
}

async function getRuntime(): Promise<IAgentRuntime> {
  if (runtime) {
    return runtime;
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    try {
      console.log("🚀 Initializing elizaOS runtime...");

      const [
        { AgentRuntime },
        { openaiPlugin },
        { plugin: sqlPlugin },
        character,
      ] = await Promise.all([
        import("@elizaos/core"),
        import("@elizaos/plugin-openai"),
        import("@elizaos/plugin-sql"),
        getCharacter(),
      ]);

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

      if (
        message.includes("Extension bundle not found") ||
        message.includes("migrations")
      ) {
        initError =
          "PGLite extensions not compatible with Next.js bundling. " +
          "Please set POSTGRES_URL environment variable for external database, " +
          "or connect to a running generated elizaOS project API.";
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

  const { message, userId: clientUserId } = body;

  if (!message || typeof message !== "string") {
    return Response.json({ error: "Message is required" }, { status: 400 });
  }

  let rt: IAgentRuntime;
  try {
    rt = await getRuntime();
  } catch {
    return Response.json(
      {
        error: "elizaOS runtime not available",
        details: initError,
        suggestion:
          "Set POSTGRES_URL environment variable or connect to a running generated elizaOS project API",
      },
      { status: 503 },
    );
  }

  const { ChannelType, createMessageMemory } = await import("@elizaos/core");
  const { roomId, worldId } = await getRoomWorldIds();

  const userId = (clientUserId || uuidv4()) as UUID;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
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
          content: {
            text: message,
            source: "next_app",
            channelType: ChannelType.DM,
          },
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

export async function GET() {
  if (skipRuntimeDuringNextBuild()) {
    return Response.json({
      status: "build_skipped",
      mode: "elizaos",
      character: "Eliza",
      messageServiceAvailable: false,
    });
  }
  try {
    const rt = await getRuntime();
    return Response.json({
      status: "ready",
      mode: "elizaos",
      character: rt.character.name,
      messageServiceAvailable: !!rt.messageService,
    });
  } catch {
    const character = await getCharacter().catch(() => null);
    return Response.json({
      status: "error",
      mode: "unavailable",
      character: character?.name ?? "Eliza",
      error: initError,
    });
  }
}
