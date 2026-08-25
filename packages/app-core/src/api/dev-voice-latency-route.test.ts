/**
 * Route test for GET /api/dev/voice-latency via handleDevCompatRoutes, driving
 * the real voiceLatencyTracer from @elizaos/plugin-local-inference: asserts the
 * traces + histograms + metadata payload, ?limit= truncation (newest last),
 * loopback-only rejection, and prod-disabled behavior.
 */
import { Socket } from "node:net";
import {
  AgentRuntime,
  INFERENCE_TRACE_ID_PATTERN,
  InferenceTurnTimer,
  type Log,
  persistInferenceTimingSummary,
  type UUID,
} from "@elizaos/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";

vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
  };
});
vi.mock("@elizaos/agent", () => ({
  loadElizaConfig: () => ({ meta: {}, agents: {} }),
}));
vi.mock("@elizaos/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/shared")>();
  return {
    ...actual,
    resolveDesktopApiPort: () => 31337,
    resolveDesktopUiPort: () => 2138,
    isLoopbackBindHost: () => true,
    normalizeFirstRunProviderId: (v: unknown) =>
      typeof v === "string" ? v.trim().toLowerCase() : null,
    resolveDeploymentTargetInConfig: () => ({}),
    resolveServiceRoutingInConfig: () => ({}),
  };
});
vi.mock("./auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth")>();
  return {
    ...actual,
    ensureRouteAuthorized: vi.fn(async () => true),
  };
});
vi.mock("./auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth.ts")>();
  return {
    ...actual,
    ensureRouteAuthorized: vi.fn(async () => true),
  };
});

import { handleDevCompatRoutes } from "./dev-compat-routes";

interface EndToEndLatencyTracer {
  reset(): void;
  beginTurn(input: { roomId: string }): string;
  mark(turnId: string, event: string, at: number): void;
  endTurn(turnId: string): void;
}

let voiceLatencyTracer!: EndToEndLatencyTracer;
beforeAll(async () => {
  const mod = await import("@elizaos/plugin-local-inference/services");
  voiceLatencyTracer = mod.voiceLatencyTracer;
});

// app-core intentionally shares Vitest's module registry across files, so this
// suite must release its routing resolver mocks before a real-module suite runs.
afterAll(() => {
  vi.resetModules();
});

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

describe("GET /api/dev/inference-timing", () => {
  beforeEach(() => {
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  it("rehydrates the full persisted flow including visible and finalized milestones", async () => {
    const runtime = new AgentRuntime({ logLevel: "fatal" });
    const log: Log = {
      type: "inference_timing",
      entityId: runtime.agentId,
      roomId: "00000000-0000-0000-0000-000000000042" as UUID,
      createdAt: new Date(),
      body: {
        runId: "persisted-flow-1",
        source: "inference_timing",
        startTime: 1_000,
        endTime: 1_160,
        duration: 160,
        metadata: {
          label: "chat-request",
          modelProvider: "openai",
          timeToFirstTokenMs: 90,
          timeToFirstVisibleMs: 100,
          timeToReplyMs: 140,
          timeToResponseFinalizedMs: 160,
          spans: [
            {
              name: "provider:KNOWLEDGE",
              startMs: 0,
              endMs: 20,
              durationMs: 20,
              meta: { outcome: "success" },
            },
            {
              name: "model:TEXT_LARGE",
              startMs: 20,
              endMs: 140,
              durationMs: 120,
            },
          ],
          marks: [
            { name: "first-model-token", tMs: 90 },
            { name: "first-visible-reply", tMs: 100 },
            { name: "reply-delivered", tMs: 140 },
            { name: "response-finalized", tMs: 160 },
          ],
          byName: {
            "provider:KNOWLEDGE": { totalMs: 20, count: 1 },
            "model:TEXT_LARGE": { totalMs: 120, count: 1 },
          },
          anomalies: [],
        },
      },
    };
    vi.spyOn(runtime, "getLogs").mockResolvedValue([log]);
    const state: CompatRuntimeState = {
      current: runtime,
      pendingAgentName: null,
      pendingRestartReasons: [],
    };
    const { req, res, captured } = makeReqRes({
      url: "/api/dev/inference-timing?limit=1",
    });

    await expect(handleDevCompatRoutes(req, res, state)).resolves.toBe(true);

    expect(captured.status).toBe(200);
    const payload = JSON.parse(captured.body ?? "{}");
    expect(payload.turns).toHaveLength(1);
    expect(payload.turns[0]).toMatchObject({
      turnId: "persisted-flow-1",
      // Persisted before trace correlation existed: rehydrates as an explicit
      // null rather than a fabricated id.
      traceId: null,
      timeToFirstTokenMs: 90,
      timeToFirstVisibleMs: 100,
      timeToReplyMs: 140,
      timeToResponseFinalizedMs: 160,
    });
    expect(payload.flows[0].stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "providers", totalMs: 20 }),
        expect.objectContaining({ stage: "llm-inference", totalMs: 120 }),
      ]),
    );
    expect(payload.providers[0]).toMatchObject({
      providerName: "KNOWLEDGE",
      successes: 1,
    });
  });

  it("round-trips a real turn's trace id through persistence and rehydration", async () => {
    const runtime = new AgentRuntime({ logLevel: "fatal" });
    const roomId = "00000000-0000-0000-0000-000000000043" as UUID;
    const timer = new InferenceTurnTimer({
      turnId: "trace-roundtrip-1",
      label: "chat-request",
    });
    const created: Array<{ body: unknown }> = [];
    vi.spyOn(runtime, "createLogs").mockImplementation(async (logs) => {
      created.push(...logs);
    });
    await persistInferenceTimingSummary(
      runtime,
      { id: "00000000-0000-0000-0000-0000000000aa" as UUID, roomId } as never,
      timer.close(),
    );
    expect(created).toHaveLength(1);

    vi.spyOn(runtime, "getLogs").mockResolvedValue([
      {
        type: "inference_timing",
        entityId: runtime.agentId,
        roomId,
        createdAt: new Date(),
        body: created[0].body,
      } as Log,
    ]);
    const state: CompatRuntimeState = {
      current: runtime,
      pendingAgentName: null,
      pendingRestartReasons: [],
    };
    const { req, res, captured } = makeReqRes({
      url: "/api/dev/inference-timing?limit=1",
    });

    await expect(handleDevCompatRoutes(req, res, state)).resolves.toBe(true);

    const payload = JSON.parse(captured.body ?? "{}");
    expect(timer.traceId).toMatch(INFERENCE_TRACE_ID_PATTERN);
    expect(payload.turns[0].traceId).toBe(timer.traceId);
  });

  it("rehydrates a malformed persisted trace id as null rather than surfacing it", async () => {
    const runtime = new AgentRuntime({ logLevel: "fatal" });
    vi.spyOn(runtime, "getLogs").mockResolvedValue([
      {
        type: "inference_timing",
        entityId: runtime.agentId,
        roomId: "00000000-0000-0000-0000-000000000044" as UUID,
        createdAt: new Date(),
        body: {
          runId: "trace-malformed-1",
          source: "inference_timing",
          startTime: 1_000,
          endTime: 1_010,
          duration: 10,
          metadata: {
            label: "chat-request",
            traceId: "<script>alert(1)</script>",
            spans: [],
            marks: [],
            byName: {},
            anomalies: [],
          },
        },
      } as Log,
    ]);
    const state: CompatRuntimeState = {
      current: runtime,
      pendingAgentName: null,
      pendingRestartReasons: [],
    };
    const { req, res, captured } = makeReqRes({
      url: "/api/dev/inference-timing?limit=1",
    });

    await expect(handleDevCompatRoutes(req, res, state)).resolves.toBe(true);
    expect(JSON.parse(captured.body ?? "{}").turns[0].traceId).toBeNull();
  });

  it("rejects non-loopback callers before reading persisted telemetry", async () => {
    const { req, res, captured } = makeReqRes({
      url: "/api/dev/inference-timing",
      remoteAddress: "10.0.0.5",
    });

    await expect(handleDevCompatRoutes(req, res, STATE)).resolves.toBe(true);
    expect(captured.status).toBe(403);
  });
});

describe("development compatibility route dispatch", () => {
  beforeEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.ELIZA_ELECTROBUN_SCREENSHOT_URL;
    delete process.env.ELIZA_DESKTOP_DEV_LOG_PATH;
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.ELIZA_ELECTROBUN_SCREENSHOT_URL;
    delete process.env.ELIZA_DESKTOP_DEV_LOG_PATH;
  });

  it("leaves non-dev and unknown dev routes to the next dispatcher", async () => {
    const ordinary = makeReqRes({ url: "/api/agents" });
    const unknown = makeReqRes({ url: "/api/dev/not-a-route" });

    await expect(
      handleDevCompatRoutes(ordinary.req, ordinary.res, STATE),
    ).resolves.toBe(false);
    await expect(
      handleDevCompatRoutes(unknown.req, unknown.res, STATE),
    ).resolves.toBe(false);
  });

  it("returns stack metadata with the actual listening port", async () => {
    const { req, res, captured } = makeReqRes({ url: "/api/dev/stack" });

    await expect(handleDevCompatRoutes(req, res, STATE)).resolves.toBe(true);

    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body ?? "{}")).toMatchObject({
      api: {
        listenPort: 31337,
        baseUrl: "http://127.0.0.1:31337",
      },
    });
  });

  it("rejects a non-loopback stack request", async () => {
    const { req, res, captured } = makeReqRes({
      url: "/api/dev/stack",
      remoteAddress: "10.0.0.8",
    });

    await expect(handleDevCompatRoutes(req, res, STATE)).resolves.toBe(true);
    expect(captured.status).toBe(403);
  });

  it("reports a disabled screenshot server without attempting a fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { req, res, captured } = makeReqRes({
      url: "/api/dev/cursor-screenshot",
    });

    await expect(handleDevCompatRoutes(req, res, STATE)).resolves.toBe(true);

    expect(captured.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("rejects malformed and non-loopback screenshot upstreams", async () => {
    process.env.ELIZA_ELECTROBUN_SCREENSHOT_URL = "not a URL";
    const malformed = makeReqRes({ url: "/api/dev/cursor-screenshot" });
    await handleDevCompatRoutes(malformed.req, malformed.res, STATE);
    expect(malformed.captured.status).toBe(400);

    process.env.ELIZA_ELECTROBUN_SCREENSHOT_URL =
      "https://example.com/screenshot";
    const external = makeReqRes({ url: "/api/dev/cursor-screenshot" });
    await handleDevCompatRoutes(external.req, external.res, STATE);
    expect(external.captured.status).toBe(403);
  });

  it("reports a missing desktop console log explicitly", async () => {
    const { req, res, captured } = makeReqRes({
      url: "/api/dev/console-log?maxLines=10",
    });

    await expect(handleDevCompatRoutes(req, res, STATE)).resolves.toBe(true);

    expect(captured.status).toBe(404);
    expect(JSON.parse(captured.body ?? "{}").error).toBe(
      "desktop dev log not configured",
    );
  });

  it("returns the route-timing instrumentation snapshot", async () => {
    const { req, res, captured } = makeReqRes({
      url: "/api/dev/route-timings",
    });

    await expect(handleDevCompatRoutes(req, res, STATE)).resolves.toBe(true);

    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body ?? "{}")).toHaveProperty("enabled");
  });
});
