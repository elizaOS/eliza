/**
 * GET /api/logs `since` is a timestamp cursor, not a leftover enum catalog.
 * Stock develop used Number(since) + !Number.isNaN, so ISO dates were ignored
 * (unfiltered dump) and `since=Infinity` silently returned an empty page.
 * Audit already fail-closes via parseAuditSince; the live log viewer must too.
 */
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handleDiagnosticsRoutes } from "./diagnostics-routes.ts";

const ISO = "2026-08-01T00:00:00.000Z";
const ISO_MS = Date.parse(ISO);

function entry(timestamp: number, message: string) {
  return {
    timestamp,
    level: "info",
    message,
    source: "agent",
    tags: [] as string[],
  };
}

function makeCtx(search: string) {
  const pathname = "/api/logs";
  const url = new URL(`http://localhost${pathname}${search}`);
  const json = vi.fn();
  const queryAuditFeed = vi.fn(() => []);
  return {
    req: {} as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method: "GET",
    pathname,
    url,
    json,
    logBuffer: [entry(1_000, "old"), entry(ISO_MS + 1, "new")],
    eventBuffer: [],
    auditEventTypes: [] as string[],
    auditSeverities: [] as string[],
    getAuditFeedSize: () => 0,
    queryAuditFeed,
    subscribeAuditFeed: () => () => undefined,
  };
}

describe("GET /api/logs since timestamp", () => {
  it("omits the cursor and returns the recent buffer", async () => {
    const ctx = makeCtx("");
    const handled = await handleDiagnosticsRoutes(ctx);
    expect(handled).toBe(true);
    expect(ctx.json).toHaveBeenCalledTimes(1);
    const [, body, status] = ctx.json.mock.calls[0];
    expect(status ?? 200).toBe(200);
    expect(body.entries.map((row: { message: string }) => row.message)).toEqual(
      ["old", "new"],
    );
  });

  it("filters on a canonical epoch millisecond", async () => {
    const ctx = makeCtx("?since=1500");
    await handleDiagnosticsRoutes(ctx);
    const [, body, status] = ctx.json.mock.calls[0];
    expect(status ?? 200).toBe(200);
    expect(body.entries.map((row: { message: string }) => row.message)).toEqual(
      ["new"],
    );
  });

  it("filters on an ISO timestamp (audit grammar)", async () => {
    const ctx = makeCtx(`?since=${encodeURIComponent(ISO)}`);
    await handleDiagnosticsRoutes(ctx);
    const [, body, status] = ctx.json.mock.calls[0];
    expect(status ?? 200).toBe(200);
    expect(body.entries.map((row: { message: string }) => row.message)).toEqual(
      ["new"],
    );
  });

  it.each([
    "1e2",
    "12px",
    "007",
    "Infinity",
    "foo",
    "1.5",
    " 1500",
    "1500 ",
    ` ${ISO}`,
    `${ISO} `,
  ])("rejects since=%s before filtering the buffer", async (token) => {
    const ctx = makeCtx(`?since=${encodeURIComponent(token)}`);
    await handleDiagnosticsRoutes(ctx);
    expect(ctx.json).toHaveBeenCalledTimes(1);
    const [, body, status] = ctx.json.mock.calls[0];
    expect(status).toBe(400);
    expect(body.error).toMatch(/since/i);
    expect(body.entries).toBeUndefined();
  });
});

describe("DELETE /api/logs", () => {
  it("clears the log buffer and returns the cleared count", async () => {
    const json = vi.fn();
    const logBuffer = [entry(1_000, "old"), entry(2_000, "new")];
    const ctx = {
      req: {} as http.IncomingMessage,
      res: {} as http.ServerResponse,
      method: "DELETE",
      pathname: "/api/logs",
      url: new URL("http://localhost/api/logs"),
      json,
      logBuffer,
      eventBuffer: [],
      auditEventTypes: [],
      auditSeverities: [],
      getAuditFeedSize: () => 0,
      queryAuditFeed: () => [],
      subscribeAuditFeed: () => () => undefined,
    };

    const handled = await handleDiagnosticsRoutes(ctx);
    expect(handled).toBe(true);
    expect(json).toHaveBeenCalledWith(ctx.res, { cleared: 2 });
    expect(logBuffer).toHaveLength(0);
  });
});

describe("POST /api/logs/export", () => {
  it("exports logs as JSON attachment", async () => {
    const resHeaders: Record<string, string | number> = {};
    let writtenBody = "";
    const res = {
      writeHead: vi.fn(
        (_status: number, headers: Record<string, string | number>) => {
          Object.assign(resHeaders, headers);
        },
      ),
      end: vi.fn((data: string) => {
        writtenBody = data;
      }),
    } as unknown as http.ServerResponse;

    const ctx = {
      req: {} as http.IncomingMessage,
      res,
      method: "POST",
      pathname: "/api/logs/export",
      url: new URL("http://localhost/api/logs/export"),
      json: vi.fn(),
      error: vi.fn(),
      readJsonBody: vi.fn().mockResolvedValue({ format: "json" }),
      logBuffer: [entry(1_000, "message one")],
      eventBuffer: [],
      auditEventTypes: [],
      auditSeverities: [],
      getAuditFeedSize: () => 0,
      queryAuditFeed: () => [],
      subscribeAuditFeed: () => () => undefined,
    };

    const handled = await handleDiagnosticsRoutes(ctx);
    expect(handled).toBe(true);
    expect(resHeaders["Content-Type"]).toBe("application/json; charset=utf-8");
    expect(writtenBody).toContain("message one");
  });

  it("exports logs as CSV attachment", async () => {
    const resHeaders: Record<string, string | number> = {};
    let writtenBody = "";
    const res = {
      writeHead: vi.fn(
        (_status: number, headers: Record<string, string | number>) => {
          Object.assign(resHeaders, headers);
        },
      ),
      end: vi.fn((data: string) => {
        writtenBody = data;
      }),
    } as unknown as http.ServerResponse;

    const ctx = {
      req: {} as http.IncomingMessage,
      res,
      method: "POST",
      pathname: "/api/logs/export",
      url: new URL("http://localhost/api/logs/export"),
      json: vi.fn(),
      error: vi.fn(),
      readJsonBody: vi.fn().mockResolvedValue({ format: "csv" }),
      logBuffer: [entry(1_000, "csv message")],
      eventBuffer: [],
      auditEventTypes: [],
      auditSeverities: [],
      getAuditFeedSize: () => 0,
      queryAuditFeed: () => [],
      subscribeAuditFeed: () => () => undefined,
    };

    const handled = await handleDiagnosticsRoutes(ctx);
    expect(handled).toBe(true);
    expect(resHeaders["Content-Type"]).toBe("text/csv; charset=utf-8");
    expect(writtenBody).toContain("timestamp,level,source,tags,message");
    expect(writtenBody).toContain("csv message");
  });
});

describe("GET /api/extension/status", () => {
  it("probes relay reachability and returns status payload", async () => {
    const json = vi.fn();
    const checkRelayReachable = vi.fn().mockResolvedValue(true);
    const ctx = {
      req: {} as http.IncomingMessage,
      res: {} as http.ServerResponse,
      method: "GET",
      pathname: "/api/extension/status",
      url: new URL("http://localhost/api/extension/status"),
      json,
      logBuffer: [],
      eventBuffer: [],
      relayPort: 18792,
      checkRelayReachable,
      auditEventTypes: [],
      auditSeverities: [],
      getAuditFeedSize: () => 0,
      queryAuditFeed: () => [],
      subscribeAuditFeed: () => () => undefined,
    };

    const handled = await handleDiagnosticsRoutes(ctx);
    expect(handled).toBe(true);
    expect(checkRelayReachable).toHaveBeenCalledWith(18792);
    expect(json).toHaveBeenCalledWith(ctx.res, {
      relayReachable: true,
      relayPort: 18792,
      extensionPath: null,
    });
  });
});
