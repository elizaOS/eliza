import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import type { SandboxCreateConfig, SandboxHandle, SandboxProvider } from "./sandbox-provider-types";

interface MemoryAgentState {
  memories: Array<{ role: string; text: string; timestamp: number }>;
  config: Record<string, unknown>;
  workspaceFiles: Record<string, string>;
}

interface MemorySandbox {
  handle: SandboxHandle;
  runtimeAgent: {
    id: string;
    name: string;
    status: "active";
  };
  server: Server;
  sockets: Set<Socket>;
  /** Mutable agent state, so /api/snapshot and /api/restore round-trip. */
  state: MemoryAgentState;
}

async function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("[memory-sandbox] test server did not bind to a TCP port");
  }
  return address.port;
}

/**
 * Test-only sandbox provider used by cloud E2E.
 *
 * It exercises the real DB-backed provisioning and deletion job service without
 * requiring Docker, SSH nodes, or live Hetzner credentials in CI. Production
 * selection is guarded in `createSandboxProvider`.
 */
export class MemorySandboxProvider implements SandboxProvider {
  private readonly sandboxes = new Map<string, MemorySandbox>();

  async create(config: SandboxCreateConfig): Promise<SandboxHandle> {
    const runtimeAgent = {
      id: `runtime-${randomUUID()}`,
      name: config.agentName,
      status: "active" as const,
    };

    // Each fresh container boots with empty state; /api/restore hydrates it.
    const state: MemoryAgentState = { memories: [], config: {}, workspaceFiles: {} };

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/api/health") {
        const response = json({ success: true, status: "ok" });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
        return;
      }

      // Snapshot: return the agent's current state (used by sleep/snapshot).
      if (req.method === "POST" && url.pathname === "/api/snapshot") {
        const response = json(state);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
        return;
      }

      // Restore: overwrite the agent's state (used by wake/resume restore).
      if (req.method === "POST" && url.pathname === "/api/restore") {
        const body = await readJsonBody(req);
        if (body && typeof body === "object") {
          const incoming = body as Partial<MemoryAgentState>;
          state.memories = Array.isArray(incoming.memories) ? incoming.memories : [];
          state.config =
            incoming.config && typeof incoming.config === "object" ? incoming.config : {};
          state.workspaceFiles =
            incoming.workspaceFiles && typeof incoming.workspaceFiles === "object"
              ? incoming.workspaceFiles
              : {};
        }
        const response = json({ success: true });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/agents") {
        const response = json({ success: true, agents: [runtimeAgent] });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/agents") {
        const response = json({
          success: true,
          data: runtimeAgent,
        });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname.startsWith("/api/agents/") &&
        url.pathname.endsWith("/start")
      ) {
        const response = json({ success: true, data: runtimeAgent });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
        return;
      }

      const response = json({ success: false, error: "Not found" }, 404);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    });
    const sockets = new Set<Socket>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => {
        sockets.delete(socket);
      });
    });

    const port = await listen(server);
    const sandboxId = `memory-${config.agentId}`;
    const baseUrl = `http://127.0.0.1:${port}`;
    const handle: SandboxHandle = {
      sandboxId,
      bridgeUrl: baseUrl,
      healthUrl: `${baseUrl}/api/health`,
      metadata: {
        provider: "memory",
        agentId: config.agentId,
      },
    };
    this.sandboxes.set(sandboxId, { handle, runtimeAgent, server, sockets, state });
    return handle;
  }

  async stop(sandboxId: string): Promise<void> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) return;
    this.sandboxes.delete(sandboxId);
    const close = new Promise<void>((resolve, reject) => {
      sandbox.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    sandbox.server.closeIdleConnections?.();
    for (const socket of sandbox.sockets) {
      socket.destroy();
    }
    await Promise.race([close, delay(2_000)]);
  }

  async checkHealth(handle: SandboxHandle): Promise<boolean> {
    return this.sandboxes.has(handle.sandboxId);
  }

  async runCommand(): Promise<string> {
    return "";
  }
}
