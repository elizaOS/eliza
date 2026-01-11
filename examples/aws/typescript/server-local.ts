#!/usr/bin/env bun

/**
 * Local HTTP server for testing the Lambda handler
 * Run with: bun run server-local.ts
 *
 * This creates a local HTTP server that mimics API Gateway,
 * allowing you to test the Lambda handler locally.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { handler } from "./handler";

// Load .env from root if not already set
function loadEnv(): void {
  const envPaths = [
    resolve(import.meta.dir, "../../../.env"), // Root .env
    resolve(import.meta.dir, "../.env"), // aws/.env
    resolve(import.meta.dir, ".env"), // typescript/.env
  ];

  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          const [key, ...valueParts] = trimmed.split("=");
          const value = valueParts.join("=");
          if (key && value && !process.env[key]) {
            process.env[key] = value;
          }
        }
      }
      console.log(`📁 Loaded .env from ${envPath}`);
      break;
    }
  }
}

loadEnv();

const PORT = parseInt(process.env.PORT ?? "3000", 10);

// Check for OpenAI API key
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY environment variable is required");
  console.error("   Set it with: export OPENAI_API_KEY='your-key-here'");
  console.error("   Or create a .env file in the project root");
  process.exit(1);
}

// Mock Lambda context
const mockContext: Context = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: "eliza-worker-local",
  functionVersion: "$LATEST",
  invokedFunctionArn: "arn:aws:lambda:local:000000000000:function:eliza-worker",
  memoryLimitInMB: "512",
  awsRequestId: "local-request",
  logGroupName: "/aws/lambda/eliza-worker",
  logStreamName: "local",
  getRemainingTimeInMillis: () => 30000,
  done: () => {},
  fail: () => {},
  succeed: () => {},
};

/**
 * Convert Bun Request to API Gateway event
 */
async function requestToEvent(
  request: Request,
): Promise<APIGatewayProxyEventV2> {
  const url = new URL(request.url);
  const body = request.method !== "GET" ? await request.text() : undefined;

  return {
    version: "2.0",
    routeKey: `${request.method} ${url.pathname}`,
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers: Object.fromEntries(request.headers.entries()),
    requestContext: {
      accountId: "000000000000",
      apiId: "local",
      domainName: "localhost",
      domainPrefix: "local",
      http: {
        method: request.method,
        path: url.pathname,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: request.headers.get("user-agent") ?? "local-client",
      },
      requestId: `req-${Date.now()}`,
      routeKey: `${request.method} ${url.pathname}`,
      stage: "local",
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
    body,
    isBase64Encoded: false,
  };
}

console.log(`
🚀 elizaOS AWS Lambda Local Server

📡 Server: http://localhost:${PORT}
📋 Endpoints:
   GET  /health  - Health check
   POST /chat    - Send a message

💡 Example:
   curl -X POST http://localhost:${PORT}/chat \\
     -H "Content-Type: application/json" \\
     -d '{"message": "Hello, Eliza!"}'

Press Ctrl+C to stop
`);

const server = Bun.serve({
  port: PORT,
  async fetch(request: Request): Promise<Response> {
    const event = await requestToEvent(request);
    const result = await handler(event, mockContext);

    if (typeof result === "string") {
      return new Response(result, { status: 200 });
    }

    return new Response(result.body, {
      status: result.statusCode,
      headers: result.headers as Record<string, string>,
    });
  },
});

console.log(`✅ Server running at http://localhost:${server.port}`);
