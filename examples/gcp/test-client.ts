/**
 * elizaOS GCP Cloud Run Test Client
 *
 * Interactive CLI client for testing the Cloud Run worker.
 * Supports both regular and streaming chat modes.
 *
 * Usage:
 *   bun run test-client.ts              # Regular chat (local dev)
 *   bun run test-client.ts --stream     # Streaming chat
 *   bun run test-client.ts --url <url>  # Custom URL
 *
 * Examples:
 *   bun run test-client.ts
 *   bun run test-client.ts --stream --url https://eliza-worker-abc123.run.app
 */

import * as readline from "readline";

interface ChatResponse {
  response: string;
  conversationId: string;
  timestamp?: string;
}

interface InfoResponse {
  name: string;
  bio: string;
  version: string;
  powered_by: string;
  endpoints: Record<string, string>;
}

interface HealthResponse {
  status: string;
  runtime: string;
  version: string;
}

interface StreamEvent {
  text?: string;
  conversationId?: string;
  character?: string;
  error?: string;
}

// Parse command line arguments
function parseArgs(): { url: string; stream: boolean } {
  const args = process.argv.slice(2);
  let url = "http://localhost:8080";
  let stream = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stream" || args[i] === "-s") {
      stream = true;
    } else if ((args[i] === "--url" || args[i] === "-u") && args[i + 1]) {
      url = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
elizaOS GCP Cloud Run Test Client

Usage:
  bun run test-client.ts [options]

Options:
  --stream, -s      Use streaming mode (SSE)
  --url, -u <url>   Worker URL (default: http://localhost:8080)
  --help, -h        Show this help message

Examples:
  # Local development (default port 8080)
  bun run test-client.ts

  # Streaming mode
  bun run test-client.ts --stream

  # Connect to deployed Cloud Run service
  bun run test-client.ts --url https://eliza-worker-abc123.run.app

  # Streaming with deployed service
  bun run test-client.ts --stream --url https://eliza-worker-abc123.run.app

Environment:
  You can also set the URL via environment variable:
  export ELIZA_WORKER_URL=https://your-service.run.app
  bun run test-client.ts
`);
      process.exit(0);
    }
  }

  // Check environment variable as fallback
  if (url === "http://localhost:8080" && process.env.ELIZA_WORKER_URL) {
    url = process.env.ELIZA_WORKER_URL;
  }

  return { url, stream };
}

async function getWorkerInfo(baseUrl: string): Promise<InfoResponse | null> {
  try {
    const response = await fetch(baseUrl, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      return (await response.json()) as InfoResponse;
    }
  } catch (err) {
    // Worker not available
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`\n⚠️  Connection failed: ${message}`);
  }
  return null;
}

async function getHealthStatus(baseUrl: string): Promise<HealthResponse | null> {
  try {
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      return (await response.json()) as HealthResponse;
    }
  } catch {
    // Health check failed
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

          // Handle errors
          if (event.error) {
            throw new Error(event.error);
          }

          // Capture metadata
          if (event.conversationId) {
            metadata.conversationId = event.conversationId;
          }
          if (event.character) {
            metadata.character = event.character;
          }

          // Stream text chunks
          if (event.text) {
            onChunk(event.text);
          }
        } catch (e) {
          if (e instanceof SyntaxError) {
            // Skip malformed JSON
            continue;
          }
          throw e;
        }
      }
    }
  }

  return metadata;
}

async function main(): Promise<void> {
  const { url, stream } = parseArgs();

  console.log("\n🚀 elizaOS GCP Cloud Run Test Client\n");
  console.log(`📡 Connecting to: ${url}`);
  console.log(`📨 Mode: ${stream ? "Streaming (SSE)" : "Regular"}\n`);

  // Check health status
  const health = await getHealthStatus(url);
  if (health) {
    console.log(`✅ Health: ${health.status} (${health.runtime} v${health.version})`);
  }

  // Check if worker is available
  const info = await getWorkerInfo(url);
  if (!info) {
    console.error("❌ Could not connect to worker at", url);
    console.error("\nMake sure the worker is running:");
    console.error("\n  TypeScript (local):");
    console.error("    cd examples/gcp/typescript");
    console.error("    npm install && npm run dev");
    console.error("\n  Python (local):");
    console.error("    cd examples/gcp/python");
    console.error("    pip install -r requirements.txt");
    console.error("    python handler.py");
    console.error("\n  Rust (local):");
    console.error("    cd examples/gcp/rust");
    console.error("    cargo run");
    console.error("\n  Or deploy to Cloud Run:");
    console.error("    gcloud run deploy eliza-worker --source . --region us-central1");
    console.error("");
    process.exit(1);
  }

  console.log(`\n🤖 Character: ${info.name}`);
  console.log(`📖 Bio: ${info.bio}`);
  console.log(`⚡ Powered by: ${info.powered_by}`);
  console.log('\n💬 Chat with the agent (type "exit" or "quit" to leave)\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let conversationId: string | null = null;

  const prompt = (): void => {
    rl.question("You: ", async (input) => {
      const text = input.trim();

      if (
        text.toLowerCase() === "exit" ||
        text.toLowerCase() === "quit" ||
        text.toLowerCase() === "q"
      ) {
        console.log("\n👋 Goodbye!\n");
        rl.close();
        process.exit(0);
      }

      if (text.toLowerCase() === "clear") {
        conversationId = null;
        console.log("\n🔄 Conversation cleared. Starting fresh.\n");
        prompt();
        return;
      }

      if (text.toLowerCase() === "help") {
        console.log(`
Commands:
  exit, quit, q  - Exit the client
  clear          - Clear conversation history
  help           - Show this help message
`);
        prompt();
        return;
      }

      if (!text) {
        prompt();
        return;
      }

      try {
        if (stream) {
          process.stdout.write(`\n${info.name}: `);

          const metadata = await sendStreamMessage(
            url,
            text,
            conversationId,
            (chunk) => {
              process.stdout.write(chunk);
            }
          );

          conversationId = metadata.conversationId || conversationId;
          console.log("\n");
        } else {
          console.log("\n⏳ Thinking...");

          const response = await sendMessage(url, text, conversationId);
          conversationId = response.conversationId;

          // Clear the "Thinking..." line
          process.stdout.write("\x1b[1A\x1b[2K");

          console.log(`${info.name}: ${response.response}\n`);
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

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

