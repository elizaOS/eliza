import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import type { SandboxCreateConfig, SandboxHandle, SandboxProvider } from "./sandbox-provider-types";

interface MemorySandbox {
  handle: SandboxHandle;
  runtimeAgent: {
    id: string;
    name: string;
    status: "active";
  };
  server: Server;
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

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/api/health") {
        const response = json({ success: true, status: "ok" });
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
    this.sandboxes.set(sandboxId, { handle, runtimeAgent, server });
    return handle;
  }

  async stop(sandboxId: string): Promise<void> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) return;
    this.sandboxes.delete(sandboxId);
    await new Promise<void>((resolve, reject) => {
      sandbox.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async checkHealth(handle: SandboxHandle): Promise<boolean> {
    return this.sandboxes.has(handle.sandboxId);
  }

  async runCommand(): Promise<string> {
    return "";
  }
}
