/**
 * Bug report fetch deadlines — proves remote and GitHub intake abort on
 * timeout, covers stalled headers and stalled bodies with a real hanging
 * server, and pins the documented budget.
 */
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUG_REPORT_REPO_ENV_KEY,
  DEFAULT_BUG_REPORT_FETCH_TIMEOUT_MS,
  handleBugReportRoutes,
  resetBugReportRateLimit,
  submitToRemoteBugIntake,
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
  const req = {
    socket: { remoteAddress: ip },
  } as unknown as import("node:http").IncomingMessage;
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

  it("aborts a stalled remote intake at the deadline (hanging fetch)", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      originalTimeout(10),
    );
    vi.stubGlobal("fetch", stallUntilAborted());
    vi.stubEnv(
      "ELIZA_BUG_REPORT_API_URL",
      "https://intake.example.test/reports",
    );

    await expect(
      submitToRemoteBugIntake(
        validBugReport as unknown as Parameters<
          typeof submitToRemoteBugIntake
        >[0],
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
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
    expect(ctx.responseStatus).toBe(500);
    expect((ctx.responseBody as { error?: string })?.error).toBe(
      "Failed to create GitHub issue",
    );
  });

  it("keeps the deadline armed while the response body stalls (real server)", async () => {
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
    // Use real fetch for this test (don't stub global fetch) - it will hit the real server
    // Ensure we don't have a fetch mock; the injected timeout will abort the stalled body
    try {
      await expect(
        submitToRemoteBugIntake(
          validBugReport as unknown as Parameters<
            typeof submitToRemoteBugIntake
          >[0],
        ),
      ).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("succeeds on a fast upstream and passes the abort signal", async () => {
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

    const result = await submitToRemoteBugIntake(
      validBugReport as unknown as Parameters<
        typeof submitToRemoteBugIntake
      >[0],
    );

    expect(result).toEqual({
      accepted: true,
      id: "report-1",
      url: "https://intake.example.test/reports/report-1",
      destination: "remote",
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
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
    expect(ctx.responseBody).toEqual({
      url: "https://github.com/elizaOS/eliza/issues/123",
    });
    expect(ctx.responseStatus).toBe(200);
  });
});
