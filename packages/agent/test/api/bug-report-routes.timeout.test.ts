/**
 * Bug report fetch deadlines — proves remote and GitHub intake abort on
 * timeout, covers stalled headers and stalled bodies with a real hanging
 * server, and pins the documented budget. All remote-intake paths are
 * exercised through the owning route handler so the timeout translation into
 * a structured 502 response is validated at the route boundary.
 */

import { EventEmitter } from "node:events";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUG_REPORT_REPO_ENV_KEY,
  DEFAULT_BUG_REPORT_FETCH_TIMEOUT_MS,
  handleBugReportRoutes,
  resetBugReportRateLimit,
} from "../../src/api/bug-report-routes.ts";

type BugReportRouteContext = Parameters<typeof handleBugReportRoutes>[0];

const validBugReport = {
  description: "The agent fails to start",
  stepsToReproduce: "Run the agent",
};

function createContext(
  body: Record<string, unknown> = validBugReport,
  ip = "127.0.0.1",
): BugReportRouteContext & { responseBody?: unknown; responseStatus?: number } {
  const req = Object.assign(new EventEmitter(), {
    socket: { remoteAddress: ip },
  }) as unknown as import("node:http").IncomingMessage;
  const res = {} as import("node:http").ServerResponse;
  const ctx = {
    req,
    res,
    method: "POST",
    pathname: "/api/bug-report",
    readJsonBody: vi.fn(async () => body),
    json: vi.fn(
      (
        _res: import("node:http").ServerResponse,
        responseBody: unknown,
        status = 200,
      ) => {
        (ctx as unknown as { responseBody: unknown }).responseBody =
          responseBody;
        (ctx as unknown as { responseStatus: number }).responseStatus = status;
      },
    ),
    error: vi.fn(
      (
        _res: import("node:http").ServerResponse,
        message: string,
        status = 500,
      ) => {
        (ctx as unknown as { responseBody: unknown }).responseBody = {
          error: message,
        };
        (ctx as unknown as { responseStatus: number }).responseStatus = status;
      },
    ),
  } as unknown as BugReportRouteContext & {
    responseBody?: unknown;
    responseStatus?: number;
  };
  return ctx;
}

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      if (!signal) throw new Error("expected bug-report abort signal");
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
}

describe("bug report fetch timeout", () => {
  let originalTimeout: typeof AbortSignal.timeout;

  beforeEach(() => {
    originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    resetBugReportRateLimit();
    vi.stubEnv(BUG_REPORT_REPO_ENV_KEY, "");
    vi.stubEnv("BUG_REPORT_REPO", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("ELIZA_BUG_REPORT_API_URL", "");
    vi.stubEnv("ELIZA_BUG_REPORT_API_TOKEN", "");
  });

  afterEach(async () => {
    resetBugReportRateLimit();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("exposes the documented ten-second budget", () => {
    expect(DEFAULT_BUG_REPORT_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("aborts a stalled remote intake at the deadline (hanging fetch) via route", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      originalTimeout(10),
    );
    vi.stubGlobal("fetch", stallUntilAborted());
    vi.stubEnv(
      "ELIZA_BUG_REPORT_API_URL",
      "https://intake.example.test/reports",
    );

    const ctx = createContext();
    await handleBugReportRoutes(ctx);

    expect(ctx.responseStatus).toBe(502);
    expect((ctx.responseBody as { error?: string })?.error).toBe(
      "Failed to submit bug report",
    );
  });

  it("aborts a stalled GitHub intake at the deadline (hanging fetch via route)", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      originalTimeout(10),
    );
    const fetchMock = vi.fn(stallUntilAborted());
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    vi.stubEnv("GITHUB_TOKEN", "test-token-not-a-credential");

    const ctx = createContext();
    await handleBugReportRoutes(ctx);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("api.github.com"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(ctx.responseStatus).toBe(502);
    expect((ctx.responseBody as { error?: string })?.error).toBe(
      "Failed to create GitHub issue",
    );
  });

  it("keeps the deadline armed while the response body stalls (real server) via route", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"accepted":true,');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/reports`;

    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      originalTimeout(10),
    );
    vi.stubEnv("ELIZA_BUG_REPORT_API_URL", url);
    const ctx = createContext();
    try {
      await handleBugReportRoutes(ctx);
      expect(ctx.responseStatus).toBe(502);
      expect((ctx.responseBody as { error?: string })?.error).toBe(
        "Failed to submit bug report",
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("succeeds on a fast remote upstream (via route) and passes the abort signal", async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.signal) signals.push(init.signal as AbortSignal);
        return new Response(
          JSON.stringify({
            accepted: true,
            id: "report-1",
            url: "https://intake.example.test/reports/report-1",
          }),
          { status: 202, headers: { "content-type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    vi.stubEnv(
      "ELIZA_BUG_REPORT_API_URL",
      "https://intake.example.test/reports",
    );
    vi.stubEnv("ELIZA_BUG_REPORT_API_TOKEN", "remote-test-token");

    const ctx = createContext();
    await handleBugReportRoutes(ctx);

    expect(ctx.responseBody).toEqual({
      accepted: true,
      id: "report-1",
      url: "https://intake.example.test/reports/report-1",
      destination: "remote",
    });
    expect(ctx.responseStatus).toBe(200);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(ctx.req.listenerCount("aborted")).toBe(0);
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("succeeds for GitHub intake on a fast upstream", async () => {
    vi.stubEnv("GITHUB_TOKEN", "test-token-not-a-credential");
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            html_url: "https://github.com/elizaOS/eliza/issues/123",
          }),
          {
            status: 201,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const ctx = createContext();
    await handleBugReportRoutes(ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    expect(ctx.req.listenerCount("aborted")).toBe(0);
    expect(ctx.responseBody).toEqual({
      url: "https://github.com/elizaOS/eliza/issues/123",
    });
    expect(ctx.responseStatus).toBe(200);
  });

  it("aborts remote intake when the client request disconnects and removes the listener", async () => {
    let outboundSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          outboundSignal = init?.signal as AbortSignal | undefined;
          outboundSignal?.addEventListener(
            "abort",
            () => reject(outboundSignal?.reason),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    vi.stubEnv(
      "ELIZA_BUG_REPORT_API_URL",
      "https://intake.example.test/reports",
    );

    const ctx = createContext();
    const pending = handleBugReportRoutes(ctx);
    await vi.waitFor(() => expect(outboundSignal).toBeDefined());
    expect(ctx.req.listenerCount("aborted")).toBe(1);

    ctx.req.emit("aborted");
    await pending;

    expect(outboundSignal?.aborted).toBe(true);
    expect(outboundSignal?.reason).toMatchObject({ name: "AbortError" });
    expect(ctx.responseStatus).toBe(502);
    expect(ctx.req.listenerCount("aborted")).toBe(0);
  });

  it("starts remote intake already aborted when the client disconnected while its body was read", async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      return Promise.reject(signal.reason);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    vi.stubEnv(
      "ELIZA_BUG_REPORT_API_URL",
      "https://intake.example.test/reports",
    );

    const ctx = createContext();
    Object.defineProperty(ctx.req, "aborted", { value: true });
    await handleBugReportRoutes(ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[0]?.reason).toMatchObject({ name: "AbortError" });
    expect(ctx.responseStatus).toBe(502);
    expect(ctx.req.listenerCount("aborted")).toBe(0);
  });
});
