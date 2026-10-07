/**
 * Regression guard for POST /api/bug-report remote-intake acceptance: only an
 * explicit intake confirmation may surface as success (real fetch boundary is
 * stubbed; the route contract is exercised for real).
 */
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleBugReportRoutes,
  resetBugReportRateLimit,
} from "./bug-report-routes.ts";

const INTAKE_URL = "https://intake.example.invalid/report";

function bugReportCtx() {
  const listeners = new Map<string, Array<() => void>>();
  return {
    req: {
      aborted: false,
      once: (event: string, fn: () => void) => {
        const current = listeners.get(event) ?? [];
        current.push(fn);
        listeners.set(event, current);
      },
      off: () => {},
      socket: { remoteAddress: "127.0.0.101" },
    } as unknown as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method: "POST",
    pathname: "/api/bug-report",
    json: vi.fn(),
    error: vi.fn(),
    readJsonBody: vi.fn(async () => ({
      description: "App crashes on launch",
      stepsToReproduce: "Open the app and observe",
    })) as never,
  };
}

function stubIntake(response: Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response),
  );
}

beforeEach(() => {
  process.env.ELIZA_BUG_REPORT_API_URL = INTAKE_URL;
  delete process.env.GITHUB_TOKEN;
  resetBugReportRateLimit();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.ELIZA_BUG_REPORT_API_URL;
});

describe("POST /api/bug-report remote intake acceptance", () => {
  it("reports success when the intake explicitly confirms acceptance", async () => {
    const ctx = bugReportCtx();
    stubIntake(
      new Response(JSON.stringify({ accepted: true, id: "abc" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(handleBugReportRoutes(ctx)).resolves.toBe(true);

    expect(ctx.json).toHaveBeenCalledWith(ctx.res, {
      accepted: true,
      id: "abc",
      url: undefined,
      destination: "remote",
    });
    expect(ctx.error).not.toHaveBeenCalled();
  });

  it("answers 502 when the intake omits the acceptance flag", async () => {
    const ctx = bugReportCtx();
    stubIntake(
      new Response(JSON.stringify({ id: "abc" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(handleBugReportRoutes(ctx)).resolves.toBe(true);

    expect(ctx.error).toHaveBeenCalledWith(
      ctx.res,
      "Failed to submit bug report",
      502,
    );
    expect(ctx.json).not.toHaveBeenCalled();
  });

  it("answers 502 when the intake explicitly declines acceptance", async () => {
    const ctx = bugReportCtx();
    stubIntake(
      new Response(JSON.stringify({ accepted: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(handleBugReportRoutes(ctx)).resolves.toBe(true);

    expect(ctx.error).toHaveBeenCalledWith(
      ctx.res,
      "Failed to submit bug report",
      502,
    );
    expect(ctx.json).not.toHaveBeenCalled();
  });

  it("answers 502 when the intake returns a non-JSON body", async () => {
    const ctx = bugReportCtx();
    stubIntake(new Response("ok", { status: 200 }));

    await expect(handleBugReportRoutes(ctx)).resolves.toBe(true);

    expect(ctx.error).toHaveBeenCalledWith(
      ctx.res,
      "Failed to submit bug report",
      502,
    );
    expect(ctx.json).not.toHaveBeenCalled();
  });

  it("answers 502 when the intake request fails", async () => {
    const ctx = bugReportCtx();
    stubIntake(new Response("boom", { status: 500 }));

    await expect(handleBugReportRoutes(ctx)).resolves.toBe(true);

    expect(ctx.error).toHaveBeenCalledWith(
      ctx.res,
      "Failed to submit bug report",
      502,
    );
    expect(ctx.json).not.toHaveBeenCalled();
  });
});

describe("POST /api/bug-report GitHub URL authority", () => {
  it.each([
    ["https://github.com/elizaOS/Eliza/issues/123", true],
    ["https://github.com/other/eliza/issues/123", false],
    ["https://github.com/elizaOS/another/issues/123", false],
    ["https://github.com.evil.invalid/elizaOS/eliza/issues/123", false],
  ])("validates returned URL %s", async (url, accepted) => {
    vi.stubEnv("ELIZA_BUG_REPORT_API_URL", "");
    vi.stubEnv("GITHUB_TOKEN", "fixture-github-token");
    vi.stubEnv("ELIZA_BUG_REPORT_REPO", "ElizaOS/eliza");
    try {
      const ctx = bugReportCtx();
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ html_url: url }), { status: 201 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      await expect(handleBugReportRoutes(ctx)).resolves.toBe(true);
      expect(fetchMock).toHaveBeenCalledOnce();
      if (accepted) {
        expect(ctx.json).toHaveBeenCalledWith(ctx.res, { url });
        expect(ctx.error).not.toHaveBeenCalled();
      } else {
        expect(ctx.error).toHaveBeenCalledWith(
          ctx.res,
          "Unexpected response from GitHub API",
          502,
        );
        expect(ctx.json).not.toHaveBeenCalled();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
