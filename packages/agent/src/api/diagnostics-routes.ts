/**
 * Diagnostics and observability HTTP routes for the local control API. Mounts:
 * GET/DELETE `/api/logs` (filtered read + clear of the in-memory log buffer;
 * `since` is a canonical epoch-ms or ISO cursor, same grammar as audit),
 * POST `/api/logs/export` (validated JSON/CSV download), GET `/api/agent/events`
 * (replayable autonomy/heartbeat event feed with runId/seq/after cursors), GET
 * `/api/security/audit` (filtered audit feed as a JSON snapshot or a live SSE
 * stream), and GET `/api/extension/status` (browser-bridge relay reachability).
 * Every supported route requires exact OWNER authority. Destructive clear and
 * export require literal confirmation; emitted log text is freshly projected
 * and redacted without mutating the process-local buffer.
 */
import type http from "node:http";
import type {
  ReadJsonBodyOptions,
  RouteHelpers,
  RouteRequestMeta,
} from "@elizaos/core";
import { logger, redactSensitiveText } from "@elizaos/core";
import {
  ConfirmedPostLogExportRequestSchema,
  DeleteLogsRequestSchema,
  parseClampedInteger,
} from "@elizaos/shared";
import type { AgentHttpRequestAuthorization } from "../runtime/host-bridge.ts";

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
  authorization: AgentHttpRequestAuthorization;
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
  if (!trimmed || raw !== trimmed) {
    return {
      error: 'Invalid "since" filter: expected epoch ms or ISO timestamp.',
    };
  }

  // Canonical integer epoch only. Number("1e2") is 100 and Number("Infinity")
  // is Infinity — both used to silently filter the live log viewer (or empty
  // it) instead of rejecting the cursor.
  if (/^-?(0|[1-9]\d*)$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isSafeInteger(numeric)) {
      return { value: numeric };
    }
    return {
      error: 'Invalid "since" filter: expected epoch ms or ISO timestamp.',
    };
  }

  // Date.parse("007") / Date.parse("1.5") are implementation-defined and
  // must not become a silent cursor. Only ISO-shaped timestamps fall through.
  if (!/^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(trimmed)) {
    return {
      error: 'Invalid "since" filter: expected epoch ms or ISO timestamp.',
    };
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

function projectLogEntry(entry: LogEntryLike): LogEntryLike {
  const redact = (value: string): string =>
    redactSensitiveText(value, { mode: "tools" });
  return {
    timestamp: entry.timestamp,
    level: redact(entry.level),
    ...(typeof entry.message === "string"
      ? { message: redact(entry.message) }
      : {}),
    source: redact(entry.source),
    tags: entry.tags.map(redact),
  };
}

function isUnsafeCsvControl(character: string): boolean {
  const code = character.charCodeAt(0);
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function neutralizeCsvFormula(value: string): string {
  const formulaMarkers = "=+-@";
  const isFormulaMarker = (character: string | undefined): boolean =>
    character !== undefined && formulaMarkers.includes(character);
  let prefixLength = 0;
  let hasUnsafeControlPrefix = false;
  while (prefixLength < value.length) {
    const character = value[prefixLength];
    if (character === " ") {
      prefixLength += 1;
      continue;
    }
    if (isUnsafeCsvControl(character)) {
      hasUnsafeControlPrefix = true;
      prefixLength += 1;
      continue;
    }
    break;
  }
  if (
    isFormulaMarker(value[0]) ||
    hasUnsafeControlPrefix ||
    (prefixLength > 0 && isFormulaMarker(value[prefixLength]))
  ) {
    return `'${value}`;
  }
  return value;
}

function csvEscape(value: string): string {
  const neutralized = neutralizeCsvFormula(value);
  if (/[",\n\r]/.test(neutralized)) {
    return `"${neutralized.replace(/"/g, '""')}"`;
  }
  return neutralized;
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

function isSupportedDiagnosticsRoute(
  method: string,
  pathname: string,
): boolean {
  return (
    (method === "GET" && pathname === "/api/logs") ||
    (method === "DELETE" && pathname === "/api/logs") ||
    (method === "POST" && pathname === "/api/logs/export") ||
    (method === "GET" && pathname === "/api/agent/events") ||
    (method === "GET" && pathname === "/api/security/audit") ||
    (method === "GET" && pathname === "/api/extension/status")
  );
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
    initSse,
    writeSseJson,
    auditEventTypes,
    auditSeverities,
    getAuditFeedSize,
    queryAuditFeed,
    subscribeAuditFeed,
    json,
    authorization,
  } = ctx;

  if (!isSupportedDiagnosticsRoute(method, pathname)) return false;
  if (!authorization.ok || authorization.role === "NONE") {
    json(res, { error: "Unauthorized" }, 401);
    return true;
  }
  if (authorization.role !== "OWNER") {
    json(res, { error: "Owner role required" }, 403);
    return true;
  }

  if (method === "GET" && pathname === "/api/logs") {
    const sinceRaw = url.searchParams.get("since");
    let sinceMs: number | undefined;
    if (sinceRaw) {
      const sinceFilter = parseAuditSince(sinceRaw);
      if (sinceFilter.error) {
        json(res, { error: sinceFilter.error }, 400);
        return true;
      }
      sinceMs = sinceFilter.value;
    }
    const entries = applyLogFilter(logBuffer, {
      source: url.searchParams.get("source") ?? undefined,
      level: url.searchParams.get("level") ?? undefined,
      tag: url.searchParams.get("tag") ?? undefined,
      sinceMs,
    });

    const sources = [
      ...new Set(
        logBuffer.map((entry) =>
          redactSensitiveText(entry.source, { mode: "tools" }),
        ),
      ),
    ].sort();
    const tags = [
      ...new Set(
        logBuffer.flatMap((entry) =>
          entry.tags.map((tag) => redactSensitiveText(tag, { mode: "tools" })),
        ),
      ),
    ].sort();
    json(res, {
      entries: entries.slice(-200).map(projectLogEntry),
      sources,
      tags,
    });
    return true;
  }

  if (method === "DELETE" && pathname === "/api/logs") {
    const errorFn = ctx.error;
    if (!ctx.readJsonBody || !errorFn) {
      json(res, { error: "Log clearing requires JSON body support" }, 500);
      return true;
    }
    const rawDelete = await ctx.readJsonBody<Record<string, unknown>>(req, res);
    if (rawDelete === null) return true;
    const parsedDelete = DeleteLogsRequestSchema.safeParse(rawDelete);
    if (!parsedDelete.success) {
      errorFn(
        res,
        parsedDelete.error.issues[0]?.message ?? "confirm must be true",
        400,
      );
      return true;
    }
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
    const rawExp = await ctx.readJsonBody<Record<string, unknown>>(req, res);
    if (rawExp === null) return true;
    const parsedExp = ConfirmedPostLogExportRequestSchema.safeParse(rawExp);
    if (!parsedExp.success) {
      errorFn(
        res,
        parsedExp.error.issues[0]?.message ?? 'format must be "json" or "csv"',
        400,
      );
      return true;
    }
    const body = parsedExp.data;
    const formatRaw = body.format;

    let sinceMs: number | undefined;
    if (typeof body.since === "string" && body.since.trim()) {
      const sinceFilter = parseAuditSince(body.since);
      if (sinceFilter.error) {
        errorFn(res, sinceFilter.error, 400);
        return true;
      }
      sinceMs = sinceFilter.value;
    } else if (typeof body.since === "number") {
      if (!Number.isSafeInteger(body.since)) {
        errorFn(
          res,
          'Invalid "since" filter: expected epoch ms or ISO timestamp.',
          400,
        );
        return true;
      }
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

    let attachment:
      | {
          payload: string;
          contentType: string;
          filename: string;
          byteLength: number;
        }
      | undefined;
    try {
      const emittedEntries = entries.map(projectLogEntry);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const payload =
        formatRaw === "json"
          ? JSON.stringify({ entries: emittedEntries }, null, 2)
          : logsToCsv(emittedEntries);
      attachment = {
        payload,
        contentType:
          formatRaw === "json"
            ? "application/json; charset=utf-8"
            : "text/csv; charset=utf-8",
        filename: `logs-${stamp}.${formatRaw}`,
        byteLength: Buffer.byteLength(payload, "utf-8"),
      };
    } catch (cause) {
      // error-policy:J1 this transport boundary returns one stable unavailable
      // response before any attachment header or byte has been written.
      logger.warn(
        { cause },
        "[diagnostics-routes] log export preparation failed",
      );
      json(res, { ok: false, error: "diagnostics_export_unavailable" }, 503);
      return true;
    }

    res.writeHead(200, {
      "Content-Type": attachment.contentType,
      "Content-Disposition": `attachment; filename="${attachment.filename}"`,
      "Content-Length": attachment.byteLength,
    });
    res.end(attachment.payload);
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
    let relayReachable: boolean;
    try {
      relayReachable = await (
        checkRelayReachable ?? defaultCheckRelayReachable
      )(relayPort);
    } catch (cause) {
      // error-policy:J1 the transport boundary hides relay implementation
      // details and returns one structured unavailable response.
      logger.warn(
        { cause },
        "[diagnostics-routes] relay reachability check failed",
      );
      json(res, { ok: false, error: "diagnostics_relay_unavailable" }, 503);
      return true;
    }

    // The headless agent only knows whether the browser-bridge relay is
    // reachable. Extension build artifacts (chromeBuildPath, packaged Safari
    // app, etc.) live inside the desktop bundle and are resolved by the
    // desktop RPC `getExtensionStatus` handler, which the UI prefers. When the
    // client falls back to this HTTP route there is no desktop bundle to probe,
    // so the artifact fields are genuinely unavailable here rather than null
    // file paths.
    json(res, {
      relayReachable,
      relayPort,
      extensionPath: null,
    });
    return true;
  }

  return false;
}
