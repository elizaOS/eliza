/**
 * elizaOS Cloudflare Worker Test Client
 *
 * Interactive CLI client for testing the Cloudflare Worker.
 * Supports both regular and streaming chat modes.
 *
 * Usage:
 *   bun run test-client.ts              # Regular chat
 *   bun run test-client.ts --stream     # Streaming chat
 *   bun run test-client.ts --url <url>  # Custom URL
 */

import * as readline from "readline";

interface ChatResponse {
  response: string;
  conversationId: string;
  character: string;
}

interface InfoResponse {
  name: string;
  bio: string;
  version: string;
  endpoints: Record<string, string>;
}

interface StreamEvent {
  text?: string;
  conversationId?: string;
  character?: string;
}

// Parse command line arguments
function parseArgs(): { url: string; stream: boolean } {
  const args = process.argv.slice(2);
  let url = "http://localhost:8787";
  let stream = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stream" || args[i] === "-s") {
      stream = true;
    } else if ((args[i] === "--url" || args[i] === "-u") && args[i + 1]) {
      url = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
elizaOS Cloudflare Worker Test Client

Usage:
  bun run test-client.ts [options]

Options:
  --stream, -s      Use streaming mode
  --url, -u <url>   Worker URL (default: http://localhost:8787)
  --help, -h        Show this help message

Examples:
  bun run test-client.ts                              # Local development
  bun run test-client.ts --stream                     # Streaming mode
  bun run test-client.ts --url https://your-worker.workers.dev
`);
      process.exit(0);
    }
  }

  return { url, stream };
}

async function getWorkerInfo(baseUrl: string): Promise<InfoResponse | null> {
  try {
    const response = await fetch(baseUrl);
    if (response.ok) {
      return (await response.json()) as InfoResponse;
    }
  } catch {
    // Worker not available
  }
  return null;
}

async function sendMessage(
  baseUrl: string,
  message: string,
  conversationId: string | null
): Promise<ChatResponse> {
  const response = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      conversationId,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error: ${response.status} - ${error}`);
  }

  return (await response.json()) as ChatResponse;
}

async function sendStreamMessage(
  baseUrl: string,
  message: string,
  conversationId: string | null,
  onChunk: (text: string) => void
): Promise<{ conversationId: string; character: string }> {
  const response = await fetch(`${baseUrl}/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      conversationId,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error: ${response.status} - ${error}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const decoder = new TextDecoder();
  let metadata = { conversationId: "", character: "" };

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
          const event = JSON.parse(data) as StreamEvent;
          if (event.conversationId) {
            metadata.conversationId = event.conversationId;
          }
          if (event.character) {
            metadata.character = event.character;
          }
          if (event.text) {
            onChunk(event.text);
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }
  }

  return metadata;
}

async function main(): Promise<void> {
  const { url, stream } = parseArgs();

  console.log("\n🚀 elizaOS Cloudflare Worker Test Client\n");
  console.log(`📡 Connecting to: ${url}`);
  console.log(`📨 Mode: ${stream ? "Streaming" : "Regular"}\n`);

  // Check if worker is available
  const info = await getWorkerInfo(url);
  if (!info) {
    console.error("❌ Could not connect to worker at", url);
    console.error("\nMake sure the worker is running:");
    console.error("  cd examples/cloudflare");
    console.error("  bun install");
    console.error("  bun run dev\n");
    process.exit(1);
  }

  console.log(`🤖 Character: ${info.name}`);
  console.log(`📖 Bio: ${info.bio}\n`);
  console.log('💬 Chat with the agent (type "exit" to quit)\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let conversationId: string | null = null;

  const prompt = (): void => {
    rl.question("You: ", async (input) => {
      const text = input.trim();

      if (text.toLowerCase() === "exit" || text.toLowerCase() === "quit") {
        console.log("\n👋 Goodbye!\n");
        rl.close();
        process.exit(0);
      }

      if (!text) {
        prompt();
        return;
      }

      try {
        if (stream) {
          process.stdout.write(`${info.name}: `);

          const metadata = await sendStreamMessage(
            url,
            text,
            conversationId,
            (chunk) => {
              process.stdout.write(chunk);
            }
          );

          conversationId = metadata.conversationId;
          console.log("\n");
        } else {
          const response = await sendMessage(url, text, conversationId);
          conversationId = response.conversationId;
          console.log(`\n${response.character}: ${response.response}\n`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error(`\n❌ Error: ${message}\n`);
      }

      prompt();
    });
  };

  prompt();
}

main().catch(console.error);





