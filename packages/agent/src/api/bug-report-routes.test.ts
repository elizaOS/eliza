/**
 * Unit tests for the bug-report HTTP routes: repository resolution, the
 * per-IP submission rate limiter, sanitizer markup handling, and the full
 * POST dispatch matrix across all three sinks (remote intake, direct GitHub,
 * fallback URL) plus the GET /api/bug-report/info mode advertisement.
 *
 * Deterministic integration-style harness: drives the real route handler with
 * a stand-in request/response context, the real shared zod schema, and a
 * stubbed global fetch whose queued Response objects stand in for the network.
 * Secrets must be redacted before any sink sees them; those negative security
 * properties are asserted against the actual outbound payload.
 */
import type http from "node:http";
import type { RouteRequestContext } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUG_REPORT_REPO_ENV_KEY,
  DEFAULT_BUG_REPORT_REPO,
  handleBugReportRoutes,
  rateLimitBugReport,
  resetBugReportRateLimit,
  resolveBugReportRepo,
  sanitize,
} from "./bug-report-routes.ts";

const MANAGED_ENV_KEYS = [
  BUG_REPORT_REPO_ENV_KEY,
  "BUG_REPORT_REPO",
  "ELIZA_BUG_REPORT_API_URL",
  "ELIZA_BUG_REPORT_API_TOKEN",
  "GITHUB_TOKEN",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveBugReportRepo", () => {
  it("falls back to the default repo when nothing is configured", () => {
    expect(resolveBugReportRepo({})).toBe(DEFAULT_BUG_REPORT_REPO);
  });

  it("prefers ELIZA_BUG_REPORT_REPO over the legacy fallback variable", () => {
    expect(
      resolveBugReportRepo({
        ELIZA_BUG_REPORT_REPO: "acme/primary",
        BUG_REPORT_REPO: "acme/legacy",
      }),
    ).toBe("acme/primary");
  });

  it("uses the legacy fallback when the primary variable is unset", () => {
    expect(resolveBugReportRepo({ BUG_REPORT_REPO: "acme/legacy" })).toBe(
      "acme/legacy",
    );
  });

  it("trims configured values", () => {
    expect(
      resolveBugReportRepo({ ELIZA_BUG_REPORT_REPO: "  acme/trimmed " }),
    ).toBe("acme/trimmed");
  });

  it("rejects values that are not an owner/name pair and keeps falling through", () => {
    const invalid = [
      "",
      "   ",
      "just-a-name",
      "a/b/c",
      "/leading",
      "trailing/",
    ];
    for (const value of invalid) {
      expect(resolveBugReportRepo({ ELIZA_BUG_REPORT_REPO: value })).toBe(
        DEFAULT_BUG_REPORT_REPO,
      );
    }
    expect(
      resolveBugReportRepo({
        ELIZA_BUG_REPORT_REPO: "not valid",
        BUG_REPORT_REPO: "acme/valid",
      }),
    ).toBe("acme/valid");
  });
});

describe("rateLimitBugReport", () => {
  beforeEach(() => {
    resetBugReportRateLimit();
  });

  it("allows exactly five submissions per window then denies", () => {
    for (let i = 0; i < 5; i++) {
      expect(rateLimitBugReport("10.0.0.1")).toBe(true);
    }
    expect(rateLimitBugReport("10.0.0.1")).toBe(false);
  });

  it("tracks client IPs independently", () => {
    expect(rateLimitBugReport("10.0.0.1")).toBe(true);
    expect(rateLimitBugReport("10.0.0.2")).toBe(true);
  });

  it("groups missing remote addresses into one unknown bucket", () => {
    for (let i = 0; i < 5; i++) {
      expect(rateLimitBugReport(null)).toBe(true);
    }
    expect(rateLimitBugReport(null)).toBe(false);
    expect(rateLimitBugReport("10.0.0.9")).toBe(true);
  });

  it("keeps denying until the window resets", () => {
    const base = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(base);
    for (let i = 0; i < 5; i++) {
      rateLimitBugReport("10.0.0.3");
    }
    expect(rateLimitBugReport("10.0.0.3")).toBe(false);

    nowSpy.mockReturnValue(base + 10 * 60 * 1000 + 1);
    expect(rateLimitBugReport("10.0.0.3")).toBe(true);
  });
});

describe("sanitize markup handling", () => {
  it("strips well-formed tags", () => {
    expect(sanitize("<b>hello</b>")).toBe("hello");
  });

  it("iteratively removes nested tags until stable", () => {
    expect(sanitize("a<scr<b>ipt>x")).toBe("ax");
  });

  it("treats the first <...> run as one tag and drops everything inside", () => {
    expect(sanitize("3 < 5 and 6 > 2")).toBe("3  2");
  });

  it("removes stray angle brackets that never form a tag pair", () => {
    expect(sanitize("5 > 4 and 3 < 1")).toBe("5  4 and 3  1");
  });

  it("clips over-long input to maxLen", () => {
    expect(sanitize("abcdefghij", 4)).toBe("abcd");
  });

  it("re-clips after cleaning can shrink the clipped text", () => {
    expect(sanitize("ab<xx>cdefgh", 4)).toBe("abx");
  });

  it("passes clean text through unchanged and handles empty input", () => {
    expect(sanitize("plain text only")).toBe("plain text only");
    expect(sanitize("")).toBe("");
  });
});

function makeCtx(
  overrides: {
    method?: string;
    pathname?: string;
    body?: Record<string, unknown> | null;
    req?: Partial<http.IncomingMessage>;
  } = {},
): {
  ctx: RouteRequestContext;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  readJsonBody: ReturnType<typeof vi.fn>;
  res: http.ServerResponse;
} {
  const json = vi.fn();
  const error = vi.fn();
  const readJsonBody = vi
    .fn()
    .mockResolvedValue(overrides.body === undefined ? {} : overrides.body);
  const res = { statusCode: 0 } as unknown as http.ServerResponse;
  const req = {
    socket: { remoteAddress: "203.0.113.7" },
    aborted: false,
    once: vi.fn(),
    off: vi.fn(),
    ...overrides.req,
  } as unknown as http.IncomingMessage;

  const ctx = {
    req,
    res,
    method: overrides.method ?? "POST",
    pathname: overrides.pathname ?? "/api/bug-report",
    json,
    error,
    readJsonBody,
  } as unknown as RouteRequestContext;

  return { ctx, json, error, readJsonBody, res };
}

const VALID_BODY = {
  description: "App crashes on export",
  stepsToReproduce: "1. Open settings 2. Click export",
};

describe("handleBugReportRoutes GET /api/bug-report/info", () => {
  it("reports the fallback submission mode with node/platform facts", async () => {
    const { ctx, json, error } = makeCtx({
      method: "GET",
      pathname: "/api/bug-report/info",
    });

    const handled = await handleBugReportRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledTimes(1);
    const payload = json.mock.calls[0][1];
    expect(payload.submissionMode).toBe("fallback");
    expect(typeof payload.nodeVersion).toBe("string");
    expect(typeof payload.platform).toBe("string");
  });

  it("advertises github mode when only GITHUB_TOKEN is set", async () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    const { ctx, json } = makeCtx({
      method: "GET",
      pathname: "/api/bug-report/info",
    });

    await handleBugReportRoutes(ctx);

    expect(json.mock.calls[0][1].submissionMode).toBe("github");
  });

  it("advertises remote mode whenever the intake API is configured", async () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    process.env.ELIZA_BUG_REPORT_API_URL = "https://intake.example.com/bugs";
    const { ctx, json } = makeCtx({
      method: "GET",
      pathname: "/api/bug-report/info",
    });

    await handleBugReportRoutes(ctx);

    expect(json.mock.calls[0][1].submissionMode).toBe("remote");
  });
});

describe("handleBugReportRoutes POST validation and gating", () => {
  beforeEach(() => {
    resetBugReportRateLimit();
  });

  it("ignores routes and methods it does not own", async () => {
    const getPost = makeCtx({ method: "GET", pathname: "/api/bug-report" });
    expect(await handleBugReportRoutes(getPost.ctx)).toBe(false);

    const otherPath = makeCtx({
      method: "POST",
      pathname: "/api/something-else",
    });
    expect(await handleBugReportRoutes(otherPath.ctx)).toBe(false);
    expect(otherPath.json).not.toHaveBeenCalled();
    expect(otherPath.error).not.toHaveBeenCalled();
  });

  it("answers 429 before reading the body once the IP is exhausted", async () => {
    for (let i = 0; i < 5; i++) {
      rateLimitBugReport("203.0.113.7");
    }
    const { ctx, error, readJsonBody } = makeCtx({ body: VALID_BODY });

    const handled = await handleBugReportRoutes(ctx);

    expect(handled).toBe(true);
    expect(readJsonBody).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      "Too many bug reports. Try again later.",
      429,
    );
  });

  it("returns 400 for a body missing required fields", async () => {
    const { ctx, error, json } = makeCtx({ body: { description: "only" } });

    const handled = await handleBugReportRoutes(ctx);

    expect(handled).toBe(true);
    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][2]).toBe(400);
  });

  it("surfaces the schema's custom message for whitespace-only required fields", async () => {
    const { ctx, error } = makeCtx({
      body: { description: "   ", stepsToReproduce: "step" },
    });

    await handleBugReportRoutes(ctx);

    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      "description is required",
      400,
    );
  });

  it("rejects unknown fields because the schema is strict", async () => {
    const { ctx, error } = makeCtx({
      body: { ...VALID_BODY, sneakyExtra: true },
    });

    await handleBugReportRoutes(ctx);

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][2]).toBe(400);
  });

  it("trusts the body reader to have answered and stays silent on null", async () => {
    const { ctx, error, json } = makeCtx({ body: null });

    const handled = await handleBugReportRoutes(ctx);

    expect(handled).toBe(true);
    expect(json).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("handleBugReportRoutes fallback sink", () => {
  beforeEach(() => {
    resetBugReportRateLimit();
  });

  it("hands back the new-issue URL of the default repo", async () => {
    const { ctx, json, error } = makeCtx({ body: VALID_BODY });

    const handled = await handleBugReportRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.anything(), {
      fallback:
        "https://github.com/elizaOS/eliza/issues/new?template=bug_report.yml",
    });
  });

  it("points the fallback at the configured repository", async () => {
    process.env[BUG_REPORT_REPO_ENV_KEY] = "acme/widgets";
    const { ctx, json } = makeCtx({ body: VALID_BODY });

    await handleBugReportRoutes(ctx);

    expect(json).toHaveBeenCalledWith(expect.anything(), {
      fallback:
        "https://github.com/acme/widgets/issues/new?template=bug_report.yml",
    });
  });
});

describe("handleBugReportRoutes remote intake sink", () => {
  beforeEach(() => {
    resetBugReportRateLimit();
    process.env.ELIZA_BUG_REPORT_API_URL = "https://intake.example.com/bugs";
  });

  it("posts the redacted payload to the intake API and relays acceptance", async () => {
    process.env.ELIZA_BUG_REPORT_API_TOKEN = "intake-token";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "br-1",
          url: "https://intake.example.com/bugs/br-1",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, json, error } = makeCtx({
      body: { ...VALID_BODY, logs: "token sk-ABCDEFGHIJKLMNOPQRSTUVWX here" },
    });

    const handled = await handleBugReportRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe("https://intake.example.com/bugs");
    expect(init.headers.Authorization).toBe("Bearer intake-token");

    const sentPayload = JSON.parse(init.body);
    expect(sentPayload.description).toContain("App crashes on export");
    expect(sentPayload.logs).toContain("[redacted-token]");
    expect(sentPayload.logs).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX");

    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accepted: true,
        id: "br-1",
        destination: "remote",
      }),
    );
  });

  it("maps an upstream failure response to a 502 without fabricating success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 500 })),
    );
    const { ctx, error, json } = makeCtx({ body: VALID_BODY });

    const handled = await handleBugReportRoutes(ctx);

    expect(handled).toBe(true);
    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      "Failed to submit bug report",
      502,
    );
  });

  it("translates a rejected fetch into the same explicit 502 failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    const { ctx, error, json } = makeCtx({ body: VALID_BODY });

    const handled = await handleBugReportRoutes(ctx);

    expect(handled).toBe(true);
    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      "Failed to submit bug report",
      502,
    );
  });

  it("accepts a non-JSON intake acknowledgement as accepted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("ok", {
          status: 202,
          headers: { "content-type": "text/plain" },
        }),
      ),
    );
    const { ctx, json } = makeCtx({ body: VALID_BODY });

    await handleBugReportRoutes(ctx);

    expect(json).toHaveBeenCalledWith(expect.anything(), {
      accepted: true,
      destination: "remote",
    });
  });
});

describe("handleBugReportRoutes github sink", () => {
  const GITHUB_ISSUES_URL = "https://api.github.com/repos/elizaOS/eliza/issues";

  beforeEach(() => {
    resetBugReportRateLimit();
    process.env.GITHUB_TOKEN = "ghp_github-token-value";
  });

  it("creates the issue with prefix, labels and fully redacted content", async () => {
    const secretToken = "ghp_AAAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHHH";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          html_url: "https://github.com/elizaOS/eliza/issues/42",
        }),
        {
          status: 201,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, json, error } = makeCtx({
      body: {
        ...VALID_BODY,
        description: `crash while holding ${secretToken}`,
      },
    });

    const handled = await handleBugReportRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).not.toHaveBeenCalled();

    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(GITHUB_ISSUES_URL);
    expect(init.headers.Authorization).toBe("Bearer ghp_github-token-value");

    const issuePayload = JSON.parse(init.body);
    expect(issuePayload.title.startsWith("[Bug] ")).toBe(true);
    expect(issuePayload.title.length).toBeLessThanOrEqual(80);
    expect(issuePayload.labels).toEqual(["bug", "triage", "user-reported"]);
    expect(issuePayload.body).toContain("[redacted-token]");
    expect(issuePayload.body).not.toContain(secretToken);

    expect(json).toHaveBeenCalledWith(expect.anything(), {
      url: "https://github.com/elizaOS/eliza/issues/42",
    });
  });

  it("targets the configured repository in both request and accepted-url check", async () => {
    process.env[BUG_REPORT_REPO_ENV_KEY] = "acme/widgets";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          html_url: "https://github.com/acme/widgets/issues/7",
        }),
        {
          status: 201,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, json } = makeCtx({ body: VALID_BODY });

    await handleBugReportRoutes(ctx);

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/acme/widgets/issues",
    );
    expect(json).toHaveBeenCalledWith(expect.anything(), {
      url: "https://github.com/acme/widgets/issues/7",
    });
  });

  it("refuses an html_url pointing somewhere other than the target repo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ html_url: "https://evil.example/issues/1" }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );
    const { ctx, error, json } = makeCtx({ body: VALID_BODY });

    await handleBugReportRoutes(ctx);

    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      "Unexpected response from GitHub API",
      502,
    );
  });

  it("maps a GitHub API failure to a 502 carrying the upstream status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 })),
    );
    const { ctx, error } = makeCtx({ body: VALID_BODY });

    await handleBugReportRoutes(ctx);

    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      "GitHub API error (403)",
      502,
    );
  });

  it("translates a rejected fetch into an explicit 502 instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { ctx, error, json } = makeCtx({ body: VALID_BODY });

    const handled = await handleBugReportRoutes(ctx);

    expect(handled).toBe(true);
    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      "Failed to create GitHub issue",
      502,
    );
  });
});
