/**
 * Tests for agent lifecycle API — state transitions, chat, plugins, onboarding.
 *
 * IMPORTANT: This tests a lightweight MOCK server that mirrors the real API
 * server's HTTP contract (routes, status codes, response shapes). It does NOT
 * test the real startApiServer() from src/api/server.ts, because that requires
 * @elizaos/core runtime and filesystem config access.
 *
 * What this proves:
 * - The HTTP contract (routes, methods, status codes, JSON shapes)
 * - State transitions (not_started → running → paused → stopped)
 * - Chat validation (empty text, agent-not-running guard)
 *
 * What this does NOT prove:
 * - Real plugin/skill discovery from filesystem
 * - Real LLM-backed chat responses (runtime.generateText)
 * - Config persistence, onboarding side effects
 * - The real server's error handling
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function req(
  port: number, method: string, path: string, body?: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      { hostname: "127.0.0.1", port, path, method, headers: { "Content-Type": "application/json", ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let data: Record<string, unknown> = {};
          try { data = JSON.parse(raw) as Record<string, unknown>; } catch { data = { _raw: raw }; }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ---------------------------------------------------------------------------
// Test server (mirrors real API server endpoints without heavy deps)
// ---------------------------------------------------------------------------

function createTestServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const state = {
    agentState: "not_started" as string,
    agentName: "TestAgent",
    model: undefined as string | undefined,
    startedAt: undefined as number | undefined,
    runtime: null as object | null, // mirrors real server's runtime check
  };

  const json = (res: http.ServerResponse, data: unknown, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(data));
  };

  const readBody = (r: http.IncomingMessage): Promise<string> =>
    new Promise((ok) => { const c: Buffer[] = []; r.on("data", (d: Buffer) => c.push(d)); r.on("end", () => ok(Buffer.concat(c).toString())); });

  const routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> | void> = {
    "GET /api/status": (_r, res) => json(res, { state: state.agentState, agentName: state.agentName, model: state.model, startedAt: state.startedAt, uptime: state.startedAt ? Date.now() - state.startedAt : undefined }),
    "POST /api/agent/start": (_r, res) => { state.agentState = "running"; state.startedAt = Date.now(); state.model = "test-model"; state.runtime = {}; json(res, { ok: true, status: { state: "running", agentName: state.agentName } }); },
    "POST /api/agent/stop": (_r, res) => { state.agentState = "stopped"; state.startedAt = undefined; state.model = undefined; state.runtime = null; json(res, { ok: true, status: { state: "stopped", agentName: state.agentName } }); },
    "POST /api/agent/pause": (_r, res) => { state.agentState = "paused"; json(res, { ok: true, status: { state: "paused", agentName: state.agentName } }); },
    "POST /api/agent/resume": (_r, res) => { state.agentState = "running"; json(res, { ok: true, status: { state: "running", agentName: state.agentName } }); },
    "POST /api/chat": async (r, res) => {
      const body = JSON.parse(await readBody(r)) as Record<string, unknown>;
      if (!body.text || !(body.text as string).trim()) return json(res, { error: "text is required" }, 400);
      if (!state.runtime) return json(res, { error: "Agent is not running" }, 503);
      json(res, { text: `Echo: ${body.text}`, agentName: state.agentName });
    },
    "GET /api/plugins": (_r, res) => json(res, { plugins: [] }),
    "GET /api/skills": (_r, res) => json(res, { skills: [] }),
    "GET /api/logs": (_r, res) => json(res, { entries: [] }),
    "GET /api/onboarding/status": (_r, res) => json(res, { complete: false }),
    "GET /api/onboarding/options": (_r, res) => json(res, { names: ["Reimu"], styles: [{ catchphrase: "uwu~" }], providers: [{ id: "anthropic" }] }),
  };

  const server = http.createServer(async (rq, rs) => {
    if (rq.method === "OPTIONS") { rs.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Allow-Headers": "*" }); rs.end(); return; }
    const key = `${rq.method} ${new URL(rq.url ?? "/", "http://localhost").pathname}`;
    const handler = routes[key];
    if (handler) { await handler(rq, rs); } else { json(rs, { error: "Not found" }, 404); }
  });

  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      ok({ port: typeof addr === "object" && addr ? addr.port : 0, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Agent Lifecycle API", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => { ({ port, close } = await createTestServer()); });
  afterAll(async () => { await close(); });

  // -- Status --

  it("initial status is not_started", async () => {
    const { status, data } = await req(port, "GET", "/api/status");
    expect(status).toBe(200);
    expect(data.state).toBe("not_started");
    expect(data.agentName).toBe("TestAgent");
  });

  // -- Start --

  it("start transitions to running with model, startedAt, uptime", async () => {
    const { data } = await req(port, "POST", "/api/agent/start");
    expect(data.ok).toBe(true);
    const status = await req(port, "GET", "/api/status");
    expect(status.data.state).toBe("running");
    expect(status.data.model).toBeDefined();
    expect(status.data.startedAt).toBeDefined();
    expect(typeof status.data.uptime).toBe("number");
  });

  // -- Chat --

  describe("chat", () => {
    it("responds when running", async () => {
      const { status, data } = await req(port, "POST", "/api/chat", { text: "Hello" });
      expect(status).toBe(200);
      expect(data.text).toBeDefined();
      expect(data.agentName).toBe("TestAgent");
    });

    it("rejects empty text", async () => {
      expect((await req(port, "POST", "/api/chat", { text: "" })).status).toBe(400);
    });

    it("rejects missing text", async () => {
      expect((await req(port, "POST", "/api/chat", {})).status).toBe(400);
    });
  });

  // -- Pause --
  // Note: the real server checks `!state.runtime` for chat, NOT `agentState`.
  // When paused, runtime still exists, so chat still works. This matches production.

  it("pause transitions to paused, chat still works (runtime exists)", async () => {
    expect((await req(port, "POST", "/api/agent/pause")).data.ok).toBe(true);
    expect((await req(port, "GET", "/api/status")).data.state).toBe("paused");
    expect((await req(port, "POST", "/api/chat", { text: "hi" })).status).toBe(200);
  });

  // -- Resume --

  it("resume transitions back to running, chat works", async () => {
    expect((await req(port, "POST", "/api/agent/resume")).data.ok).toBe(true);
    expect((await req(port, "GET", "/api/status")).data.state).toBe("running");
    expect((await req(port, "POST", "/api/chat", { text: "hi" })).status).toBe(200);
  });

  // -- Stop --

  it("stop transitions to stopped, clears model/startedAt", async () => {
    expect((await req(port, "POST", "/api/agent/stop")).data.ok).toBe(true);
    const { data } = await req(port, "GET", "/api/status");
    expect(data.state).toBe("stopped");
    expect(data.model).toBeUndefined();
    expect(data.startedAt).toBeUndefined();
    expect((await req(port, "POST", "/api/chat", { text: "hi" })).status).toBe(503);
  });

  // -- Full lifecycle --

  it("full cycle: start → pause → resume → stop → restart", async () => {
    await req(port, "POST", "/api/agent/start");
    expect((await req(port, "GET", "/api/status")).data.state).toBe("running");

    await req(port, "POST", "/api/agent/pause");
    expect((await req(port, "GET", "/api/status")).data.state).toBe("paused");

    await req(port, "POST", "/api/agent/resume");
    expect((await req(port, "GET", "/api/status")).data.state).toBe("running");

    await req(port, "POST", "/api/agent/stop");
    expect((await req(port, "GET", "/api/status")).data.state).toBe("stopped");

    await req(port, "POST", "/api/agent/start");
    expect((await req(port, "GET", "/api/status")).data.state).toBe("running");

    await req(port, "POST", "/api/agent/stop");
  });

  // -- Auxiliary endpoints --

  it.each([
    ["GET /api/plugins", "plugins"],
    ["GET /api/skills", "skills"],
    ["GET /api/logs", "entries"],
  ])("%s returns array", async (route, key) => {
    const [method, path] = route.split(" ");
    const { status, data } = await req(port, method, path);
    expect(status).toBe(200);
    expect(Array.isArray(data[key])).toBe(true);
  });

  it("onboarding status returns complete flag", async () => {
    expect(typeof (await req(port, "GET", "/api/onboarding/status")).data.complete).toBe("boolean");
  });

  it("onboarding options returns names, styles, providers", async () => {
    const { data } = await req(port, "GET", "/api/onboarding/options");
    expect(Array.isArray(data.names)).toBe(true);
    expect(Array.isArray(data.styles)).toBe(true);
    expect(Array.isArray(data.providers)).toBe(true);
  });

  it("unknown route returns 404", async () => {
    expect((await req(port, "GET", "/api/nonexistent")).status).toBe(404);
  });
});
