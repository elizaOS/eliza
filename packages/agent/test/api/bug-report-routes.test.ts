import { describe, expect, test, vi } from "vitest";
import {
  handleBugReportRoutes,
  rateLimitBugReport,
  resetBugReportRateLimit,
  sanitize,
} from "../../src/api/bug-report-routes";
import type { RouteRequestContext } from "../../src/api/route-helpers";
import {
  createMockHttpResponse,
  createMockIncomingMessage,
} from "../../src/test-support/test-helpers";

function buildCtx(
  overrides: Partial<RouteRequestContext> = {},
): RouteRequestContext {
  const { res } = createMockHttpResponse();
  return {
    req: createMockIncomingMessage({ method: "GET", url: "/" }),
    res,
    method: "GET",
    pathname: "/",
    json: vi.fn((r, data, status = 200) => {
      r.writeHead(status);
      r.end(JSON.stringify(data));
    }),
    error: vi.fn((r, message, status = 500) => {
      r.writeHead(status);
      r.end(JSON.stringify({ error: message }));
    }),
    readJsonBody: vi.fn(async () => null),
    ...overrides,
  };
}

describe("handleBugReportRoutes", () => {
  test("returns false for unrelated path", async () => {
    const ctx = buildCtx({ pathname: "/api/other" });
    const handled = await handleBugReportRoutes(ctx);
    expect(handled).toBe(false);
  });

  test("GET /api/bug-report/info returns node version and platform", async () => {
    const { res, getStatus, getJson } = createMockHttpResponse();
    const ctx = buildCtx({
      method: "GET",
      pathname: "/api/bug-report/info",
      res,
    });

    const handled = await handleBugReportRoutes(ctx);

    expect(handled).toBe(true);
    expect(getStatus()).toBe(200);
    const json = getJson<{ nodeVersion: string; platform: string }>();
    expect(json.nodeVersion).toBe(process.version);
    expect(typeof json.platform).toBe("string");
  });
});

describe("rateLimitBugReport", () => {
  test("allows first submission", () => {
    resetBugReportRateLimit();
    expect(rateLimitBugReport("127.0.0.1")).toBe(true);
  });

  test("blocks after max submissions", () => {
    resetBugReportRateLimit();
    const ip = "10.0.0.1";
    for (let i = 0; i < 5; i++) {
      rateLimitBugReport(ip);
    }
    expect(rateLimitBugReport(ip)).toBe(false);
  });
});

describe("sanitize", () => {
  test("strips HTML tags", () => {
    expect(sanitize("<script>alert('xss')</script>hello")).toBe(
      "alert('xss')hello",
    );
  });

  test("truncates to maxLen", () => {
    const long = "a".repeat(200);
    expect(sanitize(long, 50).length).toBe(50);
  });
});
