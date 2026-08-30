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

  it("returns every filtered buffered entry without a hidden tail cap", async () => {
    const ctx = makeCtx("");
    ctx.logBuffer = Array.from({ length: 260 }, (_, index) =>
      entry(index + 1, `entry-${index}`),
    );

    await handleDiagnosticsRoutes(ctx);

    const [, body, status] = ctx.json.mock.calls[0];
    expect(status ?? 200).toBe(200);
    expect(body.entries).toHaveLength(260);
    expect(body.entries[0].message).toBe("entry-0");
    expect(body.entries.at(-1).message).toBe("entry-259");
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
