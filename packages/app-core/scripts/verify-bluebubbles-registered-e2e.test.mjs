/**
 * Verifies that the registered BlueBubbles CLI's physical mode waits for a
 * relay-observed inbound event and reports exact-agent reply delivery without
 * injecting a webhook itself.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const servers = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    if (!server.listening) continue;
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

function sendJson(response, body, statusCode = 200) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

describe("registered BlueBubbles physical verifier", () => {
  test("waits for a real-inbound evidence event", async () => {
    let inboundEventReads = 0;
    let injectedWebhookRequests = 0;
    let observedSender = "";
    let observedMarker = "";
    const relay = createServer((request, response) => {
      const url = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "127.0.0.1"}`,
      );
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, {
          status: "ok",
          gatewayAuthMode: "registered-device",
          gatewayPhoneNumber: "+14155550123",
          bridgeId: "bb-e2e",
          outboundReadiness: { ready: true },
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/inbound-events") {
        inboundEventReads += 1;
        observedSender = url.searchParams.get("sender") ?? "";
        observedMarker = url.searchParams.get("marker") ?? "";
        sendJson(response, {
          count: 1,
          events: [
            {
              receivedAt: new Date().toISOString(),
              messageId: "real-inbound-1",
              sender: url.searchParams.get("sender"),
              textPreview: url.searchParams.get("marker"),
              handled: true,
              agentId: "agent-e2e",
              organizationId: "org-e2e",
              userId: "user-e2e",
              replied: true,
              replyQueued: false,
            },
          ],
        });
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/webhooks/bluebubbles"
      ) {
        injectedWebhookRequests += 1;
      }
      sendJson(response, { error: "not found" }, 404);
    });
    await new Promise((resolve, reject) => {
      relay.once("error", reject);
      relay.listen(0, "127.0.0.1", resolve);
    });
    servers.push(relay);
    const address = relay.address();
    if (!address || typeof address === "string") {
      throw new Error("relay did not expose a TCP address");
    }

    const child = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL("./verify-bluebubbles-registered-e2e.mjs", import.meta.url),
        ),
        "--sender",
        "+14155550999",
        "--agent-id",
        "agent-e2e",
        "--bridge-url",
        `http://127.0.0.1:${address.port}/webhooks/bluebubbles`,
        "--wait-real",
        "--timeout-seconds",
        "2",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const stdout = stdoutChunks.join("");
    const stderr = stderrChunks.join("");

    expect(exitCode, stderr).toBe(0);
    expect(inboundEventReads).toBe(1);
    expect(injectedWebhookRequests).toBe(0);
    expect(observedSender).toBe("+14155550999");
    expect(observedMarker).toContain("BlueBubbles registered gateway E2E");
    expect(stdout).not.toContain("injected-inbound");
  });
});
