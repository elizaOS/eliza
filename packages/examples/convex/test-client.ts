/**
 * Interactive CLI test client for the elizaOS Convex agent.
 *
 * Usage:
 *   CONVEX_URL=https://your-deployment.convex.cloud bun run test-client.ts
 *
 * The CONVEX_URL is the HTTP Actions URL printed by `npx convex dev`.
 */

import "dotenv/config";
import * as readline from "node:readline";

// ============================================================================
// Configuration
// ============================================================================

const CONVEX_URL = process.env.CONVEX_URL;

if (!CONVEX_URL) {
  console.error(
    "Error: CONVEX_URL is not set.\n" +
      "Run `npx convex dev` and copy the HTTP Actions URL, then:\n" +
      '  CONVEX_URL="https://your-deployment.convex.cloud" bun run test-client.ts\n',
  );
  process.exit(1);
}

const CHAT_ENDPOINT = `${CONVEX_URL.replace(/\/$/, "")}/chat`;
const HEALTH_ENDPOINT = `${CONVEX_URL.replace(/\/$/, "")}/health`;

// ============================================================================
// Helpers
// ============================================================================

interface ChatResponse {
  response: string;
  conversationId: string;
  agentName: string;
  provider: string;
  timestamp: string;
}

interface HealthResponse {
  status: string;
  runtime: string;
  version: string;
}

async function checkHealth(): Promise<HealthResponse> {
  const res = await fetch(HEALTH_ENDPOINT);
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  return (await res.json()) as HealthResponse;
}

async function sendMessage(
  message: string,
  conversationId: string,
): Promise<ChatResponse> {
  const res = await fetch(CHAT_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, conversationId }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Chat request failed (${res.status}): ${text}`);
  }

  return (await res.json()) as ChatResponse;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("elizaOS Convex Agent — Test Client\n");

  // Health check
  try {
    const health = await checkHealth();
    console.log(
      `Health: ${health.status} | Runtime: ${health.runtime} | Version: ${health.version}\n`,
    );
  } catch (err) {
    console.warn(
      `Warning: health check failed (${err instanceof Error ? err.message : err})\n`,
    );
  }

  const conversationId = crypto.randomUUID();
  console.log(`Conversation: ${conversationId}`);
  console.log('Type "exit" to quit.\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question("You: ", async (input) => {
      const text = input.trim();

      if (text.toLowerCase() === "exit") {
        console.log("\nGoodbye!");
        rl.close();
        process.exit(0);
      }

      if (!text) {
        prompt();
        return;
      }

      try {
        const result = await sendMessage(text, conversationId);
        console.log(`\n${result.agentName}: ${result.response}\n`);
      } catch (err) {
        console.error(
          `\nError: ${err instanceof Error ? err.message : err}\n`,
        );
      }

      prompt();
    });
  };

  prompt();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
