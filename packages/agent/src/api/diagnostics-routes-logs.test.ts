/**
 * Tests for the log export and clear routes added to the diagnostics surface.
 */

import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  type DiagnosticsRouteContext,
  handleDiagnosticsRoutes,
} from "./diagnostics-routes.js";

interface RecordedJson {
  status: number;
  body: unknown;
}

interface RecordedRaw {
  status: number;
  headers: Record<string, string | number>;
  payload: string;
}

function makeBaseCtx(
  method: string,
  pathname: string,
  body: unknown,
  logBuffer: NonNullable<DiagnosticsRouteContext["logBuffer"]>,
  options: {
    clearLogBuffer?: () => number;
    raw?: RecordedRaw;
    captureRaw?: boolean;
  } = {},
) {
  const recorded: RecordedJson = { status: 200, body: undefined };
  const captured: RecordedRaw = options.raw ?? {
    status: 0,
    headers: {},
    payload: "",
  };

  const res = {
    writeHead: vi.fn(
      (status: number, headers: Record<string, string | number>) => {
        captured.status = status;
        captured.headers = { ...headers };
      },
    ),
    end: vi.fn((chunk?: unknown) => {
      if (chunk == null) return;
      if (typeof chunk === "string") {
        captured.payload = chunk;
      } else if (Buffer.isBuffer(chunk)) {
        captured.payload = chunk.toString("utf-8");
      }
    }),
  } as unknown as http.ServerResponse;

  return {
    ctx: {
      req: {} as http.IncomingMessage,
      res,
      method,
      pathname,
      url: new URL(`http://localhost${pathname}`),
      logBuffer,
      eventBuffer: [],
      auditEventTypes: [],
      auditSeverities: [],
      getAuditFeedSize: () => 0,
      queryAuditFeed: () => [],
      subscribeAuditFeed: () => () => undefined,
      json: (_res: http.ServerResponse, data: unknown, status?: number) => {
        recorded.status = status ?? 200;
        recorded.body = data;
      },
      error: (_res: http.ServerResponse, message: string, status?: number) => {
        recorded.status = status ?? 500;
        recorded.body = { error: message };
      },
      readJsonBody: async <T extends object>(): Promise<T | null> =>
        body as T | null,
      clearLogBuffer: options.clearLogBuffer,
    } satisfies DiagnosticsRouteContext,
    recorded,
    captured,
  };
}

describe("DELETE /api/logs", () => {
  it("clears the buffer and returns the count cleared", async () => {
    const buffer = [
      { timestamp: 1, level: "info", source: "agent", tags: [] },
      { timestamp: 2, level: "warn", source: "agent", tags: ["x"] },
    ];
    const { ctx, recorded } = makeBaseCtx("DELETE", "/api/logs", null, buffer, {
      clearLogBuffer: () => {
        const previous = buffer.length;
        buffer.length = 0;
        return previous;
      },
    });

    const handled = await handleDiagnosticsRoutes(ctx);

    expect(handled).toBe(true);
    expect(recorded.status).toBe(200);
    expect(recorded.body).toEqual({ cleared: 2 });
    expect(buffer).toEqual([]);
  });

  it("falls back to mutating the buffer when no clearer is provided", async () => {
    const buffer = [
      { timestamp: 1, level: "info", source: "agent", tags: [] },
      { timestamp: 2, level: "info", source: "agent", tags: [] },
      { timestamp: 3, level: "info", source: "agent", tags: [] },
    ];
    const { ctx, recorded } = makeBaseCtx("DELETE", "/api/logs", null, buffer);

    const handled = await handleDiagnosticsRoutes(ctx);

    expect(handled).toBe(true);
    expect(recorded.body).toEqual({ cleared: 3 });
    expect(buffer).toEqual([]);
  });
});

describe("POST /api/logs/export", () => {
  it("rejects an invalid format with 400", async () => {
    const { ctx, recorded } = makeBaseCtx(
      "POST",
      "/api/logs/export",
      { format: "xml" },
      [],
    );

    const handled = await handleDiagnosticsRoutes(ctx);

    expect(handled).toBe(true);
    expect(recorded.status).toBe(400);
  });

  it("returns JSON with the right Content-Disposition", async () => {
    const buffer = [
      {
        timestamp: 1700000000000,
        level: "info",
        message: "boot complete",
        source: "agent",
        tags: ["startup"],
      },
      {
        timestamp: 1700000001000,
        level: "warn",
        message: "warning, watch out",
        source: "plugins",
        tags: ["x"],
      },
    ];
    const { ctx, captured } = makeBaseCtx(
      "POST",
      "/api/logs/export",
      { format: "json" },
      buffer,
    );

    const handled = await handleDiagnosticsRoutes(ctx);

    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    expect(String(captured.headers["Content-Type"])).toContain(
      "application/json",
    );
    expect(String(captured.headers["Content-Disposition"])).toMatch(
      /attachment; filename="logs-.+\.json"/,
    );
    const parsed = JSON.parse(captured.payload) as {
      entries: Array<{ source: string }>;
    };
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].source).toBe("agent");
  });

  it("filters by source and returns CSV when format=csv", async () => {
    const buffer = [
      {
        timestamp: 1700000000000,
        level: "info",
        message: "agent message",
        source: "agent",
        tags: [],
      },
      {
        timestamp: 1700000001000,
        level: "info",
        message: "plugin message",
        source: "plugins",
        tags: [],
      },
    ];
    const { ctx, captured } = makeBaseCtx(
      "POST",
      "/api/logs/export",
      { format: "csv", source: "agent" },
      buffer,
    );

    const handled = await handleDiagnosticsRoutes(ctx);

    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    expect(String(captured.headers["Content-Type"])).toContain("text/csv");
    expect(String(captured.headers["Content-Disposition"])).toMatch(/\.csv"$/);
    // Header + 1 row
    expect(captured.payload.split("\n")).toHaveLength(2);
    expect(captured.payload).toContain("agent message");
    expect(captured.payload).not.toContain("plugin message");
  });

  it("escapes CSV fields containing commas, quotes, and newlines", async () => {
    const buffer = [
      {
        timestamp: 1700000000000,
        level: "info",
        message: 'a "quoted" value, with comma\nand newline',
        source: "agent",
        tags: ["a", "b"],
      },
    ];
    const { ctx, captured } = makeBaseCtx(
      "POST",
      "/api/logs/export",
      { format: "csv" },
      buffer,
    );

    await handleDiagnosticsRoutes(ctx);

    expect(captured.payload).toContain(
      '"a ""quoted"" value, with comma\nand newline"',
    );
  });

  it("respects since filter (epoch ms)", async () => {
    const buffer = [
      {
        timestamp: 1700000000000,
        level: "info",
        message: "old",
        source: "agent",
        tags: [],
      },
      {
        timestamp: 1700000005000,
        level: "info",
        message: "newer",
        source: "agent",
        tags: [],
      },
    ];
    const { ctx, captured } = makeBaseCtx(
      "POST",
      "/api/logs/export",
      { format: "json", since: 1700000003000 },
      buffer,
    );

    await handleDiagnosticsRoutes(ctx);

    const parsed = JSON.parse(captured.payload) as {
      entries: Array<{ message: string }>;
    };
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].message).toBe("newer");
  });
});
