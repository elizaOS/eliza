/**
 * elizaOS Cloudflare Worker
 *
 * A serverless AI agent running on Cloudflare Workers.
 * Uses the canonical elizaOS runtime with messageService.handleMessage pattern.
 *
 * NOTE: Due to Cloudflare Workers constraints (no persistent storage for PGLite),
 * this example initializes the runtime per-request. For production use,
 * consider using Cloudflare Durable Objects for state persistence.
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
import { v4 as uuidv4 } from "uuid";

export interface Env {
  OPENAI_API_KEY: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;
  CHARACTER_NAME?: string;
  CHARACTER_BIO?: string;
  CHARACTER_SYSTEM?: string;
}

interface ChatRequest {
  message: string;
  userId?: string;
}

interface ChatResponse {
  response: string;
  character: string;
  userId: string;
}

// Session info (consistent UUIDs for the worker)
const roomId = stringToUuid("cloudflare-room");
const worldId = stringToUuid("cloudflare-world");

function getCharacter(env: Env): Character {
  return createCharacter({
    name: env.CHARACTER_NAME || "Eliza",
    bio:
      env.CHARACTER_BIO ||
      "A helpful AI assistant powered by elizaOS on Cloudflare Workers.",
    system:
      env.CHARACTER_SYSTEM ||
      `You are ${env.CHARACTER_NAME || "Eliza"}, a helpful AI assistant. ${env.CHARACTER_BIO || "You are friendly, knowledgeable, and always eager to help."}`,
    secrets: {
      OPENAI_API_KEY: env.OPENAI_API_KEY,
      OPENAI_BASE_URL: env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      OPENAI_MODEL: env.OPENAI_MODEL || "gpt-4o-mini",
    },
  });
}

async function createRuntime(env: Env): Promise<IAgentRuntime> {
  const character = getCharacter(env);

  // Create runtime with OpenAI plugin
  // Note: In Cloudflare Workers, we can't use persistent storage like PGLite
  // The runtime is stateless per-request
  const runtime = new AgentRuntime({
    character,
    plugins: [openaiPlugin as Plugin],
  });

  await runtime.initialize();
  return runtime;
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as ChatRequest;
  const { message, userId: clientUserId } = body;

  if (!message || typeof message !== "string") {
    return Response.json(
      { error: "Message is required and must be a string" },
      { status: 400 },
    );
  }

  try {
    const runtime = await createRuntime(env);
    const userId = (clientUserId || uuidv4()) as UUID;
    const character = getCharacter(env);

    // Ensure connection for this user
    await runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      userName: "User",
      source: "cloudflare",
      channelId: "worker-chat",
      serverId: "cloudflare-worker",
      type: ChannelType.API,
    } as Parameters<typeof runtime.ensureConnection>[0]);

    // Create message memory
    const messageMemory = createMessageMemory({
      id: uuidv4() as UUID,
      entityId: userId,
      roomId,
      content: {
        text: message,
        source: "cloudflare_worker",
        channelType: ChannelType.API,
      },
    });

    // Process message through the runtime's message service
    let responseText = "";
    await runtime.messageService?.handleMessage(
      runtime,
      messageMemory,
      async (content) => {
        if (content?.text) {
          responseText += content.text;
        }
        return [];
      },
    );

    const response: ChatResponse = {
      response: responseText,
      character: character.name,
      userId,
    };

    return Response.json(response);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("Chat error:", errorMessage);
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}

async function handleStreamChat(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as ChatRequest;
  const { message, userId: clientUserId } = body;

  if (!message || typeof message !== "string") {
    return Response.json(
      { error: "Message is required and must be a string" },
      { status: 400 },
    );
  }

  const character = getCharacter(env);
  const userId = (clientUserId || uuidv4()) as UUID;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const runtime = await createRuntime(env);

        await runtime.ensureConnection({
          entityId: userId,
          roomId,
          worldId,
          userName: "User",
          source: "cloudflare",
          channelId: "worker-chat",
          serverId: "cloudflare-worker",
          type: ChannelType.API,
        } as Parameters<typeof runtime.ensureConnection>[0]);

        const messageMemory = createMessageMemory({
          id: uuidv4() as UUID,
          entityId: userId,
          roomId,
          content: {
            text: message,
            source: "cloudflare_worker",
            channelType: ChannelType.API,
          },
        });

        // Send initial metadata
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ character: character.name, userId })}\n\n`,
          ),
        );

        await runtime.messageService?.handleMessage(
          runtime,
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
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function handleHealth(env: Env): Response {
  const character = getCharacter(env);
  return Response.json({
    status: "healthy",
    character: character.name,
    mode: "elizaos",
    timestamp: new Date().toISOString(),
  });
}

function handleInfo(env: Env): Response {
  const character = getCharacter(env);
  return Response.json({
    name: character.name,
    bio: character.bio,
    version: "2.0.0",
    powered_by: "elizaOS",
    runtime: "Cloudflare Workers",
    endpoints: {
      "POST /chat": "Send a message and receive a response",
      "POST /chat/stream": "Send a message and receive a streaming response",
      "GET /health": "Health check endpoint",
      "GET /": "This info endpoint",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Validate API key is configured
    if (!env.OPENAI_API_KEY) {
      return Response.json(
        { error: "OPENAI_API_KEY is not configured" },
        { status: 500 },
      );
    }

    // Route handling
    if (path === "/" && request.method === "GET") {
      return handleInfo(env);
    }

    if (path === "/health" && request.method === "GET") {
      return handleHealth(env);
    }

    if (path === "/chat" && request.method === "POST") {
      return await handleChat(request, env);
    }

    if (path === "/chat/stream" && request.method === "POST") {
      return await handleStreamChat(request, env);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
};
