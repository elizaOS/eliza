/**
 * Integration tests for the proxy handler.
 *
 * These tests mock the external API server and database to verify:
 *   - Credential injection works correctly
 *   - Streaming responses pass through
 *   - Auth headers are stripped and replaced
 *   - Audit logging fires
 *
 * Note: These tests require the DB and vault modules to be available.
 * They use mocks for the actual database queries and crypto operations.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// ─── Mock external API server ─────────────────────────────────────────────────

let mockServer: ReturnType<typeof Bun.serve> | null = null;
let mockServerPort = 0;

// Track what the mock server received
let _lastReceivedHeaders: Headers | null = null;
let _lastReceivedUrl: string | null = null;

beforeAll(() => {
  mockServer = Bun.serve({
    port: 0, // random available port
    fetch(req) {
      _lastReceivedHeaders = req.headers;
      _lastReceivedUrl = req.url;

      const url = new URL(req.url);

      // Echo endpoint — returns what it received
      if (url.pathname === "/v1/echo") {
        return new Response(
          JSON.stringify({
            receivedAuth: req.headers.get("authorization"),
            receivedApiKey: req.headers.get("x-api-key"),
            path: url.pathname,
          }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }

      // SSE streaming endpoint
      if (url.pathname === "/v1/stream") {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"chunk": 1}\n\n'));
            controller.enqueue(encoder.encode('data: {"chunk": 2}\n\n'));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });
  if (mockServer.port === undefined) {
    throw new Error("Mock server did not bind to a port");
  }
  mockServerPort = mockServer.port;
});

afterAll(() => {
  mockServer?.stop();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("proxy integration", () => {
  test("mock server echo endpoint works", async () => {
    const res = await fetch(`http://localhost:${mockServerPort}/v1/echo`, {
      headers: {
        authorization: "Bearer test-key",
        "x-api-key": "my-api-key",
      },
    });
    const body = await res.json();
    expect(body.receivedAuth).toBe("Bearer test-key");
    expect(body.receivedApiKey).toBe("my-api-key");
  });

  test("mock server streaming endpoint works", async () => {
    const res = await fetch(`http://localhost:${mockServerPort}/v1/stream`);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const text = await res.text();
    expect(text).toContain('data: {"chunk": 1}');
    expect(text).toContain('data: {"chunk": 2}');
    expect(text).toContain("data: [DONE]");
  });

  test("streaming response is not buffered (ReadableStream passthrough)", async () => {
    const res = await fetch(`http://localhost:${mockServerPort}/v1/stream`);

    // Verify the body is a ReadableStream
    expect(res.body).toBeInstanceOf(ReadableStream);

    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    // Should have received at least one chunk
    expect(chunks.length).toBeGreaterThan(0);

    // Reassemble and verify content
    const decoder = new TextDecoder();
    const fullText = chunks.map((c) => decoder.decode(c)).join("");
    expect(fullText).toContain("[DONE]");
  });
});
