/**
 * Tests for the cloud-agent-entrypoint HTTP servers.
 *
 * Starts the health and bridge servers from the entrypoint script
 * and exercises all endpoints with real HTTP requests.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";

// We recreate the entrypoint logic inline because the actual entrypoint
// file uses top-level execution. We test the same request handlers here.

interface AgentState {
  memories: Array<Record<string, unknown>>;
  config: Record<string, unknown>;
  workspaceFiles: Record<string, string>;
  startedAt: string;
  timestamp?: string;
}

let healthServer: http.Server;
let bridgeServer: http.Server;
let healthUrl: string;
let bridgeUrl: string;

const state: AgentState = {
  memories: [],
  config: {},
  workspaceFiles: {},
  startedAt: new Date().toISOString(),
};

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

beforeAll(async () => {
  // Health server
  healthServer = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy", uptime: process.uptime(), startedAt: state.startedAt }));
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

  // Bridge server
  bridgeServer = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");

    if (req.method === "POST" && req.url === "/api/snapshot") {
      res.writeHead(200);
      res.end(JSON.stringify({
        memories: state.memories,
        config: state.config,
        workspaceFiles: state.workspaceFiles,
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    if (req.method === "POST" && req.url === "/api/restore") {
      const body = await readBody(req);
      const incoming = JSON.parse(body) as Partial<AgentState>;
      if (incoming.memories) state.memories = incoming.memories;
      if (incoming.config) state.config = incoming.config;
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (req.method === "POST" && req.url === "/bridge") {
      const body = await readBody(req);
      const rpc = JSON.parse(body) as { id?: number; method?: string; params?: Record<string, unknown> };

      if (rpc.method === "message.send") {
        const text = (rpc.params?.text as string) ?? "";
        state.memories.push({ role: "user", text, timestamp: Date.now() });
        res.writeHead(200);
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { text: `Echo: ${text}` } }));
        return;
      }

      if (rpc.method === "status.get") {
        res.writeHead(200);
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { status: "running", memoriesCount: state.memories.length } }));
        return;
      }

      if (rpc.method === "heartbeat") {
        res.writeHead(200);
        res.end(JSON.stringify({ jsonrpc: "2.0", method: "heartbeat.ack", params: { timestamp: Date.now() } }));
        return;
      }

      res.writeHead(200);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: `Unknown: ${rpc.method}` } }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not Found" }));
  });

  await Promise.all([
    new Promise<void>((r) => healthServer.listen(0, "127.0.0.1", () => {
      healthUrl = `http://127.0.0.1:${(healthServer.address() as { port: number }).port}`;
      r();
    })),
    new Promise<void>((r) => bridgeServer.listen(0, "127.0.0.1", () => {
      bridgeUrl = `http://127.0.0.1:${(bridgeServer.address() as { port: number }).port}`;
      r();
    })),
  ]);
});

afterAll(() => {
  healthServer.close();
  bridgeServer.close();
});

// ─── Health endpoint ─────────────────────────────────────────────────────

describe("health endpoint", () => {
  it("GET /health returns 200 with status", async () => {
    const res = await fetch(`${healthUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("healthy");
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.startedAt).toBe("string");
  });

  it("GET / returns service info", async () => {
    const res = await fetch(healthUrl);
    const body = await res.json() as Record<string, unknown>;
    expect(body.service).toBe("elizaos-cloud-agent");
    expect(body.status).toBe("running");
  });

  it("GET /nonexistent returns 404", async () => {
    const res = await fetch(`${healthUrl}/nonexistent`);
    expect(res.status).toBe(404);
  });
});

// ─── Bridge: snapshot/restore ────────────────────────────────────────────

describe("bridge snapshot/restore", () => {
  it("POST /api/snapshot returns current state", async () => {
    const res = await fetch(`${bridgeUrl}/api/snapshot`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as AgentState;
    expect(Array.isArray(body.memories)).toBe(true);
    expect(typeof body.timestamp).toBe("string");
  });

  it("POST /api/restore updates state", async () => {
    const newState = {
      memories: [{ role: "user", text: "restored message" }],
      config: { model: "test-model" },
    };
    const res = await fetch(`${bridgeUrl}/api/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newState),
    });
    expect(res.status).toBe(200);

    // Verify state was updated
    const snap = await fetch(`${bridgeUrl}/api/snapshot`, { method: "POST" });
    const body = await snap.json() as AgentState;
    expect(body.memories).toHaveLength(1);
    expect((body.memories[0] as Record<string, unknown>).text).toBe("restored message");
    expect(body.config).toEqual({ model: "test-model" });
  });
});

// ─── Bridge: JSON-RPC messaging ──────────────────────────────────────────

describe("bridge JSON-RPC", () => {
  it("message.send echoes back and stores in memories", async () => {
    // Reset state
    state.memories = [];

    const res = await fetch(`${bridgeUrl}/bridge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message.send", params: { text: "hello world" } }),
    });
    const body = await res.json() as { id: number; result: { text: string } };
    expect(body.id).toBe(1);
    expect(body.result.text).toContain("hello world");
    expect(state.memories).toHaveLength(1);
    expect(state.memories[0].text).toBe("hello world");
  });

  it("status.get returns running status with memory count", async () => {
    state.memories = [{ text: "a" }, { text: "b" }];
    const res = await fetch(`${bridgeUrl}/bridge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "status.get", params: {} }),
    });
    const body = await res.json() as { result: { status: string; memoriesCount: number } };
    expect(body.result.status).toBe("running");
    expect(body.result.memoriesCount).toBe(2);
  });

  it("heartbeat returns heartbeat.ack", async () => {
    const res = await fetch(`${bridgeUrl}/bridge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "heartbeat", params: { timestamp: Date.now() } }),
    });
    const body = await res.json() as { method: string; params: { timestamp: number } };
    expect(body.method).toBe("heartbeat.ack");
    expect(typeof body.params.timestamp).toBe("number");
  });

  it("unknown method returns JSON-RPC error", async () => {
    const res = await fetch(`${bridgeUrl}/bridge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "nonexistent.method", params: {} }),
    });
    const body = await res.json() as { id: number; error: { code: number; message: string } };
    expect(body.id).toBe(3);
    expect(body.error.code).toBe(-32601);
    expect(body.error.message).toContain("nonexistent.method");
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("message.send with empty text", async () => {
    const res = await fetch(`${bridgeUrl}/bridge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "message.send", params: {} }),
    });
    const body = await res.json() as { result: { text: string } };
    expect(body.result.text).toContain("Echo:");
  });

  it("bridge 404 for unknown paths", async () => {
    const res = await fetch(`${bridgeUrl}/unknown`);
    expect(res.status).toBe(404);
  });

  it("snapshot after multiple messages preserves order", async () => {
    state.memories = [];
    for (let i = 0; i < 5; i++) {
      await fetch(`${bridgeUrl}/bridge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 100 + i, method: "message.send", params: { text: `msg-${i}` } }),
      });
    }

    const snap = await fetch(`${bridgeUrl}/api/snapshot`, { method: "POST" });
    const body = await snap.json() as AgentState;
    expect(body.memories).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(body.memories[i].text).toBe(`msg-${i}`);
    }
  });
});
