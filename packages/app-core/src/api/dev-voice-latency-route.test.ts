import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";

vi.mock("@elizaos/core", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock("@elizaos/agent", () => ({
  loadElizaConfig: () => ({ meta: {}, agents: {} }),
}));
vi.mock("@elizaos/shared", () => ({
  resolveDesktopApiPort: () => 31337,
  resolveDesktopUiPort: () => 2138,
  isLoopbackBindHost: () => true,
  normalizeOnboardingProviderId: (v: unknown) =>
    typeof v === "string" ? v.trim().toLowerCase() : null,
  resolveDeploymentTargetInConfig: () => ({}),
  resolveServiceRoutingInConfig: () => ({}),
}));
vi.mock("./auth", () => ({
  ensureRouteAuthorized: vi.fn(async () => true),
}));
vi.mock("./auth.ts", () => ({
  ensureRouteAuthorized: vi.fn(async () => true),
}));

import { voiceLatencyTracer } from "../services/local-inference/latency-trace";
import { handleDevCompatRoutes } from "./dev-compat-routes";

/** Minimal fake req/res that captures the JSON body and status. */
function makeReqRes(opts: { url: string; remoteAddress?: string }) {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", {
    value: opts.remoteAddress ?? "127.0.0.1",
    configurable: true,
  });
  Object.defineProperty(socket, "localPort", {
    value: 31337,
    configurable: true,
  });
  const req = {
    method: "GET",
    url: opts.url,
    headers: {},
    socket,
  } as unknown as import("node:http").IncomingMessage;

  const captured: {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
  } = {};
  const res = {
    statusCode: 200,
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      captured.headers = headers;
      return res;
    },
    setHeader() {},
    end(body?: string) {
      if (body !== undefined) captured.body = body;
      captured.status ??= res.statusCode;
    },
  } as unknown as import("node:http").ServerResponse & { statusCode: number };

  return { req, res, captured };
}

const STATE = {} as unknown as CompatRuntimeState;

describe("GET /api/dev/voice-latency", () => {
  beforeEach(() => {
    voiceLatencyTracer.reset();
    delete process.env.NODE_ENV;
  });
  afterEach(() => {
    voiceLatencyTracer.reset();
  });

  it("returns the tracer payload (traces + histograms + metadata)", async () => {
    // Seed one completed turn.
    const turnId = voiceLatencyTracer.beginTurn({ roomId: "roomX" });
    voiceLatencyTracer.mark(turnId, "vad-trigger", 1000);
    voiceLatencyTracer.mark(turnId, "llm-first-token", 1150);
    voiceLatencyTracer.mark(turnId, "tts-first-audio-chunk", 1300);
    voiceLatencyTracer.mark(turnId, "audio-first-played", 1330);
    voiceLatencyTracer.endTurn(turnId);

    const { req, res, captured } = makeReqRes({
      url: "/api/dev/voice-latency",
    });
    const handled = await handleDevCompatRoutes(req, res, STATE);
    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    const payload = JSON.parse(captured.body ?? "{}");
    expect(Array.isArray(payload.checkpoints)).toBe(true);
    expect(payload.checkpoints).toContain("llm-first-token");
    expect(Array.isArray(payload.derivedKeys)).toBe(true);
    expect(payload.traces).toHaveLength(1);
    expect(payload.traces[0].roomId).toBe("roomX");
    expect(payload.traces[0].derived.ttftMs).toBe(150);
    expect(payload.traces[0].derived.ttapMs).toBe(330);
    expect(payload.histograms.ttftMs.count).toBe(1);
    expect(payload.openTurnCount).toBe(0);
  });

  it("honours ?limit=", async () => {
    for (let i = 0; i < 5; i += 1) {
      const turnId = voiceLatencyTracer.beginTurn({ roomId: `r${i}` });
      voiceLatencyTracer.mark(turnId, "vad-trigger", i * 100);
      voiceLatencyTracer.mark(turnId, "llm-first-token", i * 100 + 50);
      voiceLatencyTracer.endTurn(turnId);
    }
    const { req, res, captured } = makeReqRes({
      url: "/api/dev/voice-latency?limit=2",
    });
    await handleDevCompatRoutes(req, res, STATE);
    const payload = JSON.parse(captured.body ?? "{}");
    expect(payload.traces).toHaveLength(2);
    // Newest last.
    expect(payload.traces.map((t: { roomId: string }) => t.roomId)).toEqual([
      "r3",
      "r4",
    ]);
  });

  it("is loopback-only", async () => {
    const { req, res, captured } = makeReqRes({
      url: "/api/dev/voice-latency",
      remoteAddress: "10.0.0.5",
    });
    const handled = await handleDevCompatRoutes(req, res, STATE);
    expect(handled).toBe(true);
    expect(captured.status).toBe(403);
  });

  it("is disabled in production", async () => {
    process.env.NODE_ENV = "production";
    const { req, res, captured } = makeReqRes({
      url: "/api/dev/voice-latency",
    });
    const handled = await handleDevCompatRoutes(req, res, STATE);
    expect(handled).toBe(true);
    expect(captured.status).toBe(404);
  });
});
