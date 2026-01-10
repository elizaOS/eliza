/**
 * elizaOS Cloudflare Worker
 *
 * A serverless AI agent running on Cloudflare Workers.
 * Provides a REST API for chat interactions with an AI character.
 */

export interface Env {
  OPENAI_API_KEY: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;
  CHARACTER_NAME?: string;
  CHARACTER_BIO?: string;
  CHARACTER_SYSTEM?: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatRequest {
  message: string;
  conversationId?: string;
}

interface ChatResponse {
  response: string;
  conversationId: string;
  character: string;
}

interface ConversationState {
  messages: ChatMessage[];
  createdAt: number;
}

// In-memory conversation store (persists during worker lifetime)
// For production, use Cloudflare KV or Durable Objects
const conversations = new Map<string, ConversationState>();

function generateUUID(): string {
  return crypto.randomUUID();
}

function getCharacter(env: Env) {
  return {
    name: env.CHARACTER_NAME || "Eliza",
    bio: env.CHARACTER_BIO || "A helpful AI assistant powered by elizaOS.",
    system:
      env.CHARACTER_SYSTEM ||
      `You are ${env.CHARACTER_NAME || "Eliza"}, a helpful AI assistant. ${env.CHARACTER_BIO || "You are friendly, knowledgeable, and always eager to help."}`,
  };
}

async function callOpenAI(
  messages: ChatMessage[],
  env: Env
): Promise<string> {
  const baseUrl = env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model = env.OPENAI_MODEL || "gpt-5-mini";

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.7,
      max_tokens: 1024,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${error}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices[0]?.message?.content || "";
}

function getOrCreateConversation(conversationId: string | undefined): {
  id: string;
  state: ConversationState;
} {
  const id = conversationId || generateUUID();
  let state = conversations.get(id);

  if (!state) {
    state = {
      messages: [],
      createdAt: Date.now(),
    };
    conversations.set(id, state);
  }

  return { id, state };
}

async function handleChat(
  request: Request,
  env: Env
): Promise<Response> {
  const body = (await request.json()) as ChatRequest;
  const { message, conversationId } = body;

  if (!message || typeof message !== "string") {
    return Response.json(
      { error: "Message is required and must be a string" },
      { status: 400 }
    );
  }

  const character = getCharacter(env);
  const { id, state } = getOrCreateConversation(conversationId);

  // Add system message if this is a new conversation
  if (state.messages.length === 0) {
    state.messages.push({
      role: "system",
      content: character.system,
    });
  }

  // Add user message
  state.messages.push({
    role: "user",
    content: message,
  });

  // Get AI response
  const responseText = await callOpenAI(state.messages, env);

  // Add assistant response to conversation
  state.messages.push({
    role: "assistant",
    content: responseText,
  });

  // Prune old conversations (keep last 100)
  if (conversations.size > 100) {
    const sortedConvos = [...conversations.entries()].sort(
      (a, b) => a[1].createdAt - b[1].createdAt
    );
    for (let i = 0; i < sortedConvos.length - 100; i++) {
      conversations.delete(sortedConvos[i][0]);
    }
  }

  const response: ChatResponse = {
    response: responseText,
    conversationId: id,
    character: character.name,
  };

  return Response.json(response);
}

async function handleStreamChat(
  request: Request,
  env: Env
): Promise<Response> {
  const body = (await request.json()) as ChatRequest;
  const { message, conversationId } = body;

  if (!message || typeof message !== "string") {
    return Response.json(
      { error: "Message is required and must be a string" },
      { status: 400 }
    );
  }

  const character = getCharacter(env);
  const { id, state } = getOrCreateConversation(conversationId);

  if (state.messages.length === 0) {
    state.messages.push({
      role: "system",
      content: character.system,
    });
  }

  state.messages.push({
    role: "user",
    content: message,
  });

  const baseUrl = env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model = env.OPENAI_MODEL || "gpt-5-mini";

  const openaiResponse = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: state.messages,
      temperature: 0.7,
      max_tokens: 1024,
      stream: true,
    }),
  });

  if (!openaiResponse.ok) {
    const error = await openaiResponse.text();
    throw new Error(`OpenAI API error: ${openaiResponse.status} - ${error}`);
  }

  const encoder = new TextEncoder();
  let fullResponse = "";

  const stream = new ReadableStream({
    async start(controller) {
      const reader = openaiResponse.body?.getReader();
      if (!reader) {
        controller.close();
        return;
      }

      const decoder = new TextDecoder();

      // Send initial metadata
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ conversationId: id, character: character.name })}\n\n`
        )
      );

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6);
              if (data === "[DONE]") {
                continue;
              }

              try {
                const parsed = JSON.parse(data) as {
                  choices: Array<{ delta: { content?: string } }>;
                };
                const content = parsed.choices[0]?.delta?.content;
                if (content) {
                  fullResponse += content;
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify({ text: content })}\n\n`)
                  );
                }
              } catch {
                // Skip malformed JSON
              }
            }
          }
        }

        // Store the complete response
        state.messages.push({
          role: "assistant",
          content: fullResponse,
        });

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } finally {
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
    activeConversations: conversations.size,
    timestamp: new Date().toISOString(),
  });
}

function handleInfo(env: Env): Response {
  const character = getCharacter(env);
  return Response.json({
    name: character.name,
    bio: character.bio,
    version: "1.0.0",
    powered_by: "elizaOS",
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

    try {
      // Validate API key is configured
      if (!env.OPENAI_API_KEY) {
        return Response.json(
          { error: "OPENAI_API_KEY is not configured" },
          { status: 500 }
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
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Worker error:", message);
      return Response.json({ error: message }, { status: 500 });
    }
  },
};

