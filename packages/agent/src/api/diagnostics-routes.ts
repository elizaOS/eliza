import type http from "node:http";
import { parseClampedInteger } from "../utils/number-parsing";
import type { RouteHelpers, RouteRequestMeta } from "./route-helpers";

interface LogEntryLike {
  timestamp: number;
  level: string;
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
  payload: object,
  event?: string,
) => void;

export interface DiagnosticsRouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "json"> {
  url: URL;
  logBuffer: LogEntryLike[];
  eventBuffer: StreamEventEnvelopeLike[];
  relayPort?: number;
  checkRelayReachable?: (relayPort: number) => Promise<boolean>;
  resolveExtensionPath?: () => string | null;
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
  payload: object,
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
    let entries = logBuffer;

    const sourceFilter = url.searchParams.get("source");
    if (sourceFilter) {
      entries = entries.filter((entry) => entry.source === sourceFilter);
    }

    const levelFilter = url.searchParams.get("level");
    if (levelFilter) {
      entries = entries.filter((entry) => entry.level === levelFilter);
    }

    const tagFilter = url.searchParams.get("tag");
    if (tagFilter) {
      entries = entries.filter((entry) => entry.tags.includes(tagFilter));
    }

    const sinceFilter = url.searchParams.get("since");
    if (sinceFilter) {
      const sinceTimestamp = Number(sinceFilter);
      if (!Number.isNaN(sinceTimestamp)) {
        entries = entries.filter((entry) => entry.timestamp >= sinceTimestamp);
      }
    }

    const sources = [...new Set(logBuffer.map((entry) => entry.source))].sort();
    const tags = [...new Set(logBuffer.flatMap((entry) => entry.tags))].sort();
    json(res, { entries: entries.slice(-200), sources, tags });
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

    json(res, {
      relayReachable,
      relayPort,
      extensionPath,
    });
    return true;
  }

  return false;
}
