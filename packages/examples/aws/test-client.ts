#!/usr/bin/env npx ts-node
/**
 * Interactive test client for elizaOS AWS Lambda worker
 *
 * Usage:
 *   npx ts-node test-client.ts --endpoint https://YOUR_API_ID.execute-api.us-east-1.amazonaws.com/prod/chat
 *   npx ts-node test-client.ts --endpoint http://localhost:3000/chat
 */

import * as readline from "node:readline";

// Parse command line arguments
function parseArgs(): { endpoint: string; conversationId: string | null } {
  const args = process.argv.slice(2);
  let endpoint = "";
  let conversationId: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--endpoint" && args[i + 1]) {
      endpoint = args[i + 1];
      i++;
    } else if (args[i] === "--conversation" && args[i + 1]) {
      conversationId = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
elizaOS AWS Lambda Test Client

Usage:
  npx ts-node test-client.ts --endpoint <url> [options]

Options:
  --endpoint <url>      API endpoint URL (required)
  --conversation <id>   Resume existing conversation
  --help, -h            Show this help message

Examples:
  npx ts-node test-client.ts --endpoint https://abc123.execute-api.us-east-1.amazonaws.com/prod/chat
  npx ts-node test-client.ts --endpoint http://localhost:3000/chat
`);
      process.exit(0);
    }
  }

  if (!endpoint) {
    console.error("Error: --endpoint is required");
    console.error("Run with --help for usage information");
    process.exit(1);
  }

  return { endpoint, conversationId };
}

interface ChatResponse {
  response: string;
  conversationId: string;
  timestamp: string;
}

interface ErrorResponse {
  error: string;
  code: string;
}

async function sendMessage(
  endpoint: string,
  message: string,
  conversationId: string | null,
): Promise<ChatResponse> {
  const body: Record<string, string> = { message };
  if (conversationId) {
    body.conversationId = conversationId;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!response.ok) {
    const error = data as ErrorResponse;
    throw new Error(`API Error (${error.code}): ${error.error}`);
  }

  return data as ChatResponse;
}

async function checkHealth(baseEndpoint: string): Promise<boolean> {
  // Derive health endpoint from chat endpoint
  const healthEndpoint = baseEndpoint.replace(/\/chat\/?$/, "/health");

  const response = await fetch(healthEndpoint, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (response.ok) {
    const data = (await response.json()) as {
      runtime: string;
      version: string;
    };
    console.log(`✅ Connected to ${data.runtime} runtime (v${data.version})\n`);
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  const { endpoint, conversationId: initialConversationId } = parseArgs();
  let conversationId = initialConversationId;

  console.log("\n🤖 elizaOS AWS Lambda Test Client\n");
  console.log(`📡 Endpoint: ${endpoint}\n`);

  // Check health
  await checkHealth(endpoint);

  // Create readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(
    "💬 Chat with Eliza (type 'exit' to quit, 'new' for new conversation)\n",
  );

  const prompt = (): void => {
    rl.question("You: ", async (input) => {
      const text = input.trim();

      if (text.toLowerCase() === "exit" || text.toLowerCase() === "quit") {
        console.log("\n👋 Goodbye!");
        rl.close();
        process.exit(0);
      }

      if (text.toLowerCase() === "new") {
        conversationId = null;
        console.log("\n🔄 Starting new conversation...\n");
        prompt();
        return;
      }

      if (!text) {
        prompt();
        return;
      }

      process.stdout.write("Eliza: ");
      const start = Date.now();
      const response = await sendMessage(endpoint, text, conversationId);
      const duration = Date.now() - start;

      console.log(response.response);
      console.log(
        `\n  [${duration}ms | ${response.conversationId.slice(0, 8)}...]\n`,
      );

      // Track conversation for continuity
      conversationId = response.conversationId;

      prompt();
    });
  };

  prompt();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
