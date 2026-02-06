/**
 * Cloud Agent Entrypoint
 *
 * Runs inside the ECS container to start:
 *   1. ElizaOS agent runtime with plugin-elizacloud for inference
 *   2. HTTP health endpoint on $PORT (default 3000)
 *   3. Bridge HTTP server on $BRIDGE_PORT (default 18790) for snapshot/restore
 *
 * Configuration comes entirely from environment variables injected by
 * the container provisioning system (see CloudContainerService).
 */

import * as http from "node:http";
import * as crypto from "node:crypto";

const PORT = Number(process.env.PORT ?? "3000");
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT ?? "18790");

// ─── Agent state (in-memory, serializable) ──────────────────────────────

interface AgentState {
  memories: Array<Record<string, unknown>>;
  config: Record<string, unknown>;
  workspaceFiles: Record<string, string>;
  startedAt: string;
}

const state: AgentState = {
  memories: [],
  config: {},
  workspaceFiles: {},
  startedAt: new Date().toISOString(),
};

// ─── Health endpoint ────────────────────────────────────────────────────

const healthServer = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "healthy",
        uptime: process.uptime(),
        startedAt: state.startedAt,
        memoryUsage: process.memoryUsage().rss,
        version: process.env.ELIZAOS_CLOUD_APP_VERSION ?? "2.0.0-alpha",
      }),
    );
    return;
  }

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ service: "elizaos-cloud-agent", status: "running" }));
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

healthServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[cloud-agent] Health endpoint listening on port ${PORT}`);
});

// ─── Bridge HTTP server (snapshot, restore, messages) ───────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

const bridgeServer = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  // POST /api/snapshot — create a state snapshot
  if (req.method === "POST" && req.url === "/api/snapshot") {
    const snapshot = {
      memories: state.memories,
      config: state.config,
      workspaceFiles: state.workspaceFiles,
      timestamp: new Date().toISOString(),
    };
    res.writeHead(200);
    res.end(JSON.stringify(snapshot));
    return;
  }

  // POST /api/restore — restore state from a snapshot
  if (req.method === "POST" && req.url === "/api/restore") {
    const body = await readBody(req);
    const incoming = JSON.parse(body) as Partial<AgentState>;
    if (incoming.memories) state.memories = incoming.memories;
    if (incoming.config) state.config = incoming.config;
    if (incoming.workspaceFiles) state.workspaceFiles = incoming.workspaceFiles;
    console.log("[cloud-agent] State restored from snapshot");
    res.writeHead(200);
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // POST /bridge — JSON-RPC message forwarding
  if (req.method === "POST" && req.url === "/bridge") {
    const body = await readBody(req);
    const rpc = JSON.parse(body) as {
      jsonrpc: string;
      id?: string | number;
      method?: string;
      params?: Record<string, unknown>;
    };

    if (rpc.method === "message.send") {
      const text = (rpc.params?.text as string) ?? "";
      // Store in memories
      state.memories.push({
        id: crypto.randomUUID(),
        role: "user",
        text,
        timestamp: Date.now(),
      });

      // In a production setup this would forward to the ElizaOS runtime.
      // For now return an acknowledgement.
      const response = {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          text: `[cloud-agent] Received: ${text}`,
          metadata: { processed: true, timestamp: Date.now() },
        },
      };
      res.writeHead(200);
      res.end(JSON.stringify(response));
      return;
    }

    if (rpc.method === "status.get") {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            status: "running",
            uptime: process.uptime(),
            memoriesCount: state.memories.length,
            startedAt: state.startedAt,
          },
        }),
      );
      return;
    }

    if (rpc.method === "heartbeat") {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "heartbeat.ack",
          params: { timestamp: Date.now() },
        }),
      );
      return;
    }

    // Unknown method
    res.writeHead(200);
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32601, message: `Method not found: ${rpc.method}` },
      }),
    );
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not Found" }));
});

bridgeServer.listen(BRIDGE_PORT, "0.0.0.0", () => {
  console.log(`[cloud-agent] Bridge server listening on port ${BRIDGE_PORT}`);
});

// ─── Graceful shutdown ──────────────────────────────────────────────────

function shutdown() {
  console.log("[cloud-agent] Shutting down...");
  healthServer.close();
  bridgeServer.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log("[cloud-agent] ElizaOS Cloud Agent started");
console.log(`[cloud-agent] Health: http://0.0.0.0:${PORT}/health`);
console.log(`[cloud-agent] Bridge: http://0.0.0.0:${BRIDGE_PORT}/bridge`);
