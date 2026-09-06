import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { probeApiHealth } from "./dev-api-health.mjs";

let server;

async function serve(handler) {
  server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  server = null;
});

describe("probeApiHealth", () => {
  it("keeps ready, booting, and HTTP failure distinct across real responses", async () => {
    let status = 200;
    let body = { ready: true };
    const port = await serve((request, response) => {
      expect(request.url).toBe("/api/health");
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    });
    expect(await probeApiHealth(port)).toMatchObject({
      healthy: true,
      reason: "ready",
      status: 200,
    });
    body = { ready: false };
    expect(await probeApiHealth(port)).toMatchObject({
      healthy: false,
      reason: "not_ready",
      status: 200,
    });
    status = 503;
    expect(await probeApiHealth(port)).toMatchObject({
      healthy: false,
      reason: "http_error",
      status: 503,
    });
  });

  it("reports malformed JSON without copying private response content", async () => {
    const privateBody = "credential-bearing diagnostic: private-value";
    const port = await serve((_request, response) => response.end(privateBody));
    const result = await probeApiHealth(port);
    expect(result).toMatchObject({
      healthy: false,
      reason: "invalid_json",
      status: 200,
    });
    expect(JSON.stringify(result)).not.toContain("private-value");
  });

  it.each([false, true])(
    "times out a stalled response (headers already received: %s)",
    async (sendHeaders) => {
      const port = await serve((_request, response) => {
        if (sendHeaders) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.flushHeaders();
        }
        // Leave the real connection open without a complete health result.
      });
      const result = await probeApiHealth(port, { timeoutMs: 60 });
      expect(result).toMatchObject({
        healthy: false,
        reason: "timeout",
        status: sendHeaders ? 200 : null,
      });
      expect(result.elapsedMs).toBeGreaterThan(0);
    },
  );

  it("distinguishes connection failure from a server's unhealthy response", async () => {
    const port = await serve((_request, response) => response.end("unused"));
    await new Promise((resolve) => server.close(resolve));
    server = null;
    expect(await probeApiHealth(port)).toMatchObject({
      healthy: false,
      reason: "transport_error",
      status: null,
    });
  });
});
