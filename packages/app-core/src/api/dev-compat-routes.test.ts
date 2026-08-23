/**
 * Unit tests for `handleDevCompatRoutes`, the loopback-only `/api/dev/*`
 * dispatcher. Fake IncomingMessage/ServerResponse objects drive the real
 * handler: pass-through, production 404, loopback/auth gates, stack port
 * override, screenshot SSRF/proxy, console-log tail, query-integer 400s,
 * inference-timing log rehydration, and boot-history/health aliases.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Log } from "@elizaos/core";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";

const authMocks = vi.hoisted(() => ({
  ensureRouteAuthorized: vi.fn(async () => true),
}));

vi.mock("./auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth.ts")>();
  return {
    ...actual,
    ensureRouteAuthorized: authMocks.ensureRouteAuthorized,
  };
});

vi.mock("./auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth")>();
  return {
    ...actual,
    ensureRouteAuthorized: authMocks.ensureRouteAuthorized,
  };
});

vi.mock("@elizaos/agent", () => ({
  loadElizaConfig: () => ({ meta: {}, agents: {} }),
  getLastFailedPluginDetails: () => [],
}));

import {
  formatScreenshotErrorDetail,
  handleDevCompatRoutes,
} from "./dev-compat-routes";

const VALID_TRACE_ID = "0123456789abcdef0123456789abcdef";

const STATE: CompatRuntimeState = {
  current: null,
  pendingAgentName: null,
  pendingRestartReasons: [],
};

interface Captured {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

function makeReqRes(opts: {
  url?: string | undefined;
  method?: string | undefined;
  remoteAddress?: string | undefined;
  localPort?: number | string | undefined;
}): {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  captured: Captured;
} {
  const captured: Captured = {};
  const req = {
    method: opts.method,
    url: opts.url,
    headers: {},
    socket: {
      remoteAddress: Object.hasOwn(opts, "remoteAddress")
        ? opts.remoteAddress
        : "127.0.0.1",
      localPort: opts.localPort,
    },
  } as unknown as http.IncomingMessage;
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader() {},
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      captured.headers = headers;
      return res;
    },
    end(body?: string | Buffer) {
      if (body !== undefined) captured.body = body;
      captured.status ??= res.statusCode;
    },
  } as unknown as http.ServerResponse & { statusCode: number };
  return { req, res, captured };
}

function jsonBody(captured: Captured): Record<string, unknown> {
  expect(typeof captured.body).toBe("string");
  return JSON.parse(String(captured.body ?? "{}")) as Record<string, unknown>;
}

function timingLog(body: unknown): Log {
  return {
    type: "inference_timing",
    entityId: "00000000-0000-0000-0000-000000000001",
    roomId: "00000000-0000-0000-0000-000000000002",
    createdAt: new Date(),
    body,
  } as Log;
}

function validTimingBody(
  overrides: Record<string, unknown> = {},
  metadataOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    runId: "turn-valid",
    startTime: 1_000,
    endTime: 1_160,
    duration: 160,
    roomId: "room-valid",
    metadata: {
      label: "chat-request",
      traceId: VALID_TRACE_ID,
      modelProvider: "openai",
      timeToFirstTokenMs: 90,
      spans: [
        {
          name: "model:TEXT_LARGE",
          startMs: 20,
          endMs: 140,
          durationMs: 120,
          meta: {
            outcome: "success",
            tokens: 12,
            cached: true,
            nested: { drop: true },
            skip: null,
          },
        },
        { name: "incomplete" },
        "not-a-span",
      ],
      marks: [
        { name: "first-model-token", tMs: 90 },
        { name: "missing-time" },
        { tMs: 4 },
      ],
      byName: {
        "model:TEXT_LARGE": { totalMs: 120, count: 1 },
        incomplete: { totalMs: 5 },
        badCount: { totalMs: 5, count: Number.NaN },
      },
      anomalies: ["slow", 1, null, "retry"],
      ...metadataOverrides,
    },
    ...overrides,
  };
}

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  ELIZA_ELECTROBUN_SCREENSHOT_URL: process.env.ELIZA_ELECTROBUN_SCREENSHOT_URL,
  ELIZA_SCREENSHOT_SERVER_TOKEN: process.env.ELIZA_SCREENSHOT_SERVER_TOKEN,
  ELIZA_DESKTOP_DEV_LOG_PATH: process.env.ELIZA_DESKTOP_DEV_LOG_PATH,
  ELIZA_STATE_DIR: process.env.ELIZA_STATE_DIR,
};

let stateDir: string;

beforeEach(() => {
  authMocks.ensureRouteAuthorized.mockReset();
  authMocks.ensureRouteAuthorized.mockResolvedValue(true);
  delete process.env.NODE_ENV;
  delete process.env.ELIZA_ELECTROBUN_SCREENSHOT_URL;
  delete process.env.ELIZA_SCREENSHOT_SERVER_TOKEN;
  delete process.env.ELIZA_DESKTOP_DEV_LOG_PATH;
  stateDir = mkdtempSync(join(tmpdir(), "dev-compat-routes-"));
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

const DEV_ROUTES = [
  "/api/dev/stack",
  "/api/dev/route-catalog",
  "/api/dev/cursor-screenshot",
  "/api/dev/console-log",
  "/api/dev/voice-latency",
  "/api/dev/device-resource-metrics",
  "/api/dev/inference-timing",
  "/api/dev/boot-history",
  "/api/dev/health",
  "/api/dev/route-timings",
] as const;

describe("handleDevCompatRoutes dispatch", () => {
  it("returns false for paths outside /api/dev/", async () => {
    const missingUrl = makeReqRes({ url: undefined, method: "GET" });
    await expect(
      handleDevCompatRoutes(missingUrl.req, missingUrl.res, STATE),
    ).resolves.toBe(false);
    expect(missingUrl.captured.status).toBeUndefined();

    const ordinary = makeReqRes({ url: "/api/agents", method: "GET" });
    await expect(
      handleDevCompatRoutes(ordinary.req, ordinary.res, STATE),
    ).resolves.toBe(false);
  });

  it("returns false for unknown /api/dev paths and non-GET methods in non-production", async () => {
    const unknown = makeReqRes({ url: "/api/dev/not-a-route", method: "GET" });
    await expect(
      handleDevCompatRoutes(unknown.req, unknown.res, STATE),
    ).resolves.toBe(false);

    const posted = makeReqRes({ url: "/api/dev/stack", method: "POST" });
    await expect(
      handleDevCompatRoutes(posted.req, posted.res, STATE),
    ).resolves.toBe(false);
    expect(posted.captured.status).toBeUndefined();
  });

  it("claims every /api/dev path with 404 when NODE_ENV is production", async () => {
    process.env.NODE_ENV = "production";
    const known = makeReqRes({ url: "/api/dev/stack", method: "GET" });
    await expect(
      handleDevCompatRoutes(known.req, known.res, STATE),
    ).resolves.toBe(true);
    expect(known.captured.status).toBe(404);
    expect(jsonBody(known.captured)).toEqual({ error: "Not found" });

    const unknown = makeReqRes({ url: "/api/dev/not-a-route", method: "GET" });
    await expect(
      handleDevCompatRoutes(unknown.req, unknown.res, STATE),
    ).resolves.toBe(true);
    expect(unknown.captured.status).toBe(404);

    const outside = makeReqRes({ url: "/api/agents", method: "GET" });
    await expect(
      handleDevCompatRoutes(outside.req, outside.res, STATE),
    ).resolves.toBe(false);
  });

  it("treats a missing method as GET", async () => {
    const { req, res, captured } = makeReqRes({
      url: "/api/dev/stack",
      method: undefined,
      localPort: 42424,
    });
    await expect(handleDevCompatRoutes(req, res, STATE)).resolves.toBe(true);
    expect(captured.status).toBe(200);
    expect(jsonBody(captured)).toMatchObject({
      api: { listenPort: 42424, baseUrl: "http://127.0.0.1:42424" },
    });
  });

  it.each(DEV_ROUTES)("rejects a non-loopback caller on %s", async (url) => {
    const { req, res, captured } = makeReqRes({
      url,
      method: "GET",
      remoteAddress: "10.0.0.8",
    });
    await expect(handleDevCompatRoutes(req, res, STATE)).resolves.toBe(true);
    expect(captured.status).toBe(403);
    expect(jsonBody(captured)).toEqual({ error: "loopback only" });
    expect(authMocks.ensureRouteAuthorized).not.toHaveBeenCalled();
  });

  it("rejects a missing or hostname remote address as non-loopback", async () => {
    const missing = makeReqRes({
      url: "/api/dev/stack",
      method: "GET",
      remoteAddress: undefined,
    });
    await expect(
      handleDevCompatRoutes(missing.req, missing.res, STATE),
    ).resolves.toBe(true);
    expect(missing.captured.status).toBe(403);

    const hostname = makeReqRes({
      url: "/api/dev/stack",
      method: "GET",
      remoteAddress: "localhost",
    });
    await expect(
      handleDevCompatRoutes(hostname.req, hostname.res, STATE),
    ).resolves.toBe(true);
    expect(hostname.captured.status).toBe(403);
  });

  it("admits IPv6 and IPv4-mapped loopback peers", async () => {
    for (const remoteAddress of ["::1", "::ffff:127.0.0.1"]) {
      const { req, res, captured } = makeReqRes({
        url: "/api/dev/route-timings",
        method: "get",
        remoteAddress,
      });
      await expect(handleDevCompatRoutes(req, res, STATE)).resolves.toBe(true);
      expect(captured.status).toBe(200);
    }
  });

  it("stops after a failed authorization gate without sending a payload", async () => {
    authMocks.ensureRouteAuthorized.mockResolvedValue(false);
    const { req, res, captured } = makeReqRes({
      url: "/api/dev/stack",
      method: "GET",
      localPort: 31337,
    });
    await expect(handleDevCompatRoutes(req, res, STATE)).resolves.toBe(true);
    expect(captured.status).toBeUndefined();
    expect(captured.body).toBeUndefined();
  });
});

describe("GET /api/dev/stack", () => {
  it("overrides listenPort only for a positive numeric localPort", async () => {
    const overridden = makeReqRes({
      url: "/api/dev/stack",
      method: "GET",
      localPort: 31337,
    });
    await handleDevCompatRoutes(overridden.req, overridden.res, STATE);
    expect(jsonBody(overridden.captured)).toMatchObject({
      schema: "elizaos.dev.stack/v1",
      api: { listenPort: 31337, baseUrl: "http://127.0.0.1:31337" },
    });

    const zero = makeReqRes({
      url: "/api/dev/stack",
      method: "GET",
      localPort: 0,
    });
    await handleDevCompatRoutes(zero.req, zero.res, STATE);
    const zeroPayload = jsonBody(zero.captured);
    expect((zeroPayload.api as { listenPort: number }).listenPort).not.toBe(0);

    const missing = makeReqRes({
      url: "/api/dev/stack",
      method: "GET",
      localPort: undefined,
    });
    await handleDevCompatRoutes(missing.req, missing.res, STATE);
    expect(jsonBody(missing.captured).api).toEqual(zeroPayload.api);
  });
});

describe("GET /api/dev/route-catalog", () => {
  it("returns the versioned catalog from the real builder", async () => {
    const { req, res, captured } = makeReqRes({
      url: "/api/dev/route-catalog",
      method: "GET",
    });
    await expect(handleDevCompatRoutes(req, res, STATE)).resolves.toBe(true);
    expect(captured.status).toBe(200);
    const payload = jsonBody(captured);
    expect(payload.schemaVersion).toBe(1);
    expect(Array.isArray(payload.routes)).toBe(true);
    expect((payload.routes as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("formatScreenshotErrorDetail", () => {
  it("returns short well-formed text unchanged", () => {
    expect(formatScreenshotErrorDetail("")).toBe("");
    expect(formatScreenshotErrorDetail("upstream 404")).toBe("upstream 404");
    expect(formatScreenshotErrorDetail("x".repeat(200))).toBe("x".repeat(200));
  });

  it("truncates to 200 code units without splitting a surrogate pair", () => {
    expect(formatScreenshotErrorDetail("x".repeat(250))).toBe("x".repeat(200));
    // 199 ASCII + one emoji (2 code units) is 201 units; the cut backs off
    // rather than emitting a dangling high surrogate.
    expect(formatScreenshotErrorDetail(`${"x".repeat(199)}😀`)).toBe(
      "x".repeat(199),
    );
  });

  it("replaces a lone surrogate before truncating", () => {
    expect(formatScreenshotErrorDetail("\uD800")).toBe("\uFFFD");
  });
});

describe("GET /api/dev/cursor-screenshot", () => {
  it("reports a disabled screenshot server without fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    process.env.ELIZA_ELECTROBUN_SCREENSHOT_URL = "   ";
    const { req, res, captured } = makeReqRes({
      url: "/api/dev/cursor-screenshot",
      method: "GET",
    });
    await expect(handleDevCompatRoutes(req, res, STATE)).resolves.toBe(true);
    expect(captured.status).toBe(404);
    expect(jsonBody(captured).error).toBe(
      "desktop screenshot server not enabled",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a malformed screenshot upstream URL", async () => {
    process.env.ELIZA_ELECTROBUN_SCREENSHOT_URL = "not a URL";
    const { req, res, captured } = makeReqRes({
      url: "/api/dev/cursor-screenshot",
      method: "GET",
    });
    await handleDevCompatRoutes(req, res, STATE);
    expect(captured.status).toBe(400);
    expect(jsonBody(captured)).toEqual({
      error: "invalid screenshot upstream URL",
    });
  });

  it("rejects a non-loopback screenshot upstream as SSRF", async () => {
    process.env.ELIZA_ELECTROBUN_SCREENSHOT_URL = "https://example.com/shot";
    const { req, res, captured } = makeReqRes({
      url: "/api/dev/cursor-screenshot",
      method: "GET",
    });
    await handleDevCompatRoutes(req, res, STATE);
    expect(captured.status).toBe(403);
    expect(jsonBody(captured)).toEqual({
      error: "screenshot upstream must be loopback",
    });
  });

  it("proxies a PNG from a loopback upstream and forwards a bearer token", async () => {
    process.env.ELIZA_ELECTROBUN_SCREENSHOT_URL = "http://127.0.0.1:9/";
    process.env.ELIZA_SCREENSHOT_SERVER_TOKEN = "  secret  ";
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    } as unknown as Response);

    const { req, res, captured } = makeReqRes({
      url: "/api/dev/cursor-screenshot",
      method: "GET",
    });
    await expect(handleDevCompatRoutes(req, res, STATE)).resolves.toBe(true);

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:9/cursor-screenshot.png",
      {
        headers: { Authorization: "Bearer secret" },
        redirect: "error",
      },
    );
    expect(captured.status).toBe(200);
    expect(captured.headers).toEqual({
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
    });
    expect(Buffer.isBuffer(captured.body)).toBe(true);
    expect(captured.body).toEqual(png);
  });

  it("accepts localhost and IPv6 loopback upstream hosts without a token header", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response);

    process.env.ELIZA_ELECTROBUN_SCREENSHOT_URL = "http://localhost:9";
    await handleDevCompatRoutes(
      ...(() => {
        const { req, res } = makeReqRes({
          url: "/api/dev/cursor-screenshot",
          method: "GET",
        });
        return [req, res, STATE] as const;
      })(),
    );
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "http://localhost:9/cursor-screenshot.png",
    );
    expect(fetchSpy.mock.calls[0]?.[1]).toEqual({
      headers: {},
      redirect: "error",
    });

    process.env.ELIZA_ELECTROBUN_SCREENSHOT_URL = "http://[::1]:9";
    await handleDevCompatRoutes(
      ...(() => {
        const { req, res } = makeReqRes({
          url: "/api/dev/cursor-screenshot",
          method: "GET",
        });
        return [req, res, STATE] as const;
      })(),
    );
    expect(fetchSpy.mock.calls[1]?.[0]).toBe(
      "http://[::1]:9/cursor-screenshot.png",
    );
  });

  it("maps 401/403 upstream failures to the same status and other failures to 502", async () => {
    process.env.ELIZA_ELECTROBUN_SCREENSHOT_URL = "http://127.0.0.1:9";
    const longDetail = "x".repeat(250);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => longDetail,
    } as unknown as Response);
    const unauthorized = makeReqRes({
      url: "/api/dev/cursor-screenshot",
      method: "GET",
    });
    await handleDevCompatRoutes(unauthorized.req, unauthorized.res, STATE);
    expect(unauthorized.captured.status).toBe(401);
    expect(jsonBody(unauthorized.captured)).toEqual({
      error: "upstream screenshot failed",
      status: 401,
      detail: "x".repeat(200),
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => {
        throw new Error("no body");
      },
    } as unknown as Response);
    const forbidden = makeReqRes({
      url: "/api/dev/cursor-screenshot",
      method: "GET",
    });
    await handleDevCompatRoutes(forbidden.req, forbidden.res, STATE);
    expect(forbidden.captured.status).toBe(403);
    expect(jsonBody(forbidden.captured)).toEqual({
      error: "upstream screenshot failed",
      status: 403,
      detail: "",
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "boom",
    } as unknown as Response);
    const failed = makeReqRes({
      url: "/api/dev/cursor-screenshot",
      method: "GET",
    });
    await handleDevCompatRoutes(failed.req, failed.res, STATE);
    expect(failed.captured.status).toBe(502);
    expect(jsonBody(failed.captured)).toMatchObject({
      error: "upstream screenshot failed",
      status: 500,
      detail: "boom",
    });
  });

  it("returns 502 when the screenshot proxy fetch throws", async () => {
    process.env.ELIZA_ELECTROBUN_SCREENSHOT_URL = "http://127.0.0.1:9";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const { req, res, captured } = makeReqRes({
      url: "/api/dev/cursor-screenshot",
      method: "GET",
    });
    await expect(handleDevCompatRoutes(req, res, STATE)).resolves.toBe(true);
    expect(captured.status).toBe(502);
    expect(jsonBody(captured)).toEqual({ error: "screenshot proxy error" });
  });
});

describe("GET /api/dev/console-log", () => {
  it("returns 404 when the desktop log path is missing or not allow-listed", async () => {
    const missing = makeReqRes({ url: "/api/dev/console-log", method: "GET" });
    await handleDevCompatRoutes(missing.req, missing.res, STATE);
    expect(missing.captured.status).toBe(404);
    expect(jsonBody(missing.captured).error).toBe(
      "desktop dev log not configured",
    );

    process.env.ELIZA_DESKTOP_DEV_LOG_PATH = join(stateDir, "secrets.log");
    const disallowed = makeReqRes({
      url: "/api/dev/console-log",
      method: "GET",
    });
    await handleDevCompatRoutes(disallowed.req, disallowed.res, STATE);
    expect(disallowed.captured.status).toBe(404);
    expect(jsonBody(disallowed.captured).error).toBe(
      "desktop dev log not configured",
    );
  });

  it("returns 400 for non-canonical maxLines or maxBytes before reading the file", async () => {
    const logPath = join(stateDir, "desktop-dev-console.log");
    writeFileSync(logPath, "kept\n");
    process.env.ELIZA_DESKTOP_DEV_LOG_PATH = logPath;

    const badLines = makeReqRes({
      url: "/api/dev/console-log?maxLines=007",
      method: "GET",
    });
    await handleDevCompatRoutes(badLines.req, badLines.res, STATE);
    expect(badLines.captured.status).toBe(400);
    expect(jsonBody(badLines.captured).error).toEqual(
      expect.stringContaining("canonical positive integer"),
    );

    const badBytes = makeReqRes({
      url: "/api/dev/console-log?maxBytes=1e2",
      method: "GET",
    });
    await handleDevCompatRoutes(badBytes.req, badBytes.res, STATE);
    expect(badBytes.captured.status).toBe(400);
  });

  it("returns 404 when the allow-listed log file is absent", async () => {
    process.env.ELIZA_DESKTOP_DEV_LOG_PATH = join(
      stateDir,
      "desktop-dev-console.log",
    );
    const { req, res, captured } = makeReqRes({
      url: "/api/dev/console-log",
      method: "GET",
    });
    await handleDevCompatRoutes(req, res, STATE);
    expect(captured.status).toBe(404);
    expect(jsonBody(captured)).toEqual({ error: "log file not found" });
  });

  it("returns 404 when the allow-listed path is not a file", async () => {
    const logPath = join(stateDir, "desktop-dev-console.log");
    mkdirSync(logPath);
    process.env.ELIZA_DESKTOP_DEV_LOG_PATH = logPath;
    const { req, res, captured } = makeReqRes({
      url: "/api/dev/console-log",
      method: "GET",
    });
    await handleDevCompatRoutes(req, res, STATE);
    expect(captured.status).toBe(404);
    expect(jsonBody(captured)).toEqual({ error: "not a file" });
  });

  it("tails the real log file as text/plain", async () => {
    const logPath = join(stateDir, "logs", "desktop-dev-console.log");
    mkdirSync(join(stateDir, "logs"));
    writeFileSync(logPath, "alpha\nbeta\ngamma\n");
    process.env.ELIZA_DESKTOP_DEV_LOG_PATH = logPath;

    const { req, res, captured } = makeReqRes({
      url: "/api/dev/console-log?maxLines=2",
      method: "GET",
    });
    await expect(handleDevCompatRoutes(req, res, STATE)).resolves.toBe(true);
    expect(captured.status).toBe(200);
    expect(captured.headers).toEqual({
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    expect(captured.body).toBe("beta\ngamma\n");
  });
});

describe("GET /api/dev/voice-latency and device-resource-metrics", () => {
  it("returns 400 for a non-canonical limit on both routes", async () => {
    for (const url of [
      "/api/dev/voice-latency?limit=0",
      "/api/dev/device-resource-metrics?limit=0x10",
    ]) {
      const { req, res, captured } = makeReqRes({ url, method: "GET" });
      await expect(handleDevCompatRoutes(req, res, STATE)).resolves.toBe(true);
      expect(captured.status).toBe(400);
      expect(jsonBody(captured).error).toEqual(
        expect.stringContaining("canonical positive integer"),
      );
    }
  });

  it("returns the real voice-latency tracer payload", async () => {
    const { req, res, captured } = makeReqRes({
      url: "/api/dev/voice-latency?limit=1",
      method: "GET",
    });
    await expect(handleDevCompatRoutes(req, res, STATE)).resolves.toBe(true);
    expect(captured.status).toBe(200);
    const payload = jsonBody(captured);
    expect(Array.isArray(payload.traces)).toBe(true);
    expect(Array.isArray(payload.checkpoints)).toBe(true);
  });

  it("returns the real device-resource-metrics payload", async () => {
    const { req, res, captured } = makeReqRes({
      url: "/api/dev/device-resource-metrics?limit=1",
      method: "GET",
    });
    await expect(handleDevCompatRoutes(req, res, STATE)).resolves.toBe(true);
    expect(captured.status).toBe(200);
    const payload = jsonBody(captured);
    expect(payload).toEqual(
      expect.objectContaining({
        status: expect.anything(),
        recentGenerations: expect.any(Array),
      }),
    );
    expect(typeof payload.generatedAtEpochMs).toBe("number");
  });
});

describe("GET /api/dev/inference-timing", () => {
  it("returns 400 for a non-canonical limit", async () => {
    const { req, res, captured } = makeReqRes({
      url: "/api/dev/inference-timing?limit=007",
      method: "GET",
    });
    await handleDevCompatRoutes(req, res, STATE);
    expect(captured.status).toBe(400);
  });

  it("returns 200 with an empty persisted set when no runtime is bound", async () => {
    const { req, res, captured } = makeReqRes({
      url: "/api/dev/inference-timing?limit=1",
      method: "GET",
    });
    await expect(handleDevCompatRoutes(req, res, STATE)).resolves.toBe(true);
    expect(captured.status).toBe(200);
    expect(Array.isArray(jsonBody(captured).turns)).toBe(true);
  });

  it("rehydrates a valid persisted log and drops incomplete ones", async () => {
    const logs: Log[] = [
      timingLog(validTimingBody()),
      timingLog(null),
      timingLog(["not-an-object"]),
      timingLog({
        runId: "no-metadata",
        startTime: 1,
        metadata: ["nope"],
      }),
      timingLog({
        runId: 12,
        startTime: 1,
        metadata: { label: "chat-request" },
      }),
      timingLog({
        runId: "no-start",
        startTime: Number.NaN,
        metadata: { label: "chat-request" },
      }),
      timingLog({
        runId: "no-label",
        startTime: 1,
        metadata: { label: 4 },
      }),
      timingLog({
        runId: "sparse-optional",
        startTime: 2_000,
        endTime: Number.POSITIVE_INFINITY,
        duration: "160",
        roomId: 99,
        metadata: {
          label: "chat-request",
          traceId: "not-a-trace",
          modelProvider: 3,
          spans: "nope",
          marks: "nope",
          byName: "nope",
          anomalies: "nope",
        },
      }),
    ];
    const state: CompatRuntimeState = {
      current: {
        getLogs: async () => logs,
      } as unknown as CompatRuntimeState["current"],
      pendingAgentName: null,
      pendingRestartReasons: [],
    };

    const { req, res, captured } = makeReqRes({
      url: "/api/dev/inference-timing?limit=50",
      method: "GET",
    });
    await expect(handleDevCompatRoutes(req, res, state)).resolves.toBe(true);
    expect(captured.status).toBe(200);

    const turns = jsonBody(captured).turns as Array<Record<string, unknown>>;
    const valid = turns.find((turn) => turn.turnId === "turn-valid");
    expect(valid).toMatchObject({
      turnId: "turn-valid",
      traceId: VALID_TRACE_ID,
      label: "chat-request",
      roomId: "room-valid",
      modelProvider: "openai",
      t0EpochMs: 1_000,
      closedAtEpochMs: 1_160,
      totalMs: 160,
      timeToFirstTokenMs: 90,
      anomalies: ["slow", "retry"],
    });
    expect(valid?.spans).toEqual([
      {
        name: "model:TEXT_LARGE",
        startMs: 20,
        endMs: 140,
        durationMs: 120,
        meta: { outcome: "success", tokens: 12, cached: true },
      },
    ]);
    expect(valid?.marks).toEqual([{ name: "first-model-token", tMs: 90 }]);
    expect(valid?.byName).toEqual({
      "model:TEXT_LARGE": { totalMs: 120, count: 1 },
    });

    const sparse = turns.find((turn) => turn.turnId === "sparse-optional");
    expect(sparse).toMatchObject({
      turnId: "sparse-optional",
      traceId: null,
      roomId: null,
      modelProvider: null,
      closedAtEpochMs: null,
      totalMs: null,
      spans: [],
      marks: [],
      byName: {},
      anomalies: [],
    });

    expect(turns.some((turn) => turn.turnId === "no-metadata")).toBe(false);
    expect(turns.some((turn) => turn.turnId === "no-start")).toBe(false);
    expect(turns.some((turn) => turn.turnId === "no-label")).toBe(false);
  });
});

describe("GET /api/dev/boot-history and /api/dev/health", () => {
  it("serves the same boot-history payload on the health alias", async () => {
    const history = makeReqRes({ url: "/api/dev/boot-history", method: "GET" });
    const health = makeReqRes({ url: "/api/dev/health", method: "GET" });

    await expect(
      handleDevCompatRoutes(history.req, history.res, STATE),
    ).resolves.toBe(true);
    await expect(
      handleDevCompatRoutes(health.req, health.res, STATE),
    ).resolves.toBe(true);

    expect(history.captured.status).toBe(200);
    expect(health.captured.status).toBe(200);
    const historyPayload = jsonBody(history.captured);
    const healthPayload = jsonBody(health.captured);
    expect(historyPayload.schema).toBe("elizaos.dev.boot-history/v1");
    expect(healthPayload.schema).toBe(historyPayload.schema);
    expect(Array.isArray(historyPayload.failedPlugins)).toBe(true);
    expect(Object.hasOwn(historyPayload, "latestBoot")).toBe(true);
  });
});

describe("GET /api/dev/route-timings", () => {
  it("returns the live perf snapshot", async () => {
    const { req, res, captured } = makeReqRes({
      url: "/api/dev/route-timings",
      method: "GET",
    });
    await expect(handleDevCompatRoutes(req, res, STATE)).resolves.toBe(true);
    expect(captured.status).toBe(200);
    const payload = jsonBody(captured);
    expect(typeof payload.enabled).toBe("boolean");
    expect(Array.isArray(payload.routes)).toBe(true);
    expect(Array.isArray(payload.caches)).toBe(true);
  });
});
