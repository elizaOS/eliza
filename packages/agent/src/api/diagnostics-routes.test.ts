/**
 * Route-level coverage for the diagnostics HTTP surface: the filtered log
 * read/clear endpoints, the validated JSON/CSV export download, the replayable
 * agent-event feed, the audit feed in both snapshot and live-SSE modes, and the
 * browser-bridge extension reachability probe. The harness is deterministic —
 * every collaborator (body reader, audit feed, SSE plumbing, relay probe,
 * request/response emitters) is an in-memory fake driven through the exported
 * handler, so each assertion observes what the routes actually write rather
 * than what a live transport echoes back.
 */
import { EventEmitter } from "node:events";
import type http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticsRouteContext } from "./diagnostics-routes.ts";
import { handleDiagnosticsRoutes } from "./diagnostics-routes.ts";

const ISO = "2026-08-01T00:00:00.000Z";
const ISO_MS = Date.parse(ISO);

interface JsonPayload {
  entries: Array<Record<string, unknown>>;
  sources: string[];
  tags: string[];
  cleared: number;
  error: string;
  events: Array<Record<string, unknown>>;
  latestEventId: string | null;
  totalBuffered: number;
  replayed: boolean;
}

type TestJson = (
  res: http.ServerResponse,
  body: unknown,
  status?: number,
) => void;

type JsonCall = [res: http.ServerResponse, body: JsonPayload, status?: number];

type AuditQuery = {
  type?: string;
  severity?: string;
  sinceMs?: number;
  limit?: number;
};

interface TestAuditEntry {
  timestamp: string;
  type: string;
  summary: string;
  severity: string;
}

type RouteHelpersError = (
  res: http.ServerResponse,
  message: string,
  status?: number,
) => void;

type AuditSubscriber = (entry: {
  timestamp: string;
  type: string;
  summary: string;
  severity: string;
}) => void;

type AuditSubscribe = (subscriber: AuditSubscriber) => () => void;

interface DiagnosticsTestContext
  extends Omit<
    DiagnosticsRouteContext,
    "json" | "subscribeAuditFeed" | "error"
  > {
  json: ReturnType<typeof vi.fn<TestJson>> & {
    mock: { calls: JsonCall[] };
  };
  error: ReturnType<typeof vi.fn<RouteHelpersError>>;
  subscribeAuditFeed: ReturnType<typeof vi.fn<AuditSubscribe>>;
  __res: FakeServerResponse;
  __unsubscribe: ReturnType<typeof vi.fn<() => void>>;
}

interface TestEvent {
  type: string;
  eventId: string;
  runId?: string;
  seq?: number;
}

class FakeServerResponse extends EventEmitter {
  writableEnded = false;
  writes: string[] = [];
  head: { status: number; headers: Record<string, unknown> } | null = null;

  writeHead(status: number, headers: Record<string, unknown> = {}) {
    this.head = { status, headers };
    return this;
  }

  write(chunk: string) {
    this.writes.push(chunk);
    return true;
  }

  end(payload?: string) {
    if (payload !== undefined) this.writes.push(payload);
    this.writableEnded = true;
    return this;
  }
}

function makeReq(headers: Record<string, string> = {}): http.IncomingMessage {
  const req = new EventEmitter() as EventEmitter & {
    headers: Record<string, string>;
  };
  req.headers = headers;
  return req as unknown as http.IncomingMessage;
}

function logEntry(
  timestamp: number,
  message: string,
  extras: { source?: string; level?: string; tags?: string[] } = {},
) {
  return {
    timestamp,
    level: extras.level ?? "info",
    message,
    source: extras.source ?? "agent",
    tags: extras.tags ?? [],
  };
}

function auditEntry(
  timestamp: string,
  extras: {
    type?: string;
    severity?: string;
    summary?: string;
  } = {},
) {
  return {
    timestamp,
    type: extras.type ?? "intrusion",
    summary: extras.summary ?? "port scan blocked",
    severity: extras.severity ?? "high",
  };
}

function makeCtx(extra: Partial<DiagnosticsRouteContext> = {}) {
  const json = vi.fn<TestJson>();
  const queryAuditFeed = vi.fn<
    (query: {
      type?: string;
      severity?: string;
      sinceMs?: number;
      limit?: number;
    }) => ReturnType<DiagnosticsRouteContext["queryAuditFeed"]>
  >(() => []);
  const unsubscribe = vi.fn<() => void>();
  const subscribeAuditFeed = vi.fn<
    (
      subscriber: Parameters<DiagnosticsRouteContext["subscribeAuditFeed"]>[0],
    ) => () => void
  >(() => unsubscribe);
  const res = new FakeServerResponse();
  const base = {
    req: makeReq(),
    res: res as unknown as http.ServerResponse,
    method: "GET",
    pathname: "/api/logs",
    url: new URL("http://localhost/api/logs"),
    json,
    logBuffer: [] as DiagnosticsRouteContext["logBuffer"],
    eventBuffer: [] as DiagnosticsRouteContext["eventBuffer"],
    auditEventTypes: ["intrusion"] as string[],
    auditSeverities: ["high"] as string[],
    getAuditFeedSize: vi.fn(() => 7),
    queryAuditFeed,
    subscribeAuditFeed,
  };
  return {
    ...base,
    ...extra,
    __res: res,
    __unsubscribe: unsubscribe,
  } as DiagnosticsTestContext;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("route dispatch", () => {
  it("returns false and writes nothing for an unmatched route", async () => {
    const ctx = makeCtx({
      method: "POST",
      pathname: "/api/logs",
      url: new URL("http://localhost/api/logs"),
    });
    const handled = await handleDiagnosticsRoutes(ctx);
    expect(handled).toBe(false);
    expect(ctx.json).not.toHaveBeenCalled();
    expect(ctx.__res.head).toBeNull();
    expect(ctx.__res.writableEnded).toBe(false);
  });
});

describe("GET /api/logs", () => {
  it("returns empty pages, sources, and tags for an empty buffer", async () => {
    const ctx = makeCtx();
    const handled = await handleDiagnosticsRoutes(ctx);
    expect(handled).toBe(true);
    expect(ctx.json).toHaveBeenCalledTimes(1);
    const [, body, status] = ctx.json.mock.calls[0];
    expect(status ?? 200).toBe(200);
    expect(body.entries).toEqual([]);
    expect(body.sources).toEqual([]);
    expect(body.tags).toEqual([]);
  });

  it("combines source, level, tag, and since filters inclusively", async () => {
    const buffer = [
      logEntry(1_000, "old-a", { source: "alpha", tags: ["x"] }),
      logEntry(1_500, "kept", { source: "beta", tags: ["x", "y"] }),
      logEntry(2_000, "wrong-level", {
        source: "beta",
        level: "error",
        tags: ["y"],
      }),
      logEntry(ISO_MS, "iso-boundary-included", {
        source: "beta",
        tags: ["y"],
      }),
    ];
    const ctx = makeCtx({
      logBuffer: buffer,
      url: new URL(
        "http://localhost/api/logs?source=beta&level=info&tag=y&since=1500",
      ),
    });
    await handleDiagnosticsRoutes(ctx);
    const [, body] = ctx.json.mock.calls[0];
    expect(body.entries.map((row) => row.message)).toEqual([
      "kept",
      "iso-boundary-included",
    ]);
  });

  it("reports deduplicated lexically sorted sources and tags from the whole buffer", async () => {
    const buffer = [
      logEntry(1, "one", { source: "zeta", tags: ["b", "a"] }),
      logEntry(2, "two", { source: "alpha", tags: ["b"] }),
      logEntry(3, "three", { source: "mike", tags: [] }),
    ];
    const ctx = makeCtx({
      logBuffer: buffer,
      url: new URL("http://localhost/api/logs?source=mike"),
    });
    await handleDiagnosticsRoutes(ctx);
    const [, body] = ctx.json.mock.calls[0];
    expect(body.sources).toEqual(["alpha", "mike", "zeta"]);
    expect(body.tags).toEqual(["a", "b"]);
    expect(body.entries.map((row) => row.message)).toEqual(["three"]);
  });

  it("caps a large matching buffer at the newest 200 entries in order", async () => {
    const buffer = Array.from({ length: 205 }, (_, i) =>
      logEntry(i + 1, `msg-${i + 1}`),
    );
    const ctx = makeCtx({ logBuffer: buffer });
    await handleDiagnosticsRoutes(ctx);
    const [, body] = ctx.json.mock.calls[0];
    expect(body.entries).toHaveLength(200);
    expect(body.entries[0].message).toBe("msg-6");
    expect(body.entries[199].message).toBe("msg-205");
  });

  it("treats an empty since parameter as absent", async () => {
    const ctx = makeCtx({
      logBuffer: [logEntry(1, "old"), logEntry(ISO_MS, "new")],
      url: new URL("http://localhost/api/logs?since=&level=info"),
    });
    await handleDiagnosticsRoutes(ctx);
    const [, body, status] = ctx.json.mock.calls[0];
    expect(status ?? 200).toBe(200);
    expect(body.entries).toHaveLength(2);
  });

  it.each([
    [-5_000, 2],
    [`?since=${encodeURIComponent("2026-08-01")}`, 1],
  ])(
    "accepts negative epoch and date-only since cursors (%s)",
    async (search, expectedCount) => {
      const resolved = typeof search === "number" ? `?since=${search}` : search;
      const ctx = makeCtx({
        logBuffer: [logEntry(-1_000, "ancient"), logEntry(ISO_MS, "now")],
        url: new URL(`http://localhost/api/logs${resolved}`),
      });
      await handleDiagnosticsRoutes(ctx);
      const [, body, status] = ctx.json.mock.calls[0];
      expect(status ?? 200).toBe(200);
      expect(body.entries).toHaveLength(expectedCount);
    },
  );
});

describe("DELETE /api/logs", () => {
  it("uses the injected clear callback without touching the buffer", async () => {
    const clearLogBuffer = vi.fn(() => 42);
    const ctx = makeCtx({
      method: "DELETE",
      logBuffer: [logEntry(1, "kept")],
      clearLogBuffer,
    });
    const handled = await handleDiagnosticsRoutes(ctx);
    expect(handled).toBe(true);
    expect(clearLogBuffer).toHaveBeenCalledTimes(1);
    expect(ctx.logBuffer).toHaveLength(1);
    const [, body] = ctx.json.mock.calls[0];
    expect(body).toEqual({ cleared: 42 });
  });

  it("falls back to truncating the buffer in place", async () => {
    const ctx = makeCtx({
      method: "DELETE",
      logBuffer: [logEntry(1, "a"), logEntry(2, "b"), logEntry(3, "c")],
    });
    await handleDiagnosticsRoutes(ctx);
    expect(ctx.logBuffer).toHaveLength(0);
    const [, body] = ctx.json.mock.calls[0];
    expect(body.cleared).toBe(3);
  });

  it("reports zero cleared for an already empty buffer", async () => {
    const ctx = makeCtx({ method: "DELETE" });
    await handleDiagnosticsRoutes(ctx);
    const [, body] = ctx.json.mock.calls[0];
    expect(body.cleared).toBe(0);
  });
});

describe("POST /api/logs/export", () => {
  function makeExportCtx(
    body: unknown,
    extra: Partial<DiagnosticsRouteContext> = {},
  ) {
    return makeCtx({
      method: "POST",
      pathname: "/api/logs/export",
      url: new URL("http://localhost/api/logs/export"),
      readJsonBody: (async () =>
        body) as DiagnosticsRouteContext["readJsonBody"],
      error: vi.fn(),
      ...extra,
    });
  }

  it.each<[string, Partial<DiagnosticsRouteContext>]>([
    ["no body reader", { error: vi.fn() }],
    [
      "no error helper",
      {
        readJsonBody: (async () =>
          ({}) as never) as DiagnosticsRouteContext["readJsonBody"],
      },
    ],
  ])("answers 500 when %s is configured", async (_label, extra) => {
    const ctx = makeCtx({
      method: "POST",
      pathname: "/api/logs/export",
      url: new URL("http://localhost/api/logs/export"),
      ...extra,
    });
    const handled = await handleDiagnosticsRoutes(ctx);
    expect(handled).toBe(true);
    expect(ctx.json).toHaveBeenCalledTimes(1);
    const [, body, status] = ctx.json.mock.calls[0];
    expect(status).toBe(500);
    expect(body.error).toBe("Log export requires JSON body support");
  });

  it("stays silent when the body reader already responded", async () => {
    const ctx = makeExportCtx(null);
    const handled = await handleDiagnosticsRoutes(ctx);
    expect(handled).toBe(true);
    expect(ctx.json).not.toHaveBeenCalled();
    expect(ctx.error).not.toHaveBeenCalled();
    expect(ctx.__res.head).toBeNull();
  });

  it("rejects schema-invalid bodies with 400 and the first issue", async () => {
    const ctx = makeExportCtx({ format: "json", surprise: 1 });
    await handleDiagnosticsRoutes(ctx);
    expect(ctx.error).toHaveBeenCalledTimes(1);
    const [resArg, message, status] = ctx.error.mock.calls[0];
    expect(resArg).toBe(ctx.__res);
    expect(message).toContain("surprise");
    expect(status).toBe(400);
  });

  it("rejects a body without a format with 400", async () => {
    const ctx = makeExportCtx({});
    await handleDiagnosticsRoutes(ctx);
    const [, message, status] = ctx.error.mock.calls[0];
    expect(typeof message).toBe("string");
    expect((message as string).length).toBeGreaterThan(0);
    expect(status).toBe(400);
  });

  it("trims filters, takes the first nonblank tag, and tails the floored limit", async () => {
    vi.useFakeTimers({ now: ISO_MS });
    const buffer = [
      logEntry(1_000, "old", { source: "beta" }),
      logEntry(1_500, "one", { source: " beta ", tags: ["skip", "y"] }),
      logEntry(1_600, "two", { source: "beta", tags: ["y"] }),
      logEntry(1_700, "three", { source: "beta", tags: ["y"] }),
    ];
    const ctx = makeExportCtx(
      {
        format: "json",
        source: " beta ",
        tags: ["  ", " y "],
        since: 1_500,
        limit: 2.9,
      },
      { logBuffer: buffer },
    );
    await handleDiagnosticsRoutes(ctx);
    const payload = ctx.__res.writes[0];
    const parsed = JSON.parse(payload);
    expect(
      parsed.entries.map((row: { message: string }) => row.message),
    ).toEqual(["two", "three"]);
    expect(ctx.error).not.toHaveBeenCalled();
  });

  it("writes JSON attachment headers with exact byte length and frozen stamp", async () => {
    vi.useFakeTimers({ now: ISO_MS });
    const ctx = makeExportCtx(
      { format: "json" },
      { logBuffer: [logEntry(1_000, "hello")] },
    );
    await handleDiagnosticsRoutes(ctx);
    const payload = ctx.__res.writes[0];
    expect(ctx.__res.head).toEqual({
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition":
          'attachment; filename="logs-2026-08-01T00-00-00-000Z.json"',
        "Content-Length": Buffer.byteLength(payload, "utf-8"),
      },
    });
    expect(JSON.parse(payload)).toEqual({
      entries: [
        {
          timestamp: 1_000,
          level: "info",
          message: "hello",
          source: "agent",
          tags: [],
        },
      ],
    });
    expect(payload).toBe(`${JSON.stringify(JSON.parse(payload), null, 2)}`);
  });

  it.each([
    { since: "not-a-date" },
    { since: 1.5 },
    { since: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects malformed or unsafe since values (%j)", async (partial) => {
    const ctx = makeExportCtx({ format: "json", ...partial });
    await handleDiagnosticsRoutes(ctx);
    const [, message, status] = ctx.error.mock.calls[0];
    expect(message).toMatch(/since/i);
    expect(status).toBe(400);
    expect(ctx.__res.head).toBeNull();
  });

  it("emits a header-only CSV when nothing matches", async () => {
    const ctx = makeExportCtx(
      { format: "csv", source: "absent-source" },
      { logBuffer: [logEntry(1, "hidden")] },
    );
    await handleDiagnosticsRoutes(ctx);
    expect(ctx.__res.head?.headers["Content-Type"]).toBe(
      "text/csv; charset=utf-8",
    );
    expect(ctx.__res.writes[0]).toBe("timestamp,level,source,tags,message");
  });

  it("escapes commas, quotes, and line breaks and joins tags with pipes", async () => {
    const tricky = 'said "hi",\nthen left';
    const ctx = makeExportCtx(
      { format: "csv" },
      {
        logBuffer: [
          logEntry(ISO_MS, tricky, {
            source: "wallet",
            level: "warn",
            tags: ["a", "b"],
          }),
          logEntry(ISO_MS + 1, undefined as unknown as string),
        ],
      },
    );
    await handleDiagnosticsRoutes(ctx);
    const csv = ctx.__res.writes[0];
    expect(csv).toBe(
      [
        "timestamp,level,source,tags,message",
        `${ISO},warn,wallet,a|b,"said ""hi"",\nthen left"`,
        `${new Date(ISO_MS + 1).toISOString()},info,agent,,`,
      ].join("\n"),
    );
  });

  it("clamps limits below one up to a single tail entry", async () => {
    const ctx = makeExportCtx(
      { format: "json", limit: 0 },
      {
        logBuffer: [logEntry(1, "first"), logEntry(2, "second")],
      },
    );
    await handleDiagnosticsRoutes(ctx);
    const parsed = JSON.parse(ctx.__res.writes[0]);
    expect(
      parsed.entries.map((row: { message: string }) => row.message),
    ).toEqual(["second"]);
  });
});

describe("GET /api/agent/events", () => {
  function makeEventsCtx(search: string, eventBuffer: TestEvent[]) {
    return makeCtx({
      pathname: "/api/agent/events",
      url: new URL(`http://localhost/api/agent/events${search}`),
      eventBuffer,
    });
  }

  it("keeps only autonomy and heartbeat events in buffer order", async () => {
    const buffer = [
      { type: "agent_event", eventId: "a", seq: 1 },
      { type: "user_message", eventId: "n1" },
      { type: "heartbeat_event", eventId: "h", seq: 2 },
    ];
    const ctx = makeEventsCtx("", buffer);
    const handled = await handleDiagnosticsRoutes(ctx);
    expect(handled).toBe(true);
    const [, body] = ctx.json.mock.calls[0];
    expect(body.events.map((row) => row.eventId)).toEqual(["a", "h"]);
    expect(body.totalBuffered).toBe(2);
    expect(body.latestEventId).toBe("h");
    expect(body.replayed).toBe(true);
  });

  it("applies runId, fromSeq, and after cursors before slicing", async () => {
    const buffer = [
      { type: "agent_event", eventId: "a", runId: "r1", seq: 5 },
      { type: "agent_event", eventId: "b", runId: "r2", seq: 10 },
      { type: "heartbeat_event", eventId: "c", runId: "r1", seq: 11 },
      { type: "agent_event", eventId: "d", runId: "r1" },
    ];
    const ctx = makeEventsCtx("?runId=r1&after=a", buffer);
    await handleDiagnosticsRoutes(ctx);
    const [, body] = ctx.json.mock.calls[0];
    expect(body.events.map((row) => row.eventId)).toEqual(["c", "d"]);
    expect(body.totalBuffered).toBe(3);
    expect(body.latestEventId).toBe("d");
  });

  it("excludes events without a numeric seq when fromSeq is supplied", async () => {
    const buffer = [
      { type: "agent_event", eventId: "a", runId: "r1" },
      { type: "heartbeat_event", eventId: "c", runId: "r1", seq: 11 },
    ];
    const ctx = makeEventsCtx("?runId=r1&fromSeq=10", buffer);
    await handleDiagnosticsRoutes(ctx);
    const [, body] = ctx.json.mock.calls[0];
    expect(body.events.map((row) => row.eventId)).toEqual(["c"]);
  });

  it("clamps a negative fromSeq to zero instead of rejecting it", async () => {
    const buffer = [
      { type: "agent_event", eventId: "a", runId: "r1", seq: 0 },
      { type: "agent_event", eventId: "b", runId: "r1", seq: 1 },
    ];
    const ctx = makeEventsCtx("?fromSeq=-5", buffer);
    await handleDiagnosticsRoutes(ctx);
    const [, body, status] = ctx.json.mock.calls[0];
    expect(status ?? 200).toBe(200);
    expect(body.totalBuffered).toBe(2);
  });

  it.each(["abc", "2.5"])(
    "rejects non-canonical fromSeq %s with 400",
    async (raw) => {
      const ctx = makeEventsCtx(`?fromSeq=${raw}`, []);
      await handleDiagnosticsRoutes(ctx);
      const [, body, status] = ctx.json.mock.calls[0];
      expect(status).toBe(400);
      expect(body.error).toBe('Invalid "fromSeq" filter.');
    },
  );

  it("starts from the beginning when the after cursor is unknown", async () => {
    const buffer = [
      { type: "agent_event", eventId: "a" },
      { type: "agent_event", eventId: "b" },
    ];
    const ctx = makeEventsCtx("?after=missing", buffer);
    await handleDiagnosticsRoutes(ctx);
    const [, body] = ctx.json.mock.calls[0];
    expect(body.events).toHaveLength(2);
    expect(body.latestEventId).toBe("b");
  });

  it.each([
    ["", 3],
    ["?limit=nonsense", 3],
    ["?limit=0", 1],
    ["?limit=2", 2],
    ["?limit=99999", 3],
  ])("parses and clamps limit %s to %i entries", async (search, expected) => {
    const buffer = [
      { type: "agent_event", eventId: "a" },
      { type: "agent_event", eventId: "b" },
      { type: "agent_event", eventId: "c" },
    ];
    const ctx = makeEventsCtx(search, buffer);
    await handleDiagnosticsRoutes(ctx);
    const [, body] = ctx.json.mock.calls[0];
    expect(body.events).toHaveLength(expected);
    if (expected === 1) {
      expect(body.latestEventId).toBe("a");
    }
  });

  it("reports a null latest cursor when nothing survives the filters", async () => {
    const ctx = makeEventsCtx("?runId=absent-run", [
      { type: "agent_event", eventId: "a" },
    ]);
    await handleDiagnosticsRoutes(ctx);
    const [, body] = ctx.json.mock.calls[0];
    expect(body.events).toEqual([]);
    expect(body.latestEventId).toBeNull();
    expect(body.totalBuffered).toBe(0);
  });
});

describe("GET /api/security/audit", () => {
  function makeAuditCtx(
    search: string,
    extra: Partial<DiagnosticsRouteContext> = {},
  ) {
    return makeCtx({
      pathname: "/api/security/audit",
      url: new URL(`http://localhost/api/security/audit${search}`),
      ...extra,
    });
  }

  it("queries the feed with parsed filters and answers a snapshot", async () => {
    const entries = [auditEntry(ISO)];
    const queryAuditFeed = vi.fn(() => entries);
    const ctx = makeAuditCtx(
      `?type=intrusion&severity=high&since=${encodeURIComponent(ISO)}&limit=50`,
      { queryAuditFeed },
    );
    const handled = await handleDiagnosticsRoutes(ctx);
    expect(handled).toBe(true);
    expect(queryAuditFeed).toHaveBeenCalledWith({
      type: "intrusion",
      severity: "high",
      sinceMs: ISO_MS,
      limit: 50,
    });
    const [, body] = ctx.json.mock.calls[0];
    expect(body.entries).toEqual(entries);
    expect(body.totalBuffered).toBe(7);
    expect(body.replayed).toBe(true);
  });

  it("omits the since cursor entirely when it is not supplied", async () => {
    const queryAuditFeed = vi.fn(
      (_query: AuditQuery) => [] as TestAuditEntry[],
    );
    const ctx = makeAuditCtx("?limit=5", { queryAuditFeed });
    await handleDiagnosticsRoutes(ctx);
    expect(queryAuditFeed).toHaveBeenCalledWith({
      type: undefined,
      severity: undefined,
      sinceMs: undefined,
      limit: 5,
    });
    expect(queryAuditFeed.mock.calls[0][0]).not.toHaveProperty("since");
  });

  it.each([" 100", "1e2", "not-a-date"])(
    "rejects invalid since cursors (%s) with 400",
    async (raw) => {
      const ctx = makeAuditCtx(`?since=${encodeURIComponent(raw)}`);
      await handleDiagnosticsRoutes(ctx);
      const [, body, status] = ctx.json.mock.calls[0];
      expect(status).toBe(400);
      expect(body.error).toMatch(/since/i);
    },
  );

  it("trims accepted type and severity filters against the configured choices", async () => {
    const queryAuditFeed = vi.fn(() => []);
    const ctx = makeAuditCtx("?type=%20intrusion%20&severity=%20high%20", {
      queryAuditFeed,
    });
    await handleDiagnosticsRoutes(ctx);
    expect(queryAuditFeed).toHaveBeenCalledWith(
      expect.objectContaining({ type: "intrusion", severity: "high" }),
    );
  });

  it.each([
    ["nosy-severity", "severity", "high"],
    ["ghost-type", "type", "intrusion"],
  ])(
    "rejects unknown %s %s with 400 listing the allowed choices",
    async (_value, param, allowed) => {
      const ctx = makeAuditCtx(`?${param}=${_value}`);
      await handleDiagnosticsRoutes(ctx);
      const [, body, status] = ctx.json.mock.calls[0];
      expect(status).toBe(400);
      expect(body.error).toContain(param);
      expect(body.error).toContain(allowed);
    },
  );

  it.each(["1", "true", "YES", "on", " ON "])(
    "opens a live SSE stream for stream=%s",
    async (raw) => {
      const initSse = vi.fn();
      const ctx = makeAuditCtx(`?stream=${encodeURIComponent(raw)}`, {
        initSse,
      });
      const handled = await handleDiagnosticsRoutes(ctx);
      expect(handled).toBe(true);
      expect(initSse).toHaveBeenCalledTimes(1);
      expect(ctx.json).not.toHaveBeenCalled();
    },
  );

  it.each(["0", "false", "off", "maybe"])(
    "keeps snapshot mode for stream=%s",
    async (raw) => {
      const initSse = vi.fn();
      const ctx = makeAuditCtx(`?stream=${encodeURIComponent(raw)}`, {
        initSse,
      });
      await handleDiagnosticsRoutes(ctx);
      expect(initSse).not.toHaveBeenCalled();
      expect(ctx.json).toHaveBeenCalledTimes(1);
    },
  );

  it("streams when the Accept header requests text/event-stream", async () => {
    const initSse = vi.fn();
    const ctx = makeAuditCtx("", {
      initSse,
      req: makeReq({ accept: "text/event-stream" }),
    });
    await handleDiagnosticsRoutes(ctx);
    expect(initSse).toHaveBeenCalled();
    expect(ctx.json).not.toHaveBeenCalled();
  });

  it("initializes once and sends the filtered snapshot through injected helpers", async () => {
    const initSse = vi.fn();
    const writeSseJson = vi.fn();
    const entries = [auditEntry(ISO)];
    const queryAuditFeed = vi.fn(() => entries);
    const ctx = makeAuditCtx("?severity=high&stream=on", {
      initSse,
      writeSseJson,
      queryAuditFeed,
    });
    await handleDiagnosticsRoutes(ctx);
    expect(initSse).toHaveBeenCalledTimes(1);
    expect(initSse).toHaveBeenCalledWith(ctx.__res);
    expect(writeSseJson.mock.calls[0]).toEqual([
      ctx.__res,
      { type: "snapshot", entries, totalBuffered: 7 },
    ]);
    expect(writeSseJson).toHaveBeenCalledTimes(1);
  });

  it("forwards subscribed entries that pass the active filter", async () => {
    const writeSseJson = vi.fn();
    const ctx = makeAuditCtx(
      `?type=intrusion&severity=high&since=${encodeURIComponent(ISO)}&stream=on`,
      { writeSseJson },
    );
    await handleDiagnosticsRoutes(ctx);
    const subscriber = ctx.subscribeAuditFeed.mock.calls[0][0] as (
      entry: unknown,
    ) => void;

    const matching = auditEntry(ISO, { summary: "fresh" });
    subscriber(matching);
    subscriber(auditEntry(ISO, { severity: "low" }));
    subscriber(auditEntry(ISO, { type: "scan" }));
    subscriber(auditEntry("1999-01-01T00:00:00.000Z"));

    expect(writeSseJson).toHaveBeenCalledTimes(2);
    expect(writeSseJson.mock.calls[1]).toEqual([
      ctx.__res,
      { type: "entry", entry: matching },
    ]);
  });

  it("includes timestamps equal to since and suppresses older entries", async () => {
    const writeSseJson = vi.fn();
    const ctx = makeAuditCtx(`?since=${encodeURIComponent(ISO)}&stream=on`, {
      writeSseJson,
    });
    await handleDiagnosticsRoutes(ctx);
    const subscriber = ctx.subscribeAuditFeed.mock.calls[0][0] as (
      entry: unknown,
    ) => void;
    subscriber(auditEntry(ISO));
    expect(writeSseJson).toHaveBeenCalledTimes(2);

    writeSseJson.mockClear();
    subscriber(auditEntry(new Date(Date.parse(ISO) - 1).toISOString()));
    expect(writeSseJson).not.toHaveBeenCalled();
  });

  it("unsubscribes and ends the response exactly once across close signals", async () => {
    const initSse = vi.fn();
    const writeSseJson = vi.fn();
    const ctx = makeAuditCtx("?stream=on", { initSse, writeSseJson });
    await handleDiagnosticsRoutes(ctx);

    const req = ctx.req as unknown as EventEmitter;
    const res = ctx.__res as unknown as EventEmitter;
    req.emit("close");
    req.emit("aborted");
    res.emit("close");

    expect(ctx.__unsubscribe).toHaveBeenCalledTimes(1);
    expect(ctx.__res.writableEnded).toBe(true);
    expect(writeSseJson).toHaveBeenCalledTimes(1);
  });

  it("frames default SSE output with snapshot headers and newline-safe data", async () => {
    const entries = [auditEntry(ISO, { summary: "multi\nline" })];
    const queryAuditFeed = vi.fn(() => entries);
    const ctx = makeAuditCtx("?stream=on", { queryAuditFeed });
    await handleDiagnosticsRoutes(ctx);

    const snapshotPayload = {
      type: "snapshot",
      entries,
      totalBuffered: 7,
    };
    const expectedFrame = `data: ${JSON.stringify(snapshotPayload)}\n\n`;
    expect(ctx.__res.head).toEqual({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
    expect(ctx.__res.writes[0]).toBe(expectedFrame);
    expect(ctx.__res.writes[0].startsWith("event:")).toBe(false);
  });
});

describe("GET /api/extension/status", () => {
  function makeExtensionCtx(extra: Partial<DiagnosticsRouteContext> = {}) {
    return makeCtx({
      pathname: "/api/extension/status",
      url: new URL("http://localhost/api/extension/status"),
      checkRelayReachable: vi.fn(async () => true),
      ...extra,
    });
  }

  it.each([3_000, 0])(
    "probes the overridden relay port %i through the injected checker",
    async (relayPort) => {
      const checkRelayReachable = vi.fn(async () => false);
      const ctx = makeExtensionCtx({ relayPort, checkRelayReachable });
      const handled = await handleDiagnosticsRoutes(ctx);
      expect(handled).toBe(true);
      expect(checkRelayReachable).toHaveBeenCalledWith(relayPort);
      const [, body] = ctx.json.mock.calls[0];
      expect(body).toEqual({
        relayReachable: false,
        relayPort,
        extensionPath: null,
      });
    },
  );

  it("defaults to the standard relay port when no override is set", async () => {
    const checkRelayReachable = vi.fn(async () => true);
    const ctx = makeExtensionCtx({ checkRelayReachable });
    await handleDiagnosticsRoutes(ctx);
    expect(checkRelayReachable).toHaveBeenCalledWith(18_792);
    const [, body] = ctx.json.mock.calls[0];
    expect(body).toEqual({
      relayReachable: true,
      relayPort: 18_792,
      extensionPath: null,
    });
  });
});
