#!/usr/bin/env -S deno run --allow-net --allow-env

/**
 * Test client for elizaOS Supabase Edge Functions
 *
 * Usage:
 *   # Test local function
 *   deno run --allow-net --allow-env test-client.ts
 *
 *   # Test deployed function
 *   deno run --allow-net --allow-env test-client.ts --endpoint https://your-project.supabase.co/functions/v1/eliza-chat
 *
 *   # Interactive mode
 *   deno run --allow-net --allow-env test-client.ts --interactive
 */

// ============================================================================
// Configuration
// ============================================================================

interface Config {
  endpoint: string;
  authToken: string;
  interactive: boolean;
}

function parseArgs(): Config {
  const args = Deno.args;

  let endpoint =
    Deno.env.get("SUPABASE_FUNCTION_URL") ??
    "http://localhost:54321/functions/v1/eliza-chat";
  let authToken = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  let interactive = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--endpoint" && args[i + 1]) {
      endpoint = args[i + 1];
      i++;
    } else if (args[i] === "--token" && args[i + 1]) {
      authToken = args[i + 1];
      i++;
    } else if (args[i] === "--interactive" || args[i] === "-i") {
      interactive = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      printHelp();
      Deno.exit(0);
    }
  }

  return { endpoint, authToken, interactive };
}

function printHelp(): void {
  console.log(`
elizaOS Supabase Edge Function Test Client

Usage:
  deno run --allow-net --allow-env test-client.ts [options]

Options:
  --endpoint <url>    Function endpoint URL (default: http://localhost:54321/functions/v1/eliza-chat)
  --token <key>       Supabase anon key for authorization
  --interactive, -i   Start interactive chat mode
  --help, -h          Show this help message

Environment Variables:
  SUPABASE_FUNCTION_URL   Default function endpoint
  SUPABASE_ANON_KEY       Default auth token

Examples:
  # Test local function
  deno run --allow-net --allow-env test-client.ts

  # Test deployed function
  deno run --allow-net --allow-env test-client.ts \\
    --endpoint https://your-project.supabase.co/functions/v1/eliza-chat \\
    --token your-anon-key

  # Interactive mode
  deno run --allow-net --allow-env test-client.ts --interactive
`);
}

// ============================================================================
// HTTP Client
// ============================================================================

interface ChatRequest {
  message: string;
  userId?: string;
  conversationId?: string;
}

interface ChatResponse {
  response: string;
  conversationId: string;
  timestamp: string;
}

interface HealthResponse {
  status: string;
  runtime: string;
  version: string;
}

async function sendRequest<T>(
  config: Config,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: T }> {
  const url = `${config.endpoint}${path}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (config.authToken) {
    headers.Authorization = `Bearer ${config.authToken}`;
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = (await response.json()) as T;
  return { status: response.status, data };
}

async function healthCheck(config: Config): Promise<HealthResponse> {
  const { status, data } = await sendRequest<HealthResponse>(
    config,
    "GET",
    "/health",
  );
  if (status !== 200) {
    throw new Error(`Health check failed with status ${status}`);
  }
  return data;
}

interface ErrorResponse {
  error: string;
}

function isErrorResponse(data: unknown): data is ErrorResponse {
  return typeof data === "object" && data !== null && "error" in data;
}

async function sendMessage(
  config: Config,
  request: ChatRequest,
): Promise<ChatResponse> {
  const { status, data } = await sendRequest<ChatResponse | ErrorResponse>(
    config,
    "POST",
    "",
    request,
  );
  if (status !== 200) {
    const errorMsg = isErrorResponse(data) ? data.error : `Request failed with status ${status}`;
    throw new Error(errorMsg);
  }
  return data as ChatResponse;
}

// ============================================================================
// Test Suite
// ============================================================================

async function runTests(config: Config): Promise<void> {
  console.log("🧪 Testing elizaOS Supabase Edge Function\n");
  console.log(`   Endpoint: ${config.endpoint}`);
  console.log(
    `   Auth: ${config.authToken ? "✓ Token provided" : "✗ No token"}\n`,
  );

  let passed = 0;
  let failed = 0;

  // Test 1: Health check
  console.log("1️⃣  Testing health check...");
  try {
    const health = await healthCheck(config);
    console.log(`   Status: ${health.status}`);
    console.log(`   Runtime: ${health.runtime}`);
    console.log(`   Version: ${health.version}`);
    console.log("   ✅ Health check passed\n");
    passed++;
  } catch (error) {
    console.error(`   ❌ Health check failed: ${error}`);
    failed++;
  }

  // Test 2: Chat message
  console.log("2️⃣  Testing chat endpoint...");
  const startTime = Date.now();
  try {
    const response = await sendMessage(config, {
      message: "Hello! What's 2 + 2?",
    });
    const duration = Date.now() - startTime;
    console.log(`   Duration: ${duration}ms`);
    console.log(`   Response: ${response.response.slice(0, 100)}...`);
    console.log(`   Conversation ID: ${response.conversationId}`);
    console.log("   ✅ Chat endpoint passed\n");
    passed++;
  } catch (error) {
    console.error(`   ❌ Chat endpoint failed: ${error}`);
    failed++;
  }

  // Test 3: Validation (empty message)
  console.log("3️⃣  Testing validation (empty message)...");
  try {
    await sendMessage(config, { message: "" });
    console.error("   ❌ Should have rejected empty message");
    failed++;
  } catch (error) {
    if (
      String(error).includes("required") ||
      String(error).includes("non-empty")
    ) {
      console.log(
        "   ✅ Validation passed (correctly rejected empty message)\n",
      );
      passed++;
    } else {
      console.error(`   ❌ Unexpected error: ${error}`);
      failed++;
    }
  }

  // Test 4: Conversation continuity
  console.log("4️⃣  Testing conversation ID tracking...");
  try {
    const response1 = await sendMessage(config, {
      message: "Remember the number 42.",
    });
    const convId = response1.conversationId;

    const response2 = await sendMessage(config, {
      message: "What number did I mention?",
      conversationId: convId,
    });

    console.log(
      `   Conversation ID preserved: ${response2.conversationId === convId}`,
    );
    console.log("   ✅ Conversation tracking passed\n");
    passed++;
  } catch (error) {
    console.error(`   ❌ Conversation tracking failed: ${error}`);
    failed++;
  }

  // Summary
  console.log("─".repeat(50));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log(
      "\n⚠️  Some tests failed. Check your configuration and try again.",
    );
    Deno.exit(1);
  } else {
    console.log("\n🎉 All tests passed!");
  }
}

// ============================================================================
// Interactive Mode
// ============================================================================

async function interactiveMode(config: Config): Promise<void> {
  console.log("🤖 elizaOS Supabase Edge Function - Interactive Mode\n");
  console.log(`   Endpoint: ${config.endpoint}`);
  console.log("   Type 'exit' or 'quit' to end the session.\n");

  let conversationId: string | undefined;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  while (true) {
    // Prompt
    await Deno.stdout.write(encoder.encode("You: "));

    // Read input
    const buf = new Uint8Array(1024);
    const n = await Deno.stdin.read(buf);
    if (n === null) break;

    const input = decoder.decode(buf.subarray(0, n)).trim();

    if (input === "exit" || input === "quit") {
      console.log("\nGoodbye! 👋");
      break;
    }

    if (!input) continue;

    try {
      const response = await sendMessage(config, {
        message: input,
        conversationId,
      });

      conversationId = response.conversationId;
      console.log(`\nEliza: ${response.response}\n`);
    } catch (error) {
      console.error(`\nError: ${error}\n`);
    }
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const config = parseArgs();

  if (config.interactive) {
    await interactiveMode(config);
  } else {
    await runTests(config);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  Deno.exit(1);
});

