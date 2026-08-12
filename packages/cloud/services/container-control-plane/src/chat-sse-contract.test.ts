/**
 * Drives the real control-plane HTTP boundary to ensure invalid stream calls
 * remain machine-classifiable SSE rather than an untyped named event.
 */
import { afterAll, expect, test } from "bun:test";
import { app } from "./index";

const previousToken = process.env.CONTAINER_CONTROL_PLANE_TOKEN;
process.env.CONTAINER_CONTROL_PLANE_TOKEN = "chat-sse-contract-token";

afterAll(() => {
  if (previousToken === undefined) {
    delete process.env.CONTAINER_CONTROL_PLANE_TOKEN;
  } else {
    process.env.CONTAINER_CONTROL_PLANE_TOKEN = previousToken;
  }
});

test("invalid JSON-RPC stream requests carry the canonical error type", async () => {
  const response = await app.request("/api/v1/eliza/agents/agent-1/stream", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-container-control-plane-token": "chat-sse-contract-token",
      "x-eliza-user-id": "user-1",
      "x-eliza-organization-id": "org-1",
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "heartbeat" }),
  });

  expect(response.status).toBe(400);
  const body = await response.text();
  expect(body).toContain("event: error");
  const data = JSON.parse(
    body.split("data: ")[1]?.split("\n")[0] ?? "{}",
  ) as Record<string, unknown>;
  expect(data).toEqual({
    message: "Invalid JSON-RPC stream request",
    type: "error",
  });
});
