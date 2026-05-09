import type http from "node:http";
import type {
  ReadJsonBodyOptions,
  RouteHelpers,
  RouteRequestMeta,
} from "@elizaos/shared";
import { parseClampedInteger } from "../utils/number-parsing.js";

interface LogEntryLike {
  timestamp: number;
  level: string;
  message?: string;
  source: string;
  tags: string[];
}

interface StreamEventEnvelopeLike {
  type: string;
  eventId: string;
  runId?: string;
  seq?: number;
}

interface AuditEntryLike {
  timestamp: string;
  type: string;
  summary: string;
  severity: string;
  metadata?: Record<string, string | number | boolean | null>;
}

type DiagnosticsSseInit = (res: http.ServerResponse) => void;
type DiagnosticsSseWriteJson = (
  res: http.ServerResponse,
  payload: unknown,
  event?: string,
) => void;

export interface DiagnosticsRouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "json"> {
  url: URL;
  logBuffer: LogEntryLike[];
  /** Drop all entries from the in-memory log buffer. Returns count cleared. */
  clearLogBuffer?: () => number;
  /** Read JSON body for the export endpoint. */
  readJsonBody?: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
  error?: (res: http.ServerResponse, message: string, status?: number) => void;
  eventBuffer: StreamEventEnvelopeLike[];
  relayPort?: number;
  checkRelayReachable?: (relayPort: number) => Promise<boolean>;
  resolveExtensionPath?: () => string | null;
  resolveExtensionArtifacts?: () => {
    chromeBuildPath?: string | null;
    chromePackagePath?: string | null;
    safariWebExtensionPath?: string | null;
    safariAppPath?: string | null;
    safariPackagePath?: string | null;
  };
  initSse?: DiagnosticsSseInit;
  writeSseJson?: DiagnosticsSseWriteJson;
  auditEventTypes: readonly string[];
  auditSeverities: readonly string[];
  getAuditFeedSize: () => number;
  queryAuditFeed: (query: {
    type?: string;
    severity?: string;
    sinceMs?: number;
    limit?: number;
  }) => AuditEntryLike[];
  subscribeAuditFeed: (
    subscriber: (entry: AuditEntryLike) => void,
  ) => () => void;
}

async function defaultCheckRelayReachable(relayPort: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${relayPort}/`, {
      method: "HEAD",
      signal: AbortSignal.timeout(2000),
    });
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

function defaultResolveExtensionPath(): string | null {
  return null;
}

function defaultResolveExtensionArtifacts(): {
  chromeBuildPath?: string | null;
  chromePackagePath?: string | null;
  safariWebExtensionPath?: string | null;
  safariAppPath?: string | null;
  safariPackagePath?: string | null;
} {
  return {};
}

function isAutonomyEvent(event: StreamEventEnvelopeLike): boolean {
  return event.type === "agent_event" || event.type === "heartbeat_event";
}

function defaultInitSse(res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

function defaultWriteSseData(
  res: http.ServerResponse,
  data: string,
  event?: string,
): void {
  if (event) {
    res.write(`event: ${event}\n`);
  }
  const safe = data.replace(/\r?\n/g, "\ndata: ");
  res.write(`data: ${safe}\n\n`);
}

function defaultWriteSseJson(
  res: http.ServerResponse,
  payload: unknown,
  event?: string,
): void {
  defaultWriteSseData(res, JSON.stringify(payload), event);
}

function parseAuditSince(raw: string | null): {
  value?: number;
  error?: string;
} {
  if (raw == null) return {};
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      error: 'Invalid "since" filter: expected epoch ms or ISO timestamp.',
    };
  }

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return { value: Math.trunc(numeric) };
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    return {
      error: 'Invalid "since" filter: expected epoch ms or ISO timestamp.',
    };
  }
  return { value: parsed };
}

function isTruthyQueryParam(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

interface LogFilter {
  source?: string;
  level?: string;
  tag?: string;
  sinceMs?: number;
}

function applyLogFilter(
  buffer: readonly LogEntryLike[],
  filter: LogFilter,
): LogEntryLike[] {
  let entries: readonly LogEntryLike[] = buffer;
  const { source, level, tag, sinceMs } = filter;
  if (source) {
    entries = entries.filter((entry) => entry.source === source);
  }
  if (level) {
    entries = entries.filter((entry) => entry.level === level);
  }
  if (tag) {
    entries = entries.filter((entry) => entry.tags.includes(tag));
  }
  if (sinceMs !== undefined) {
    entries = entries.filter((entry) => entry.timestamp >= sinceMs);
  }
  return entries.slice();
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function logsToCsv(entries: readonly LogEntryLike[]): string {
  const header = "timestamp,level,source,tags,message";
  const lines = entries.map((entry) => {
    const message = typeof entry.message === "string" ? entry.message : "";
    return [
      new Date(entry.timestamp).toISOString(),
      entry.level,
      entry.source,
      entry.tags.join("|"),
      message,
    ]
      .map((field) => csvEscape(String(field)))
      .join(",");
  });
  return [header, ...lines].join("\n");
}

function matchesAuditFilter(
  entry: AuditEntryLike,
  filters: {
    type?: string;
    severity?: string;
    sinceMs?: number;
  },
): boolean {
  if (filters.type && entry.type !== filters.type) return false;
  if (filters.severity && entry.severity !== filters.severity) return false;
  if (
    filters.sinceMs !== undefined &&
    Date.parse(entry.timestamp) < filters.sinceMs
  ) {
    return false;
  }
  return true;
}

export async function handleDiagnosticsRoutes(
  ctx: DiagnosticsRouteContext,
): Promise<boolean> {
  const {
    req,
    res,
    method,
    pathname,
    url,
    logBuffer,
    eventBuffer,
    relayPort: relayPortOverride,
    checkRelayReachable,
    resolveExtensionPath,
    resolveExtensionArtifacts,
    initSse,
    writeSseJson,
    auditEventTypes,
    auditSeverities,
    getAuditFeedSize,
    queryAuditFeed,
    subscribeAuditFeed,
    json,
  } = ctx;

  if (method === "GET" && pathname === "/api/logs") {
    const sinceRaw = url.searchParams.get("since");
    let sinceMs: number | undefined;
    if (sinceRaw) {
      const numeric = Number(sinceRaw);
      if (!Number.isNaN(numeric)) sinceMs = numeric;
    }
    const entries = applyLogFilter(logBuffer, {
      source: url.searchParams.get("source") ?? undefined,
      level: url.searchParams.get("level") ?? undefined,
      tag: url.searchParams.get("tag") ?? undefined,
      sinceMs,
    });

    const sources = [...new Set(logBuffer.map((entry) => entry.source))].sort();
    const tags = [...new Set(logBuffer.flatMap((entry) => entry.tags))].sort();
    json(res, { entries: entries.slice(-200), sources, tags });
    return true;
  }

  if (method === "DELETE" && pathname === "/api/logs") {
    const cleared = ctx.clearLogBuffer
      ? ctx.clearLogBuffer()
      : ((): number => {
          const previous = logBuffer.length;
          logBuffer.length = 0;
          return previous;
        })();
    json(res, { cleared });
    return true;
  }

  if (method === "POST" && pathname === "/api/logs/export") {
    const errorFn = ctx.error;
    if (!ctx.readJsonBody || !errorFn) {
      json(res, { error: "Log export requires JSON body support" }, 500);
      return true;
    }
    const body = await ctx.readJsonBody<{
      format?: unknown;
      source?: unknown;
      level?: unknown;
      tags?: unknown;
      since?: unknown;
      limit?: unknown;
    }>(req, res);
    if (!body) return true;

    const formatRaw =
      typeof body.format === "string" ? body.format.trim().toLowerCase() : "";
    if (formatRaw !== "json" && formatRaw !== "csv") {
      errorFn(res, 'format must be "json" or "csv"', 400);
      return true;
    }

    let sinceMs: number | undefined;
    if (typeof body.since === "string" && body.since.trim()) {
      const numeric = Number(body.since);
      if (Number.isFinite(numeric)) {
        sinceMs = numeric;
      } else {
        const parsed = Date.parse(body.since);
        if (Number.isFinite(parsed)) sinceMs = parsed;
      }
    } else if (typeof body.since === "number" && Number.isFinite(body.since)) {
      sinceMs = body.since;
    }

    let tag: string | undefined;
    if (Array.isArray(body.tags)) {
      const first = body.tags.find(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      );
      if (first) tag = first.trim();
    } else if (typeof body.tags === "string" && body.tags.trim()) {
      tag = body.tags.trim();
    }

    let entries = applyLogFilter(logBuffer, {
      source:
        typeof body.source === "string" && body.source.trim()
          ? body.source.trim()
          : undefined,
      level:
        typeof body.level === "string" && body.level.trim()
          ? body.level.trim()
          : undefined,
      tag,
      sinceMs,
    });

    if (typeof body.limit === "number" && Number.isFinite(body.limit)) {
      const cap = Math.max(1, Math.min(10_000, Math.floor(body.limit)));
      entries = entries.slice(-cap);
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    if (formatRaw === "json") {
      const payload = JSON.stringify({ entries }, null, 2);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="logs-${stamp}.json"`,
        "Content-Length": Buffer.byteLength(payload, "utf-8"),
      });
      res.end(payload);
      return true;
    }

    const csv = logsToCsv(entries);
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="logs-${stamp}.csv"`,
      "Content-Length": Buffer.byteLength(csv, "utf-8"),
    });
    res.end(csv);
    return true;
  }

  if (method === "GET" && pathname === "/api/agent/events") {
    const limit = parseClampedInteger(url.searchParams.get("limit"), {
      min: 1,
      max: 1000,
      fallback: 200,
    });
    const runIdFilter = url.searchParams.get("runId");
    const fromSeqRaw = url.searchParams.get("fromSeq");
    const fromSeq = parseClampedInteger(fromSeqRaw, {
      min: 0,
    });
    if (fromSeqRaw !== null && fromSeq === undefined) {
      json(res, { error: 'Invalid "fromSeq" filter.' }, 400);
      return true;
    }
    const afterEventId = url.searchParams.get("after");
    let autonomyEvents = eventBuffer.filter(isAutonomyEvent);
    if (runIdFilter) {
      autonomyEvents = autonomyEvents.filter(
        (event) => event.runId === runIdFilter,
      );
    }
    if (fromSeq !== undefined) {
      autonomyEvents = autonomyEvents.filter(
        (event) => typeof event.seq === "number" && event.seq >= fromSeq,
      );
    }

    let startIndex = 0;
    if (afterEventId) {
      const index = autonomyEvents.findIndex(
        (event) => event.eventId === afterEventId,
      );
      if (index >= 0) {
        startIndex = index + 1;
      }
    }

    const events = autonomyEvents.slice(startIndex, startIndex + limit);
    const latestEventId =
      events.length > 0 ? events[events.length - 1].eventId : null;

    json(res, {
      events,
      latestEventId,
      totalBuffered: autonomyEvents.length,
      replayed: true,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/security/audit") {
    const typeFilterRaw = url.searchParams.get("type");
    const severityFilterRaw = url.searchParams.get("severity");
    const limitFilter = parseClampedInteger(url.searchParams.get("limit"), {
      min: 1,
      max: 1000,
      fallback: 200,
    });
    const sinceFilter = parseAuditSince(url.searchParams.get("since"));

    if (sinceFilter.error) {
      json(res, { error: sinceFilter.error }, 400);
      return true;
    }

    let typeFilter: string | undefined;
    if (typeFilterRaw) {
      const candidate = typeFilterRaw.trim();
      if (!auditEventTypes.includes(candidate)) {
        json(
          res,
          {
            error: `Invalid "type" filter. Expected one of: ${auditEventTypes.join(", ")}`,
          },
          400,
        );
        return true;
      }
      typeFilter = candidate;
    }

    let severityFilter: string | undefined;
    if (severityFilterRaw) {
      const candidate = severityFilterRaw.trim();
      if (!auditSeverities.includes(candidate)) {
        json(
          res,
          {
            error: `Invalid "severity" filter. Expected one of: ${auditSeverities.join(", ")}`,
          },
          400,
        );
        return true;
      }
      severityFilter = candidate;
    }

    const streamRequested =
      isTruthyQueryParam(url.searchParams.get("stream")) ||
      (req.headers.accept ?? "").includes("text/event-stream");
    const filter = {
      type: typeFilter,
      severity: severityFilter,
      sinceMs: sinceFilter.value,
    };

    if (!streamRequested) {
      const entries = queryAuditFeed({
        ...filter,
        limit: limitFilter,
      });
      json(res, {
        entries,
        totalBuffered: getAuditFeedSize(),
        replayed: true,
      });
      return true;
    }

    const startSse = initSse ?? defaultInitSse;
    const sendSseJson = writeSseJson ?? defaultWriteSseJson;
    startSse(res);
    sendSseJson(res, {
      type: "snapshot",
      entries: queryAuditFeed({ ...filter, limit: limitFilter }),
      totalBuffered: getAuditFeedSize(),
    });

    const unsubscribe = subscribeAuditFeed((entry) => {
      if (!matchesAuditFilter(entry, filter)) return;
      sendSseJson(res, { type: "entry", entry });
    });

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (!res.writableEnded) {
        res.end();
      }
    };

    req.on("close", close);
    req.on("aborted", close);
    res.on("close", close);

    return true;
  }

  if (method === "GET" && pathname === "/api/extension/status") {
    const relayPort = relayPortOverride ?? 18792;
    const relayReachable = await (
      checkRelayReachable ?? defaultCheckRelayReachable
    )(relayPort);
    const extensionPath = (
      resolveExtensionPath ?? defaultResolveExtensionPath
    )();
    const extensionArtifacts = (
      resolveExtensionArtifacts ?? defaultResolveExtensionArtifacts
    )();

    json(res, {
      relayReachable,
      relayPort,
      extensionPath,
      chromeBuildPath: extensionArtifacts.chromeBuildPath ?? null,
      chromePackagePath: extensionArtifacts.chromePackagePath ?? null,
      safariWebExtensionPath: extensionArtifacts.safariWebExtensionPath ?? null,
      safariAppPath: extensionArtifacts.safariAppPath ?? null,
      safariPackagePath: extensionArtifacts.safariPackagePath ?? null,
    });
    return true;
  }

  return false;
}
