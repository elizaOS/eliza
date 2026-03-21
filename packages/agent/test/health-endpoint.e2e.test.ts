/**
 * Health Endpoint — E2E Tests
 *
 * Tests the GET /api/health endpoint added for system observability.
 */

import http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server";

vi.mock("../src/services/mcp-marketplace", () => ({
  searchMcpMarketplace: vi.fn().mockResolvedValue({ results: [] }),
  getMcpServerDetails: vi.fn().mockResolvedValue(null),
}));

function req(
  port: number,
  method: string,
  p: string,
): Promise<{
  status: number;
  data: Record<string, unknown>;
}> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: p,
        method,
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        const ch: Buffer[] = [];
        res.on("data", (c: Buffer) => ch.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(ch).toString("utf-8");
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            data = { _raw: raw };
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

let port: number;
let server: Awaited<ReturnType<typeof startApiServer>>;

beforeAll(async () => {
  server = await startApiServer({
    port: 0,
    initialAgentState: "not_started",
  });
  port = server.port;
}, 30_000);

afterAll(async () => {
  if (server) {
    await server.close();
  }
}, 15_000);

describe("GET /api/health", () => {
  it("returns structured status", async () => {
    const { status, data } = await req(port, "GET", "/api/health");
    expect(status).toBe(200);
    expect(data).toHaveProperty("runtime");
    expect(data).toHaveProperty("database");
    expect(data).toHaveProperty("plugins");
    expect(data).toHaveProperty("coordinator");
    expect(data).toHaveProperty("connectors");
    expect(data).toHaveProperty("uptime");
    expect(data).toHaveProperty("agentState");
  });

  it("reports runtime not_initialized when no runtime", async () => {
    const { data } = await req(port, "GET", "/api/health");
    expect(data.runtime).toBe("not_initialized");
    expect(data.coordinator).toBe("not_wired");
  });

  it("reports plugins count", async () => {
    const { data } = await req(port, "GET", "/api/health");
    const plugins = data.plugins as Record<string, number>;
    expect(typeof plugins.loaded).toBe("number");
    expect(typeof plugins.failed).toBe("number");
  });
});
