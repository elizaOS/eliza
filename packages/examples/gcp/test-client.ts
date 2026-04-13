/**
 * elizaOS GCP Cloud Run Test Client
 *
 * Interactive CLI client for testing the Cloud Run worker.
 *
 * Usage:
 *   bun run test-client.ts              # Chat with local dev server
 *   bun run test-client.ts --url <url>  # Custom URL
 *
 * Examples:
 *   bun run test-client.ts
 *   bun run test-client.ts --url https://eliza-worker-abc123.run.app
 */

import * as readline from "node:readline";

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

// Parse command line arguments
function parseArgs(): { url: string } {
  const args = process.argv.slice(2);
  let url = "http://localhost:8080";

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--url" || args[i] === "-u") && args[i + 1]) {
      url = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
elizaOS GCP Cloud Run Test Client

Usage:
  bun run test-client.ts [options]

Options:
  --url, -u <url>   Worker URL (default: http://localhost:8080)
  --help, -h        Show this help message

Examples:
  # Local development (default port 8080)
  bun run test-client.ts

  # Connect to deployed Cloud Run service
  bun run test-client.ts --url https://eliza-worker-abc123.run.app

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

  return { url };
}

async function getWorkerInfo(baseUrl: string): Promise<InfoResponse | null> {
  const response = await fetch(baseUrl, {
    signal: AbortSignal.timeout(5000),
  });
  if (response.ok) {
    return (await response.json()) as InfoResponse;
  }
  return null;
}

async function getHealthStatus(
  baseUrl: string,
): Promise<HealthResponse | null> {
  const response = await fetch(`${baseUrl}/health`, {
    signal: AbortSignal.timeout(5000),
  });
  if (response.ok) {
    return (await response.json()) as HealthResponse;
  }
  return null;
}

async function sendMessage(
  baseUrl: string,
  message: string,
  conversationId: string | null,
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

async function main(): Promise<void> {
  const { url } = parseArgs();

  console.log("\n🚀 elizaOS GCP Cloud Run Test Client\n");
  console.log(`📡 Connecting to: ${url}\n`);

  // Check health status
  const health = await getHealthStatus(url);
  if (health) {
    console.log(
      `✅ Health: ${health.status} (${health.runtime} v${health.version})`,
    );
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
    console.error(
      "    gcloud run deploy eliza-worker --source . --region us-central1",
    );
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

      console.log("\n⏳ Thinking...");

      const response = await sendMessage(url, text, conversationId);
      conversationId = response.conversationId;

      // Clear the "Thinking..." line
      process.stdout.write("\x1b[1A\x1b[2K");

      console.log(`${info.name}: ${response.response}\n`);

      prompt();
    });
  };

  prompt();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
