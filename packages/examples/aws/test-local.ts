#!/usr/bin/env bun

/**
 * Local test script for the AWS Lambda handler using full elizaOS runtime
 * Run with: bun run test-local.ts
 *
 * This uses the same elizaOS runtime as the chat demo.
 */

import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { handler, shutdownRuntime } from "./handler";

// Mock Lambda context
const mockContext: Context = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: "test",
  functionVersion: "$LATEST",
  invokedFunctionArn: "arn:aws:lambda:us-east-1:000000000000:function:test",
  memoryLimitInMB: "512",
  awsRequestId: "test-request-id",
  logGroupName: "/aws/lambda/test",
  logStreamName: "2025/01/10/[$LATEST]test",
  getRemainingTimeInMillis: () => 30000,
  done: () => {},
  fail: () => {},
  succeed: () => {},
};

// Create a mock API Gateway event
function createEvent(
  method: string,
  path: string,
  body?: string,
): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: "",
    headers: {
      "content-type": "application/json",
    },
    requestContext: {
      accountId: "000000000000",
      apiId: "test-api",
      domainName: "localhost",
      domainPrefix: "test",
      http: {
        method,
        path,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "test-client",
      },
      requestId: "test-request",
      routeKey: `${method} ${path}`,
      stage: "test",
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
    body,
    isBase64Encoded: false,
  };
}

// Helper to get statusCode and body from API Gateway result
function getResultData(result: Awaited<ReturnType<typeof handler>>): {
  statusCode: number;
  body: string;
} {
  if (typeof result === "string") {
    return { statusCode: 200, body: result };
  }
  return { statusCode: result.statusCode ?? 200, body: result.body ?? "" };
}

async function runTests(): Promise<void> {
  console.log("🧪 Testing elizaOS AWS Lambda Handler (Full Runtime)\n");

  // Test 1: Health check
  console.log("1️⃣  Testing health check...");
  const healthEvent = createEvent("GET", "/health");
  const healthResult = getResultData(await handler(healthEvent, mockContext));
  console.log(`   Status: ${healthResult.statusCode}`);
  console.log(`   Body: ${healthResult.body}\n`);

  if (healthResult.statusCode !== 200) {
    throw new Error("Health check failed");
  }
  console.log("   ✅ Health check passed\n");

  // Test 2: Chat message (requires a configured model provider)
  if (process.env.OPENAI_API_KEY) {
    console.log("2️⃣  Testing chat endpoint with elizaOS runtime...");
    const chatEvent = createEvent(
      "POST",
      "/chat",
      JSON.stringify({ message: "Hello! What's 2 + 2?" }),
    );

    const startTime = Date.now();
    const chatResult = getResultData(await handler(chatEvent, mockContext));
    const duration = Date.now() - startTime;

    console.log(`   Status: ${chatResult.statusCode}`);
    console.log(`   Duration: ${duration}ms`);

    if (chatResult.statusCode !== 200) {
      throw new Error(`Chat failed: ${chatResult.body}`);
    }

    const response = JSON.parse(chatResult.body);
    console.log(`   Response: ${response.response.substring(0, 100)}...`);
    console.log(`   Conversation ID: ${response.conversationId}\n`);
    console.log("   ✅ Chat endpoint passed (elizaOS runtime working!)\n");
  } else {
    console.log("2️⃣  Skipping live chat endpoint (OPENAI_API_KEY not set)\n");
  }

  // Test 3: Invalid request
  console.log("3️⃣  Testing validation (empty message)...");
  const invalidEvent = createEvent(
    "POST",
    "/chat",
    JSON.stringify({ message: "" }),
  );
  const invalidResult = getResultData(await handler(invalidEvent, mockContext));
  console.log(`   Status: ${invalidResult.statusCode}`);

  if (invalidResult.statusCode !== 400) {
    throw new Error("Validation test failed - expected 400");
  }
  console.log("   ✅ Validation passed\n");

  // Test 4: 404 for unknown path
  console.log("4️⃣  Testing 404 response...");
  const notFoundEvent = createEvent("GET", "/unknown");
  const notFoundResult = getResultData(
    await handler(notFoundEvent, mockContext),
  );
  console.log(`   Status: ${notFoundResult.statusCode}`);

  if (notFoundResult.statusCode !== 404) {
    throw new Error("404 test failed");
  }
  console.log("   ✅ 404 handling passed\n");

  console.log("🎉 All tests passed with elizaOS runtime!");
}

runTests()
  .then(async () => {
    await shutdownRuntime();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("Fatal error:", error);
    await shutdownRuntime();
    process.exit(1);
  });
