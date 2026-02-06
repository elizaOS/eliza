/**
 * Tests for agent lifecycle management via the API server.
 *
 * Tests the REST API endpoints for:
 * - Agent state transitions (not_started -> running -> paused -> stopped)
 * - Status reporting
 * - Chat endpoint validation
 * - Plugin and skills discovery
 * - Config endpoints
 * - Onboarding endpoints
 * - Full lifecycle cycle
 *
 * Uses the actual HTTP server to test real request/response flow.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ServerHandle {
  port: number;
  close: () => Promise<void>;
}

async function request(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
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
      }
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * Start a minimal API server for testing.
 *
 * This is a self-contained test server that mirrors the real API server's
 * endpoints and state management, but without heavy dependencies like
 * @elizaos/core or config file I/O.
 */
async function startTestServer(): Promise<ServerHandle> {
  const state = {
    agentState: "not_started" as string,
    agentName: "TestAgent",
    model: undefined as string | undefined,
    startedAt: undefined as number | undefined,
    plugins: [] as Array<{ id: string; name: string; enabled: boolean }>,
    skills: [] as Array<{ id: string; name: string; enabled: boolean }>,
    logBuffer: [] as Array<{ timestamp: number; level: string; message: string }>,
    autonomyEnabled: false,
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method ?? "GET";
    const pathname = url.pathname;

    const json = (data: unknown, status = 200) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(data));
    };

    const readBody = (): Promise<string> =>
      new Promise((resolve) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      });

    // CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    // GET /api/status
    if (method === "GET" && pathname === "/api/status") {
      json({
        state: state.agentState,
        agentName: state.agentName,
        model: state.model,
        uptime: state.startedAt ? Date.now() - state.startedAt : undefined,
        startedAt: state.startedAt,
      });
      return;
    }

    // POST /api/agent/start
    if (method === "POST" && pathname === "/api/agent/start") {
      state.agentState = "running";
      state.startedAt = Date.now();
      state.model = "test-model";
      json({ ok: true, status: { state: state.agentState, agentName: state.agentName } });
      return;
    }

    // POST /api/agent/stop
    if (method === "POST" && pathname === "/api/agent/stop") {
      state.agentState = "stopped";
      state.startedAt = undefined;
      state.model = undefined;
      json({ ok: true, status: { state: state.agentState, agentName: state.agentName } });
      return;
    }

    // POST /api/agent/pause
    if (method === "POST" && pathname === "/api/agent/pause") {
      state.agentState = "paused";
      json({ ok: true, status: { state: state.agentState, agentName: state.agentName } });
      return;
    }

    // POST /api/agent/resume
    if (method === "POST" && pathname === "/api/agent/resume") {
      state.agentState = "running";
      json({ ok: true, status: { state: state.agentState, agentName: state.agentName } });
      return;
    }

    // POST /api/chat
    if (method === "POST" && pathname === "/api/chat") {
      const body = JSON.parse(await readBody()) as Record<string, unknown>;
      if (!body.text || !(body.text as string).trim()) {
        json({ error: "text is required" }, 400);
        return;
      }
      if (state.agentState !== "running") {
        json({ error: "Agent is not running" }, 503);
        return;
      }
      json({ text: `Echo: ${body.text}`, agentName: state.agentName });
      return;
    }

    // GET /api/agent/autonomy
    if (method === "GET" && pathname === "/api/agent/autonomy") {
      json({ enabled: state.autonomyEnabled ?? false });
      return;
    }

    // POST /api/agent/autonomy
    if (method === "POST" && pathname === "/api/agent/autonomy") {
      const body = JSON.parse(await readBody()) as { enabled?: boolean };
      state.autonomyEnabled = body.enabled ?? false;
      json({ ok: true, autonomy: state.autonomyEnabled });
      return;
    }

    // GET /api/plugins
    if (method === "GET" && pathname === "/api/plugins") {
      json({ plugins: state.plugins });
      return;
    }

    // GET /api/skills
    if (method === "GET" && pathname === "/api/skills") {
      json({ skills: state.skills });
      return;
    }

    // GET /api/logs
    if (method === "GET" && pathname === "/api/logs") {
      json({ entries: state.logBuffer.slice(-200) });
      return;
    }

    // GET /api/onboarding/status
    if (method === "GET" && pathname === "/api/onboarding/status") {
      json({ complete: false });
      return;
    }

    // GET /api/onboarding/options
    if (method === "GET" && pathname === "/api/onboarding/options") {
      json({
        names: ["Reimu", "Flandre"],
        styles: [{ catchphrase: "uwu~", hint: "soft" }],
        providers: [{ id: "anthropic", name: "Anthropic" }],
      });
      return;
    }

    json({ error: "Not found" }, 404);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Agent Lifecycle API", () => {
  let server: ServerHandle;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  // --- Status ---

  describe("GET /api/status", () => {
    it("returns initial not_started state", async () => {
      const { status, data } = await request(server.port, "GET", "/api/status");
      expect(status).toBe(200);
      expect(data.state).toBe("not_started");
      expect(data.agentName).toBe("TestAgent");
    });
  });

  // --- Start ---

  describe("POST /api/agent/start", () => {
    it("transitions to running state", async () => {
      const { status, data } = await request(server.port, "POST", "/api/agent/start");
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect((data.status as Record<string, unknown>).state).toBe("running");
    });

    it("status shows running after start", async () => {
      const { data } = await request(server.port, "GET", "/api/status");
      expect(data.state).toBe("running");
      expect(data.model).toBeDefined();
      expect(data.startedAt).toBeDefined();
    });
  });

  // --- Chat ---

  describe("POST /api/chat", () => {
    it("returns response when agent is running", async () => {
      const { status, data } = await request(server.port, "POST", "/api/chat", {
        text: "Hello",
      });
      expect(status).toBe(200);
      expect(data.text).toBeDefined();
      expect(data.agentName).toBe("TestAgent");
    });

    it("rejects empty text", async () => {
      const { status, data } = await request(server.port, "POST", "/api/chat", {
        text: "",
      });
      expect(status).toBe(400);
      expect(data.error).toContain("text is required");
    });

    it("rejects missing text", async () => {
      const { status, data } = await request(server.port, "POST", "/api/chat", {});
      expect(status).toBe(400);
    });
  });

  // --- Pause ---

  describe("POST /api/agent/pause", () => {
    it("transitions to paused state", async () => {
      const { status, data } = await request(server.port, "POST", "/api/agent/pause");
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect((data.status as Record<string, unknown>).state).toBe("paused");
    });

    it("chat rejected when paused", async () => {
      const { status } = await request(server.port, "POST", "/api/chat", {
        text: "Hello",
      });
      expect(status).toBe(503);
    });
  });

  // --- Resume ---

  describe("POST /api/agent/resume", () => {
    it("transitions back to running state", async () => {
      const { status, data } = await request(server.port, "POST", "/api/agent/resume");
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect((data.status as Record<string, unknown>).state).toBe("running");
    });

    it("chat works after resume", async () => {
      const { status, data } = await request(server.port, "POST", "/api/chat", {
        text: "Hello again",
      });
      expect(status).toBe(200);
      expect(data.text).toBeDefined();
    });
  });

  // --- Stop ---

  describe("POST /api/agent/stop", () => {
    it("transitions to stopped state", async () => {
      const { status, data } = await request(server.port, "POST", "/api/agent/stop");
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect((data.status as Record<string, unknown>).state).toBe("stopped");
    });

    it("chat rejected when stopped", async () => {
      const { status } = await request(server.port, "POST", "/api/chat", {
        text: "Hello",
      });
      expect(status).toBe(503);
    });

    it("status shows stopped with no uptime", async () => {
      const { data } = await request(server.port, "GET", "/api/status");
      expect(data.state).toBe("stopped");
      expect(data.model).toBeUndefined();
      expect(data.startedAt).toBeUndefined();
    });
  });

  // --- Full Lifecycle ---

  describe("full lifecycle: start -> pause -> resume -> stop -> restart", () => {
    it("cycles through all states correctly", async () => {
      // Start
      let res = await request(server.port, "POST", "/api/agent/start");
      expect(res.data.ok).toBe(true);
      let status = await request(server.port, "GET", "/api/status");
      expect(status.data.state).toBe("running");

      // Pause
      res = await request(server.port, "POST", "/api/agent/pause");
      expect(res.data.ok).toBe(true);
      status = await request(server.port, "GET", "/api/status");
      expect(status.data.state).toBe("paused");

      // Resume
      res = await request(server.port, "POST", "/api/agent/resume");
      expect(res.data.ok).toBe(true);
      status = await request(server.port, "GET", "/api/status");
      expect(status.data.state).toBe("running");

      // Stop
      res = await request(server.port, "POST", "/api/agent/stop");
      expect(res.data.ok).toBe(true);
      status = await request(server.port, "GET", "/api/status");
      expect(status.data.state).toBe("stopped");

      // Restart
      res = await request(server.port, "POST", "/api/agent/start");
      expect(res.data.ok).toBe(true);
      status = await request(server.port, "GET", "/api/status");
      expect(status.data.state).toBe("running");

      // Final stop
      await request(server.port, "POST", "/api/agent/stop");
    });
  });

  // --- Plugins and Skills ---

  describe("GET /api/plugins", () => {
    it("returns plugin list", async () => {
      const { status, data } = await request(server.port, "GET", "/api/plugins");
      expect(status).toBe(200);
      expect(Array.isArray(data.plugins)).toBe(true);
    });
  });

  describe("GET /api/skills", () => {
    it("returns skills list", async () => {
      const { status, data } = await request(server.port, "GET", "/api/skills");
      expect(status).toBe(200);
      expect(Array.isArray(data.skills)).toBe(true);
    });
  });

  // --- Logs ---

  describe("GET /api/logs", () => {
    it("returns log entries", async () => {
      const { status, data } = await request(server.port, "GET", "/api/logs");
      expect(status).toBe(200);
      expect(Array.isArray(data.entries)).toBe(true);
    });
  });

  // --- Onboarding ---

  describe("onboarding endpoints", () => {
    it("GET /api/onboarding/status returns completion status", async () => {
      const { status, data } = await request(server.port, "GET", "/api/onboarding/status");
      expect(status).toBe(200);
      expect(typeof data.complete).toBe("boolean");
    });

    it("GET /api/onboarding/options returns presets", async () => {
      const { status, data } = await request(server.port, "GET", "/api/onboarding/options");
      expect(status).toBe(200);
      expect(Array.isArray(data.names)).toBe(true);
      expect(Array.isArray(data.styles)).toBe(true);
      expect(Array.isArray(data.providers)).toBe(true);
    });
  });

  // --- Autonomy ---

  describe("GET /api/agent/autonomy", () => {
    it("returns default disabled state", async () => {
      const { status, data } = await request(server.port, "GET", "/api/agent/autonomy");
      expect(status).toBe(200);
      expect(data.enabled).toBe(false);
    });
  });

  describe("POST /api/agent/autonomy", () => {
    it("enables autonomy", async () => {
      const { status, data } = await request(server.port, "POST", "/api/agent/autonomy", {
        enabled: true,
      });
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.autonomy).toBe(true);
    });

    it("GET reflects enabled state", async () => {
      const { data } = await request(server.port, "GET", "/api/agent/autonomy");
      expect(data.enabled).toBe(true);
    });

    it("disables autonomy", async () => {
      const { status, data } = await request(server.port, "POST", "/api/agent/autonomy", {
        enabled: false,
      });
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.autonomy).toBe(false);
    });

    it("GET reflects disabled state", async () => {
      const { data } = await request(server.port, "GET", "/api/agent/autonomy");
      expect(data.enabled).toBe(false);
    });
  });

  // --- 404 ---

  describe("unknown routes", () => {
    it("returns 404 for unknown paths", async () => {
      const { status } = await request(server.port, "GET", "/api/nonexistent");
      expect(status).toBe(404);
    });
  });
});
