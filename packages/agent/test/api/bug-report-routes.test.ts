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

const { rateLimitBugReport, sanitize } = await import(
  "../../src/api/bug-report-routes.ts"
);

describe.sequential("bug report sanitize and rate-limit units", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetBugReportRateLimit();
  });

  it("leaves ordinary text unchanged", () => {
    expect(sanitize("Agent crashed on boot")).toBe("Agent crashed on boot");
  });

  it("removes nested tags iteratively and strips leftover angle brackets", () => {
    expect(sanitize("<a<b>c</b>d>")).toBe("");
    expect(sanitize("value < 10 and > 5")).toBe("value  5");
    expect(sanitize("count <10")).toBe("count 10");
  });

  it("replaces lone surrogates with U+FFFD", () => {
    expect(sanitize(`ok${loneHighSurrogate}x${loneLowSurrogate}done`)).toBe(
      "ok\uFFFDx\uFFFDdone",
    );
  });

  it("clips over-limit output to exactly maxLen characters", () => {
    expect(sanitize("x".repeat(15), 10)).toBe("x".repeat(10));
    expect(sanitize("y".repeat(10), 10)).toBe("y".repeat(10));
  });

  it("shares one bucket between null and unknown clients", () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(rateLimitBugReport(null)).toBe(true);
    }
    expect(rateLimitBugReport("unknown")).toBe(false);
    expect(rateLimitBugReport(null)).toBe(false);
  });

  it("tracks distinct client addresses independently", () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(rateLimitBugReport("192.0.2.7")).toBe(true);
    }
    expect(rateLimitBugReport("192.0.2.7")).toBe(false);
    expect(rateLimitBugReport("192.0.2.8")).toBe(true);
  });

  it("accepts a blocked client again after resetBugReportRateLimit", () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      rateLimitBugReport("192.0.2.9");
    }
    expect(rateLimitBugReport("192.0.2.9")).toBe(false);
    resetBugReportRateLimit();
    expect(rateLimitBugReport("192.0.2.9")).toBe(true);
  });

  it("keeps the window closed at resetAt and reopens strictly after it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    const windowMs = 10 * 60 * 1000;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(rateLimitBugReport("203.0.113.9")).toBe(true);
    }
    expect(rateLimitBugReport("203.0.113.9")).toBe(false);
    vi.advanceTimersByTime(windowMs);
    expect(rateLimitBugReport("203.0.113.9")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(rateLimitBugReport("203.0.113.9")).toBe(true);
  });
});

describe.sequential("bug report route edge behavior", () => {
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
    vi.useRealTimers();
  });

  function infoContext(): ReturnType<typeof createContext> {
    return Object.assign(createContext(validBugReport), {
      method: "GET",
      pathname: "/api/bug-report/info",
    });
  }

  it("answers GET /api/bug-report/info with runtime info in fallback mode", async () => {
    const ctx = infoContext();
    expect(await handleBugReportRoutes(ctx)).toBe(true);
    expect(ctx.responseStatus).toBe(200);
    expect(ctx.responseBody).toEqual({
      nodeVersion: process.version,
      platform: process.platform,
      submissionMode: "fallback",
    });
  });

  it.each([
    {
      label: "github when only a token is configured",
      env: { GITHUB_TOKEN: "test-token-not-a-credential" },
      mode: "github",
    },
    {
      label: "remote when an intake URL outranks the token",
      env: {
        GITHUB_TOKEN: "test-token-not-a-credential",
        ELIZA_BUG_REPORT_API_URL: "https://intake.example.test/reports",
      },
      mode: "remote",
    },
  ])("advertises $label", async ({ env, mode }) => {
    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value);
    }
    const ctx = infoContext();
    expect(await handleBugReportRoutes(ctx)).toBe(true);
    expect(ctx.responseStatus).toBe(200);
    expect(ctx.responseBody).toMatchObject({ submissionMode: mode });
  });

  it("reports false and writes nothing for unrelated routes", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = Object.assign(createContext(validBugReport), {
      method: "DELETE",
      pathname: "/api/bug-report",
    });

    expect(await handleBugReportRoutes(ctx)).toBe(false);
    expect(ctx.json).not.toHaveBeenCalled();
    expect(ctx.error).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("handles an unreadable JSON body without responding or submitting", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createContext(validBugReport);
    ctx.readJsonBody = vi.fn(async () => null) as typeof ctx.readJsonBody;

    expect(await handleBugReportRoutes(ctx)).toBe(true);
    expect(ctx.json).not.toHaveBeenCalled();
    expect(ctx.error).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects schema-invalid payloads with 400 and still spends rate-limit capacity", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ip = "198.51.100.4";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const ctx = createContext(
        { description: "   ", stepsToReproduce: "Run the agent" },
        ip,
      );
      expect(await handleBugReportRoutes(ctx)).toBe(true);
      expect(ctx.responseStatus).toBe(400);
      expect(ctx.responseBody).toEqual({ error: "description is required" });
    }

    const limited = createContext(validBugReport, ip);
    expect(await handleBugReportRoutes(limited)).toBe(true);
    expect(limited.responseStatus).toBe(429);
    expect(limited.responseBody).toEqual({
      error: "Too many bug reports. Try again later.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a rejected remote intake response to a stable 502", async () => {
    vi.stubEnv(
      "ELIZA_BUG_REPORT_API_URL",
      "https://intake.example.test/reports",
    );
    const fetchMock = vi.fn(
      async () => new Response("upstream exploded", { status: 503 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ctx = createContext(validBugReport);
    expect(await handleBugReportRoutes(ctx)).toBe(true);
    expect(ctx.responseStatus).toBe(502);
    expect(ctx.responseBody).toEqual({ error: "Failed to submit bug report" });
  });

  it("treats a non-JSON remote success as accepted without parsing a body", async () => {
    vi.stubEnv(
      "ELIZA_BUG_REPORT_API_URL",
      "https://intake.example.test/reports",
    );
    const fetchMock = vi.fn(
      async () =>
        new Response("queued", {
          status: 202,
          headers: { "Content-Type": "text/plain" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ctx = createContext(validBugReport);
    expect(await handleBugReportRoutes(ctx)).toBe(true);
    expect(ctx.responseStatus).toBe(200);
    expect(ctx.responseBody).toEqual({ accepted: true, destination: "remote" });
  });

  it("defaults accepted to true when the remote JSON omits response fields", async () => {
    vi.stubEnv(
      "ELIZA_BUG_REPORT_API_URL",
      "https://intake.example.test/reports",
    );
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ctx = createContext(validBugReport);
    expect(await handleBugReportRoutes(ctx)).toBe(true);
    expect(ctx.responseBody).toEqual({ accepted: true, destination: "remote" });
  });

  it("surfaces remote transport failures as a 502", async () => {
    vi.stubEnv(
      "ELIZA_BUG_REPORT_API_URL",
      "https://intake.example.test/reports",
    );
    const fetchMock = vi.fn(async () => {
      throw new Error("intake unreachable");
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = createContext(validBugReport);
    expect(await handleBugReportRoutes(ctx)).toBe(true);
    expect(ctx.responseStatus).toBe(502);
    expect(ctx.responseBody).toEqual({ error: "Failed to submit bug report" });
  });

  it("maps GitHub API error statuses into a 502 carrying the status", async () => {
    vi.stubEnv("GITHUB_TOKEN", "test-token-not-a-credential");
    const fetchMock = vi.fn(
      async () => new Response("secondary rate limit", { status: 403 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ctx = createContext(validBugReport);
    expect(await handleBugReportRoutes(ctx)).toBe(true);
    expect(ctx.responseStatus).toBe(502);
    expect(ctx.responseBody).toEqual({ error: "GitHub API error (403)" });
  });

  it("rejects issue URLs that point outside the resolved repository", async () => {
    vi.stubEnv("GITHUB_TOKEN", "test-token-not-a-credential");
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            html_url: "https://github.com/attacker/repo/issues/1",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ctx = createContext(validBugReport);
    expect(await handleBugReportRoutes(ctx)).toBe(true);
    expect(ctx.responseStatus).toBe(502);
    expect(ctx.responseBody).toEqual({
      error: "Unexpected response from GitHub API",
    });
  });

  it("rejects a successful GitHub response without an issue URL", async () => {
    vi.stubEnv("GITHUB_TOKEN", "test-token-not-a-credential");
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ number: 7 }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ctx = createContext(validBugReport);
    expect(await handleBugReportRoutes(ctx)).toBe(true);
    expect(ctx.responseStatus).toBe(502);
    expect(ctx.responseBody).toEqual({
      error: "Unexpected response from GitHub API",
    });
  });

  it("translates GitHub transport failures into a stable 502", async () => {
    vi.stubEnv("GITHUB_TOKEN", "test-token-not-a-credential");
    const fetchMock = vi.fn(async () => {
      throw new Error("github unreachable");
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = createContext(validBugReport);
    expect(await handleBugReportRoutes(ctx)).toBe(true);
    expect(ctx.responseStatus).toBe(502);
    expect(ctx.responseBody).toEqual({
      error: "Failed to create GitHub issue",
    });
  });

  it("hands the submission an already-aborted signal when the client disconnected", async () => {
    vi.stubEnv("GITHUB_TOKEN", "test-token-not-a-credential");
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            html_url: "https://github.com/elizaOS/eliza/issues/42",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ctx = createContext(validBugReport);
    ctx.req.aborted = true;
    expect(await handleBugReportRoutes(ctx)).toBe(true);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal?.aborted).toBe(true);
    expect(ctx.responseBody).toEqual({
      url: "https://github.com/elizaOS/eliza/issues/42",
    });
  });
});
