/** Exercises bug-report routing with deterministic environment and fetch fixtures. */
import { EventEmitter } from "node:events";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUG_REPORT_REPO_ENV_KEY,
  DEFAULT_BUG_REPORT_REPO,
  handleBugReportRoutes,
  resetBugReportRateLimit,
  resolveBugReportRepo,
} from "../../src/api/bug-report-routes.ts";

type BugReportRouteContext = Parameters<typeof handleBugReportRoutes>[0];

const validBugReport = {
  description: "The agent fails to start",
  stepsToReproduce: "Run the agent",
};

const fox = String.fromCodePoint(0x1f98a);
const loneHighSurrogate = String.fromCharCode(0xd800);
const loneLowSurrogate = String.fromCharCode(0xdc00);

function taggedBoundaryInput(maxLen: number, visiblePrefix: string): string {
  const taggedPrefix = `<b>${visiblePrefix}${loneHighSurrogate}H${loneLowSurrogate}L</b>`;
  return `${taggedPrefix}${"x".repeat(maxLen - taggedPrefix.length - 1)}${fox}${loneHighSurrogate}`;
}

function expectWellFormedWithin(value: string, maxLen: number): void {
  expect(value.isWellFormed()).toBe(true);
  expect(value.length).toBeLessThanOrEqual(maxLen);
  expect(value).toContain("\uFFFD");
  expect(value).not.toMatch(/[<>]/);
}

function markdownSection(body: string, heading: string): string {
  const marker = `### ${heading}\n\n`;
  const start = body.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const contentStart = start + marker.length;
  const nextSection = body.indexOf("\n\n### ", contentStart);
  return body.slice(contentStart, nextSection === -1 ? undefined : nextSection);
}

function createContext(
  body: Record<string, unknown> = validBugReport,
  ip = "127.0.0.1",
): BugReportRouteContext & {
  responseBody?: unknown;
  responseStatus?: number;
} {
  const req = Object.assign(new EventEmitter(), {
    socket: { remoteAddress: ip },
  }) as unknown as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const ctx = {
    req,
    res,
    method: "POST",
    pathname: "/api/bug-report",
    readJsonBody: vi.fn(async () => body),
    json: vi.fn(
      (_res: http.ServerResponse, responseBody: unknown, status = 200) => {
        ctx.responseBody = responseBody;
        ctx.responseStatus = status;
      },
    ),
    error: vi.fn((_res: http.ServerResponse, message: string, status = 500) => {
      ctx.responseBody = { error: message };
      ctx.responseStatus = status;
    }),
  } as BugReportRouteContext & {
    responseBody?: unknown;
    responseStatus?: number;
  };
  return ctx;
}

describe.sequential("bug report repository routing", () => {
  beforeEach(() => {
    resetBugReportRateLimit();
    vi.stubEnv(BUG_REPORT_REPO_ENV_KEY, "");
    vi.stubEnv("BUG_REPORT_REPO", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("ELIZA_BUG_REPORT_API_URL", "");
    vi.stubEnv("ELIZA_BUG_REPORT_API_TOKEN", "");
  });

  afterEach(() => {
    resetBugReportRateLimit();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses the canonical elizaOS repository when no override is configured", () => {
    expect(DEFAULT_BUG_REPORT_REPO).toBe("elizaOS/eliza");
    expect(resolveBugReportRepo({})).toBe("elizaOS/eliza");
  });

  it.each([
    [BUG_REPORT_REPO_ENV_KEY, "owner/primary", "owner/primary"],
    ["BUG_REPORT_REPO", "owner/legacy", "owner/legacy"],
  ])("uses a valid %s override", async (key, value, expectedRepo) => {
    vi.stubEnv(key, value);
    const ctx = createContext();

    expect(await handleBugReportRoutes(ctx)).toBe(true);
    expect(ctx.responseBody).toEqual({
      fallback: `https://github.com/${expectedRepo}/issues/new?template=bug_report.yml`,
    });
  });

  it("gives a valid primary override precedence over the legacy override", () => {
    expect(
      resolveBugReportRepo({
        [BUG_REPORT_REPO_ENV_KEY]: "owner/primary",
        BUG_REPORT_REPO: "owner/legacy",
      }),
    ).toBe("owner/primary");
  });

  it.each([
    ["blank", "   "],
    ["missing owner", "/repo"],
    ["missing repository", "owner/"],
    ["extra path segment", "owner/repo/issues"],
  ])("falls back for a %s primary override", (_name, value) => {
    expect(
      resolveBugReportRepo({
        [BUG_REPORT_REPO_ENV_KEY]: value,
        BUG_REPORT_REPO: "also invalid",
      }),
    ).toBe(DEFAULT_BUG_REPORT_REPO);
  });

  it("returns the canonical no-token fallback URL without making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createContext();

    expect(await handleBugReportRoutes(ctx)).toBe(true);
    expect(ctx.responseBody).toEqual({
      fallback:
        "https://github.com/elizaOS/eliza/issues/new?template=bug_report.yml",
    });
    expect(ctx.responseStatus).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts sanitized reports to the canonical GitHub API URL when a token exists", async () => {
    vi.stubEnv("GITHUB_TOKEN", "test-token-not-a-credential");
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            html_url: "https://github.com/elizaOS/eliza/issues/123",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createContext({
      description: "<b>Broken</b>\nagent",
      stepsToReproduce: "Run <script>unsafe</script> once",
      logs: `credential ghp_${"a".repeat(20)}`,
      startup: { reason: "", phase: "", path: "" },
    });

    expect(await handleBugReportRoutes(ctx)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/elizaOS/eliza/issues");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-token-not-a-credential",
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    });
    const payload = JSON.parse(String(init.body));
    expect(payload.title).toBe("[Bug] Broken agent");
    expect(payload.body).toContain("Run unsafe once");
    expect(payload.body).toContain("credential [redacted-token]");
    expect(payload.body).toContain('"reason": ""');
    expect(payload.body).toContain('"phase": ""');
    expect(payload.body).toContain('"path": ""');
    expect(payload.labels).toEqual(["bug", "triage", "user-reported"]);
    expect(ctx.responseBody).toEqual({
      url: "https://github.com/elizaOS/eliza/issues/123",
    });
  });

  it("keeps the outgoing GitHub issue Unicode-safe, bounded, tag-clean, and redacted", async () => {
    vi.stubEnv("GITHUB_TOKEN", "test-token-not-a-credential");
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            html_url: "https://github.com/elizaOS/eliza/issues/456",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createContext({
      description: taggedBoundaryInput(10_000, "boundary description "),
      stepsToReproduce: taggedBoundaryInput(10_000, "boundary steps "),
      logs: taggedBoundaryInput(50_000, `credential ghp_${"a".repeat(20)} `),
      category: "startup-failure",
      startup: {
        reason: taggedBoundaryInput(120, "reason "),
        phase: taggedBoundaryInput(120, "phase "),
        status: 503,
        path: taggedBoundaryInput(500, "path "),
      },
    });

    expect(await handleBugReportRoutes(ctx)).toBe(true);
    const [, init] = fetchMock.mock.calls[0];
    const payload = JSON.parse(String(init.body)) as {
      title: string;
      body: string;
      labels: string[];
    };

    expectWellFormedWithin(payload.title, "[Bug] ".length + 80);
    expect(payload.body.isWellFormed()).toBe(true);
    expect(payload.body).not.toContain("ghp_");
    expect(payload.body).toContain("credential [redacted-token]");
    expectWellFormedWithin(
      markdownSection(payload.body, "Description"),
      10_000,
    );
    expectWellFormedWithin(
      markdownSection(payload.body, "Steps to Reproduce"),
      10_000,
    );
    const startupSection = markdownSection(payload.body, "Startup Context");
    const startup = JSON.parse(
      startupSection.slice("```json\n".length, -"\n```".length),
    ) as {
      reason: string;
      phase: string;
      status: number;
      path: string;
    };
    expectWellFormedWithin(startup.reason, 120);
    expectWellFormedWithin(startup.phase, 120);
    expectWellFormedWithin(startup.path, 500);
    expect(startup.status).toBe(503);
    expect(payload.labels).toEqual(["bug", "triage", "user-reported"]);
  });

  it("keeps remote intake precedence over token-backed GitHub submission", async () => {
    vi.stubEnv(
      "ELIZA_BUG_REPORT_API_URL",
      "https://intake.example.test/reports",
    );
    vi.stubEnv("ELIZA_BUG_REPORT_API_TOKEN", "remote-test-token");
    vi.stubEnv("GITHUB_TOKEN", "github-test-token");
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            accepted: true,
            id: "report-1",
            url: "https://intake.example.test/reports/report-1",
          }),
          { status: 202, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createContext();

    expect(await handleBugReportRoutes(ctx)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://intake.example.test/reports");
    expect(ctx.responseBody).toEqual({
      accepted: true,
      id: "report-1",
      url: "https://intake.example.test/reports/report-1",
      destination: "remote",
    });
  });

  it("keeps every outgoing remote-intake text field Unicode-safe and bounded", async () => {
    vi.stubEnv(
      "ELIZA_BUG_REPORT_API_URL",
      "https://intake.example.test/reports",
    );
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ accepted: true, id: "report-2" }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createContext({
      description: taggedBoundaryInput(500, "description "),
      stepsToReproduce: taggedBoundaryInput(10_000, "steps "),
      expectedBehavior: taggedBoundaryInput(10_000, "expected "),
      actualBehavior: taggedBoundaryInput(10_000, "actual "),
      environment: taggedBoundaryInput(200, "environment "),
      nodeVersion: taggedBoundaryInput(200, "node "),
      modelProvider: taggedBoundaryInput(200, "provider "),
      appVersion: taggedBoundaryInput(200, "app "),
      releaseChannel: taggedBoundaryInput(200, "release "),
      logs: taggedBoundaryInput(50_000, `credential ghp_${"a".repeat(20)} `),
      category: "startup-failure",
      startup: {
        reason: taggedBoundaryInput(120, "reason "),
        phase: taggedBoundaryInput(120, "phase "),
        message: taggedBoundaryInput(1_000, `token ghp_${"b".repeat(20)} `),
        detail: taggedBoundaryInput(10_000, `token ghp_${"c".repeat(20)} `),
        status: 500,
        path: taggedBoundaryInput(500, "path "),
      },
    });

    expect(await handleBugReportRoutes(ctx)).toBe(true);
    const [, init] = fetchMock.mock.calls[0];
    const payload = JSON.parse(String(init.body)) as {
      description: string;
      stepsToReproduce: string;
      expectedBehavior: string;
      actualBehavior: string;
      environment: string;
      nodeVersion: string;
      modelProvider: string;
      appVersion: string;
      releaseChannel: string;
      logs: string;
      startup: {
        reason: string;
        phase: string;
        message: string;
        detail: string;
        status: number;
        path: string;
      };
    };
    const cappedFields = [
      [payload.description, 500],
      [payload.stepsToReproduce, 10_000],
      [payload.expectedBehavior, 10_000],
      [payload.actualBehavior, 10_000],
      [payload.environment, 200],
      [payload.nodeVersion, 200],
      [payload.modelProvider, 200],
      [payload.appVersion, 200],
      [payload.releaseChannel, 200],
      [payload.logs, 50_000],
      [payload.startup.reason, 120],
      [payload.startup.phase, 120],
      [payload.startup.message, 1_000],
      [payload.startup.detail, 10_000],
      [payload.startup.path, 500],
    ] as const;

    for (const [value, maxLen] of cappedFields) {
      expectWellFormedWithin(value, maxLen);
    }
    expect(payload.logs).toContain("credential [redacted-token]");
    expect(payload.startup.message).toContain("token [redacted-token]");
    expect(payload.startup.detail).toContain("token [redacted-token]");
    expect(payload.startup.status).toBe(500);
  });

  it("preserves the per-client submission rate limit", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const ctx = createContext(validBugReport, "192.0.2.1");
      expect(await handleBugReportRoutes(ctx)).toBe(true);
      expect(ctx.responseStatus).toBe(200);
    }

    const limited = createContext(validBugReport, "192.0.2.1");
    expect(await handleBugReportRoutes(limited)).toBe(true);
    expect(limited.responseStatus).toBe(429);
    expect(limited.responseBody).toEqual({
      error: "Too many bug reports. Try again later.",
    });
  });
});
