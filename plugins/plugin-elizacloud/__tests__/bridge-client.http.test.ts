import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { CloudBridgeError, ElizaCloudClient } from "../src/cloud/bridge-client.js";
import { ConnectionMonitor } from "../src/cloud/reconnect.js";

const servers: ReturnType<typeof createServer>[] = [];

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP proof server did not expose a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

/**
 * A dedicated agent's bridge as Cloud serves it: bridge/route.ts wraps
 * elizaSandboxService.bridge() in Response.json(), so a stopped sandbox is an
 * HTTP 200 carrying a JSON-RPC error. provision/route.ts queues the restart
 * (202, success true).
 */
async function startDedicatedAgentCloud(): Promise<{
  baseUrl: string;
  requests: string[];
}> {
  let sandboxRunning = false;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(`${request.method} ${request.url}`);
      response.writeHead(request.url?.endsWith("/provision") ? 202 : 200, {
        "content-type": "application/json",
      });
      if (request.url === "/api/v1/eliza/agents/agent-123/provision") {
        sandboxRunning = true;
        response.end(
          JSON.stringify({
            success: true,
            created: true,
            data: { jobId: "job-1", agentId: "agent-123", status: "pending" },
          })
        );
        return;
      }
      const rpc = JSON.parse(body) as { id?: unknown; method: string };
      response.end(
        JSON.stringify(
          sandboxRunning
            ? {
                jsonrpc: "2.0",
                id: rpc.id,
                result: { status: "running", ready: true, agentId: "agent-123" },
              }
            : {
                jsonrpc: "2.0",
                id: rpc.id,
                error: { code: -32000, message: "Sandbox is not running" },
              }
        )
      );
    });
  });
  return { baseUrl: await listen(server), requests };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
});

describe("ElizaCloudClient bridge HTTP boundary", () => {
  it("reports a successful HTTP response without reply text as a failure", async () => {
    const responses: unknown[] = [
      { jsonrpc: "2.0", id: "empty", result: {} },
      { jsonrpc: "2.0", id: "valid", result: { text: "working reply" } },
    ];
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responses.shift()));
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("HTTP proof server did not expose a TCP port");
    }

    const client = new ElizaCloudClient(`http://127.0.0.1:${address.port}`, "eliza_test_key");

    await expect(client.sendMessage("agent-123", "hello")).rejects.toMatchObject({
      name: CloudBridgeError.name,
      message: "Bridge response did not include reply text",
    });
    await expect(client.sendMessage("agent-123", "hello again")).resolves.toBe("working reply");
    expect(paths).toEqual([
      "/api/v1/eliza/agents/agent-123/bridge",
      "/api/v1/eliza/agents/agent-123/bridge",
    ]);
  });

  it("does not report a stopped sandbox as alive", async () => {
    const cloud = await startDedicatedAgentCloud();
    const client = new ElizaCloudClient(cloud.baseUrl, "eliza_test_key");

    await expect(client.heartbeat("agent-123")).resolves.toBe(false);
    await client.provision("agent-123");
    await expect(client.heartbeat("agent-123")).resolves.toBe(true);
  });

  it("re-provisions a dedicated agent whose sandbox stopped", async () => {
    const cloud = await startDedicatedAgentCloud();
    const client = new ElizaCloudClient(cloud.baseUrl, "eliza_test_key");
    const statuses: string[] = [];
    let reconnects = 0;
    const monitor = new ConnectionMonitor(
      client,
      "agent-123",
      {
        onDisconnect: () => statuses.push("disconnect"),
        onReconnect: () => {
          reconnects += 1;
        },
        onStatusChange: (status) => statuses.push(status),
      },
      20,
      2
    );
    monitor.start();
    try {
      const deadline = Date.now() + 1_500;
      while (reconnects === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      monitor.stop();
    }

    expect(reconnects).toBe(1);
    expect(statuses).toEqual(["disconnect", "reconnecting", "connected"]);
    expect(cloud.requests.slice(0, 3)).toEqual([
      "POST /api/v1/eliza/agents/agent-123/bridge",
      "POST /api/v1/eliza/agents/agent-123/bridge",
      "POST /api/v1/eliza/agents/agent-123/provision",
    ]);
  });
});
