/**
 * E2E tests for Cloud API Endpoints.
 *
 * Tests cover:
 * 1. Cloud status endpoint
 * 2. Cloud login endpoint
 * 3. Cloud credits endpoint
 * 4. Cloud disconnect endpoint
 * 5. Cloud topup endpoint
 *
 * Separated from cloud-login-flow.e2e.test.ts to avoid mixing node HTTP
 * server and jsdom in the same worker (causes V8 OOM during GC teardown).
 */

import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

async function req(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
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
    if (payload) r.write(payload);
    r.end();
  });
}

function createCloudTestServer(): Promise<{
  port: number;
  close: () => Promise<void>;
  getState: () => {
    connected: boolean;
    userId: string | null;
    credits: number;
  };
}> {
  const state = {
    connected: false,
    userId: null as string | null,
    credits: 0,
  };

  const json = (res: http.ServerResponse, data: unknown, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(data));
  };

  const readBody = (r: http.IncomingMessage): Promise<string> =>
    new Promise((ok) => {
      const c: Buffer[] = [];
      r.on("data", (d: Buffer) => c.push(d));
      r.on("end", () => ok(Buffer.concat(c).toString()));
    });

  const routes: Record<
    string,
    (
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ) => Promise<void> | void
  > = {
    "GET /api/cloud/status": (_r, res) =>
      json(res, {
        connected: state.connected,
        userId: state.userId,
        credits: state.credits,
      }),
    "POST /api/cloud/login": async (r, res) => {
      const body = JSON.parse(await readBody(r)) as Record<string, unknown>;
      const token = body.token as string;

      if (!token) {
        return json(res, { error: "Token required" }, 400);
      }

      state.connected = true;
      state.userId = `user-${Date.now()}`;
      state.credits = 1000;

      json(res, {
        ok: true,
        userId: state.userId,
        credits: state.credits,
      });
    },
    "POST /api/cloud/disconnect": (_r, res) => {
      state.connected = false;
      state.userId = null;
      state.credits = 0;

      json(res, { ok: true });
    },
    "GET /api/cloud/credits": (_r, res) => {
      if (!state.connected) {
        return json(res, { error: "Not connected" }, 401);
      }
      json(res, { credits: state.credits });
    },
    "POST /api/cloud/topup": async (r, res) => {
      if (!state.connected) {
        return json(res, { error: "Not connected" }, 401);
      }
      const body = JSON.parse(await readBody(r)) as Record<string, unknown>;
      const amount = (body.amount as number) || 100;
      state.credits += amount;
      json(res, { ok: true, credits: state.credits });
    },
  };

  const server = http.createServer(async (rq, rs) => {
    if (rq.method === "OPTIONS") {
      rs.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "*",
        "Access-Control-Allow-Headers": "*",
      });
      rs.end();
      return;
    }
    const key = `${rq.method} ${new URL(rq.url ?? "/", "http://localhost").pathname}`;
    const handler = routes[key];
    if (handler) {
      await handler(rq, rs);
    } else {
      json(rs, { error: "Not found" }, 404);
    }
  });

  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => {
      server.unref();
      const addr = server.address();
      ok({
        port: typeof addr === "object" && addr ? addr.port : 0,
        close: () => new Promise<void>((r) => server.close(() => r())),
        getState: () => ({
          connected: state.connected,
          userId: state.userId,
          credits: state.credits,
        }),
      });
    });
  });
}

describe("Cloud API", () => {
  let port: number;
  let close: () => Promise<void>;
  let getState: () => {
    connected: boolean;
    userId: string | null;
    credits: number;
  };

  beforeAll(async () => {
    ({ port, close, getState } = await createCloudTestServer());
  });

  afterAll(async () => {
    await close();
  });

  it("GET /api/cloud/status returns connection status", async () => {
    const { status, data } = await req(port, "GET", "/api/cloud/status");
    expect(status).toBe(200);
    expect(typeof data.connected).toBe("boolean");
  });

  it("POST /api/cloud/login connects to cloud", async () => {
    const { status, data } = await req(port, "POST", "/api/cloud/login", {
      token: "test-token",
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.userId).toBeDefined();
    expect(getState().connected).toBe(true);
  });

  it("POST /api/cloud/login fails without token", async () => {
    // First disconnect
    await req(port, "POST", "/api/cloud/disconnect");

    const { status } = await req(port, "POST", "/api/cloud/login", {});
    expect(status).toBe(400);
  });

  it("GET /api/cloud/credits returns credits when connected", async () => {
    // First connect
    await req(port, "POST", "/api/cloud/login", { token: "test" });

    const { status, data } = await req(port, "GET", "/api/cloud/credits");
    expect(status).toBe(200);
    expect(typeof data.credits).toBe("number");
  });

  it("GET /api/cloud/credits fails when not connected", async () => {
    await req(port, "POST", "/api/cloud/disconnect");

    const { status } = await req(port, "GET", "/api/cloud/credits");
    expect(status).toBe(401);
  });

  it("POST /api/cloud/disconnect disconnects from cloud", async () => {
    // First connect
    await req(port, "POST", "/api/cloud/login", { token: "test" });

    const { status, data } = await req(port, "POST", "/api/cloud/disconnect");
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(getState().connected).toBe(false);
  });

  it("POST /api/cloud/topup adds credits", async () => {
    await req(port, "POST", "/api/cloud/login", { token: "test" });
    const initialCredits = getState().credits;

    const { status, data } = await req(port, "POST", "/api/cloud/topup", {
      amount: 500,
    });

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(getState().credits).toBe(initialCredits + 500);
  });
});
