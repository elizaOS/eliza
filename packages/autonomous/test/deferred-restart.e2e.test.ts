/**
 * E2E tests for the deferred restart feature.
 *
 * Verifies that config changes accumulate pending restart reasons instead of
 * immediately restarting, that GET /api/status exposes them, that WebSocket
 * broadcasts include them, and that POST /api/agent/restart clears them.
 */

import http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startApiServer } from "../src/api/server";

// ---------------------------------------------------------------------------
// HTTP helper (same pattern as api-server.e2e.test.ts)
// ---------------------------------------------------------------------------

function req(
  port: number,
  method: string,
  p: string,
  body?: Record<string, unknown>,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  data: Record<string, unknown>;
}> {
  return new Promise((resolve, reject) => {
    const b = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: p,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(b ? { "Content-Length": Buffer.byteLength(b) } : {}),
        },
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
          resolve({ status: res.statusCode ?? 0, headers: res.headers, data });
        });
      },
    );
    r.on("error", reject);
    if (b) r.write(b);
    r.end();
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safely narrow an unknown value to a string array, filtering non-strings. */
function toStringArray(val: unknown): string[] {
  return Array.isArray(val)
    ? val.filter((el): el is string => typeof el === "string")
    : [];
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function waitForWsMessage(
  ws: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket message"));
    }, timeoutMs);

    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const text = Buffer.isBuffer(raw) ? raw.toString("utf-8") : String(raw);
        const message = JSON.parse(text) as Record<string, unknown>;
        if (predicate(message)) {
          cleanup();
          resolve(message);
        }
      } catch {
        // Ignore malformed WS frames in tests.
      }
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };

    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Deferred restart E2E", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const server = await startApiServer({ port: 0 });
    port = server.port;
    close = server.close;
  }, 30_000);

  afterAll(async () => {
    await close();
  });

  // -- Initial state --

  describe("initial state (no pending restart)", () => {
    it("GET /api/status returns pendingRestart: false with empty reasons", async () => {
      const { status, data } = await req(port, "GET", "/api/status");
      expect(status).toBe(200);
      expect(data.pendingRestart).toBe(false);
      expect(data.pendingRestartReasons).toEqual([]);
    });
  });

  // -- Wallet config change triggers pending restart --

  describe("PUT /api/wallet/config marks restart as pending", () => {
    it("adds pendingRestart after wallet config update", async () => {
      await req(port, "PUT", "/api/wallet/config", {
        ALCHEMY_API_KEY: "test-key-1",
      });

      const { data } = await req(port, "GET", "/api/status");
      expect(data.pendingRestart).toBe(true);
      expect(data.pendingRestartReasons).toContain(
        "Wallet configuration updated",
      );
    });

    it("does not duplicate the same reason on repeated config saves", async () => {
      await req(port, "PUT", "/api/wallet/config", {
        ALCHEMY_API_KEY: "test-key-2",
      });

      const { data } = await req(port, "GET", "/api/status");
      expect(data.pendingRestart).toBe(true);
      const reasons = toStringArray(data.pendingRestartReasons);
      const configReasonCount = reasons.filter(
        (r) => r === "Wallet configuration updated",
      ).length;
      expect(configReasonCount).toBe(1);
    });
  });

  // -- WebSocket broadcasts restart-required --

  describe("WebSocket restart-required event", () => {
    it("broadcasts restart-required when wallet config is saved", async () => {
      const ws = await connectWs(port);

      try {
        // Set up listener before making the config change
        const messagePromise = waitForWsMessage(
          ws,
          (msg) => msg.type === "restart-required",
        );

        // Make a wallet config update
        await req(port, "PUT", "/api/wallet/config", {
          ALCHEMY_API_KEY: "test-key-ws",
        });

        const msg = await messagePromise;
        expect(msg.type).toBe("restart-required");
        expect(Array.isArray(msg.reasons)).toBe(true);
        expect(toStringArray(msg.reasons).length).toBeGreaterThan(0);
      } finally {
        ws.close();
      }
    });

    it("periodic status broadcast includes pending restart fields", async () => {
      const ws = await connectWs(port);

      try {
        // Wait for a periodic status broadcast (server sends these every ~5s)
        const msg = await waitForWsMessage(
          ws,
          (msg) => msg.type === "status",
          10_000,
        );

        expect(typeof msg.pendingRestart).toBe("boolean");
        expect(Array.isArray(msg.pendingRestartReasons)).toBe(true);
      } finally {
        ws.close();
      }
    });
  });

  // -- scheduleRuntimeRestart does NOT restart the agent --

  describe("scheduleRuntimeRestart defers (does not restart)", () => {
    it("agent state remains not_started after config change (no actual restart)", async () => {
      // The server was started without a runtime, so agentState stays "not_started"
      // or whatever it transitioned to. The key point: config changes should NOT
      // trigger a real restart, so we should not see "restarting" state.
      const { data } = await req(port, "GET", "/api/status");
      expect(data.state).not.toBe("restarting");
    });
  });

  // -- No onRestart handler --

  describe("POST /api/agent/restart without onRestart handler", () => {
    it("returns 501 when no restart handler is registered", async () => {
      // This server was started without onRestart, so explicit restart is unsupported
      const { status, data } = await req(port, "POST", "/api/agent/restart");
      expect(status).toBe(501);
      expect(data.error).toMatch(/not supported/i);
    });

    it("still accumulates pending reasons even without onRestart handler", async () => {
      // scheduleRuntimeRestart works independently of the onRestart handler
      await req(port, "PUT", "/api/wallet/config", {
        ALCHEMY_API_KEY: "test-key-no-handler",
      });

      const { data } = await req(port, "GET", "/api/status");
      expect(data.pendingRestart).toBe(true);
      expect(toStringArray(data.pendingRestartReasons).length).toBeGreaterThan(
        0,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Test with onRestart handler — proves restart clears pending reasons
// ---------------------------------------------------------------------------

describe("Deferred restart E2E (with restart handler)", () => {
  let port: number;
  let close: () => Promise<void>;
  let restartCallCount: number;

  beforeAll(async () => {
    restartCallCount = 0;

    const mockRuntime = {
      character: { name: "TestAgent" },
      plugins: [],
      getService: () => null,
    } as unknown as AgentRuntime;

    const server = await startApiServer({
      port: 0,
      runtime: mockRuntime,
      onRestart: async () => {
        restartCallCount++;
        return mockRuntime;
      },
    });
    port = server.port;
    close = server.close;
  }, 30_000);

  afterAll(async () => {
    await close();
  });

  it("accumulates reasons, then restart clears them", async () => {
    // 1. Trigger a pending restart via wallet config change
    await req(port, "PUT", "/api/wallet/config", {
      ALCHEMY_API_KEY: "test-key-accumulate",
    });

    // 2. Verify pending reasons are present
    let { data } = await req(port, "GET", "/api/status");
    expect(data.pendingRestart).toBe(true);
    expect(toStringArray(data.pendingRestartReasons).length).toBeGreaterThan(0);

    // 3. Perform explicit restart
    const restartResult = await req(port, "POST", "/api/agent/restart");
    expect(restartResult.data.ok).toBe(true);
    expect(restartResult.data.pendingRestart).toBe(false);

    // 4. Verify pending reasons are cleared
    ({ data } = await req(port, "GET", "/api/status"));
    expect(data.pendingRestart).toBe(false);
    expect(data.pendingRestartReasons).toEqual([]);
  });

  it("wallet config changes do not trigger onRestart", async () => {
    const before = restartCallCount;

    // Multiple wallet config changes
    await req(port, "PUT", "/api/wallet/config", {
      ALCHEMY_API_KEY: "test-key-b",
    });
    await req(port, "PUT", "/api/wallet/config", {
      ALCHEMY_API_KEY: "test-key-c",
    });

    // onRestart should NOT have been called
    expect(restartCallCount).toBe(before);

    // Only explicit restart triggers onRestart
    await req(port, "POST", "/api/agent/restart");
    expect(restartCallCount).toBe(before + 1);
  });

  it("WebSocket restart-required event includes all accumulated reasons", async () => {
    // Clear state by restarting first
    await req(port, "POST", "/api/agent/restart");

    const ws = await connectWs(port);

    try {
      // Listen for restart-required
      const messagePromise = waitForWsMessage(
        ws,
        (msg) => msg.type === "restart-required",
      );

      // Trigger wallet config change
      await req(port, "PUT", "/api/wallet/config", {
        ALCHEMY_API_KEY: "test-key-d",
      });

      const msg = await messagePromise;
      const reasons = toStringArray(msg.reasons);
      expect(reasons).toContain("Wallet configuration updated");
    } finally {
      ws.close();
    }
  });
});
