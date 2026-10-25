/**
 * LOGS — polymorphic action for log inspection.
 *
 *   search    → GET /api/logs   (filter by source/level/tag/since; HTTP because the log
 *                                buffer lives on server state, not the runtime)
 *   delete    → DELETE /api/logs (clears the in-memory log buffer; HTTP for the same reason)
 */

import {
  type Action,
  type ActionResult,
  type HandlerOptions,
  logger,
} from "@elizaos/core";
import {
  createSelfApiRequestHeaders,
  resolveSelfApiBaseUrl,
} from "@elizaos/host/protocol";

const LOGS_OPS = ["search", "delete"] as const;
type LogsOp = (typeof LOGS_OPS)[number];

const LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
] as const;
type LogLevel = (typeof LOG_LEVELS)[number];
/** Parameters that narrow a search. The clear route accepts none of them. */
const LOGS_SEARCH_FILTERS = [
  "source",
  "level",
  "tags",
  "since",
  "limit",
] as const satisfies ReadonlyArray<keyof LogsParams>;

interface LogsParams {
  action?: LogsOp;
  subaction?: LogsOp;
  op?: LogsOp;
  // search-only
  source?: string;
  level?: LogLevel;
  tags?: string[];
  since?: string;
  limit?: number;
}

interface LogEntry {
  timestamp: number;
  level: string;
  message: string;
  source: string;
  tags: string[];
}

interface LogsResponseShape {
  entries: LogEntry[];
  sources: string[];
  tags: string[];
}

interface ClearResponseShape {
  cleared?: unknown;
}

function getApiBase(): string {
  return resolveSelfApiBaseUrl(process.env);
}

function parseSince(since: string | undefined): number | undefined {
  if (!since) return undefined;
  const numeric = Number(since);
  // A number is epoch milliseconds or nothing. Date.parse reads "1.5" and "0"
  // as implementation-defined dates. 8.64e15 ms is the largest instant a Date
  // holds.
  if (!Number.isNaN(numeric)) {
    return Number.isSafeInteger(numeric) && numeric > 0 && numeric <= 8.64e15
      ? numeric
      : undefined;
  }
  const parsed = Date.parse(since);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function describeLogFilters(
  params: LogsParams,
  tagFilter: string[],
  sinceMs: number | undefined,
): string {
  const parts: string[] = [];
  if (params.source) parts.push(`source=${params.source}`);
  if (params.level) parts.push(`level=${params.level}`);
  if (tagFilter.length > 0) parts.push(`tags=${tagFilter.join("+")}`);
  if (sinceMs !== undefined) {
    parts.push(`since=${new Date(sinceMs).toISOString()}`);
  }
  return parts.length > 0 ? parts.join(", ") : "none";
}

function formatLogPreview(entries: LogEntry[]): string {
  if (entries.length === 0) {
    return "No log entries match.";
  }
  return entries
    .map((entry) => {
      const ts = new Date(entry.timestamp).toISOString();
      const tagPart = entry.tags.length > 0 ? ` [${entry.tags.join(",")}]` : "";
      return `${ts} ${entry.level.toUpperCase().padEnd(5)} ${entry.source}${tagPart}: ${entry.message}`;
    })
    .join("\n");
}

function failure(text: string, code: string, extra?: object): ActionResult {
  return {
    success: false,
    text,
    values: { error: code },
    data: { actionName: "LOGS", ...extra },
    error: text,
  };
}

async function searchLogs(params: LogsParams): Promise<ActionResult> {
  const limit = params.limit;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
    return failure(
      "limit must be a positive integer when explicitly requesting a tail page.",
      "LOGS_INVALID_LIMIT",
    );
  }
  const tagFilter = (params.tags ?? []).map((t) => t.trim()).filter(Boolean);
  const sinceMs = parseSince(params.since);
  // An unreadable cutoff used to be dropped, and the reply still named it as
  // an applied filter over the whole buffer.
  if (params.since && sinceMs === undefined) {
    return failure(
      `since must be an ISO timestamp or epoch milliseconds; got "${params.since}".`,
      "LOGS_INVALID_SINCE",
    );
  }

  const search = new URLSearchParams();
  if (params.source) search.set("source", params.source);
  if (params.level) search.set("level", params.level);
  // Server only filters on a single tag — additional tags are intersected client-side.
  if (tagFilter.length > 0) search.set("tag", tagFilter[0]);
  if (sinceMs !== undefined) search.set("since", String(sinceMs));

  const qs = search.toString();
  const url = `${getApiBase()}/api/logs${qs ? `?${qs}` : ""}`;

  const resp = await fetch(url, {
    headers: createSelfApiRequestHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    return failure(
      `Failed to load logs: HTTP ${resp.status}`,
      "LOGS_SEARCH_FAILED",
    );
  }
  const data = (await resp.json()) as LogsResponseShape;
  const entries =
    tagFilter.length > 1
      ? data.entries.filter((entry) =>
          tagFilter.every((tag) => entry.tags.includes(tag)),
        )
      : data.entries;

  // Pagination is opt-in. With no caller-requested limit, preserve the complete
  // filtered buffer in both the preview and structured payload.
  const shown = limit === undefined ? entries : entries.slice(-limit);
  const filterNote = describeLogFilters(params, tagFilter, sinceMs);
  // source is an exact match, so a miss usually means a wrong module name.
  // Name the sources the buffer holds instead of implying nothing was logged.
  const sourceNote =
    shown.length === 0 && params.source
      ? ` Sources in the buffer: ${data.sources.length > 0 ? data.sources.join(", ") : "none"}.`
      : "";
  const windowNote = `Searched the complete current in-memory log buffer. Filters applied: ${filterNote}.${sourceNote}`;
  const header =
    shown.length === 0
      ? `No log entries match. ${windowNote}`
      : `${limit === undefined ? `Showing all ${entries.length}` : `Showing ${shown.length} of ${entries.length}`} matching entr${entries.length === 1 ? "y" : "ies"}, newest last${limit === undefined ? "" : ` (limit=${limit})`}. ${windowNote}`;

  return {
    success: true,
    text: shown.length === 0 ? header : `${header}\n${formatLogPreview(shown)}`,
    values: {
      count: entries.length,
      shown: shown.length,
      totalSources: data.sources.length,
    },
    data: {
      actionName: "LOGS",
      op: "search",
      matchedCount: entries.length,
      entries: shown,
      sources: data.sources,
      tags: data.tags,
      filters: filterNote,
    },
  };
}

async function deleteLogs(): Promise<ActionResult> {
  const resp = await fetch(`${getApiBase()}/api/logs`, {
    method: "DELETE",
    headers: createSelfApiRequestHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    return failure(
      `Failed to clear logs: HTTP ${resp.status}`,
      "LOGS_DELETE_FAILED",
    );
  }
  let cleared: number;
  try {
    const parsed: unknown = await resp.json();
    const count =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as ClearResponseShape).cleared
        : undefined;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      throw new Error("Clear response did not report a cleared count.");
    }
    cleared = count;
  } catch {
    // error-policy:J3 untrusted clear-response parse — the route always
    // answers { cleared: <count> }, so a 2xx proxy page, empty body, or
    // missing count proves nothing was cleared; fail closed instead of
    // reporting "Cleared 0 log entries."
    logger.warn(
      `[logs:delete] Clear response did not confirm the clear (${resp.status}).`,
    );
    return failure(
      `Failed to clear logs: the server did not confirm the clear (HTTP ${resp.status}).`,
      "LOGS_DELETE_FAILED",
    );
  }
  return {
    success: true,
    text: `Cleared ${cleared} log entries.`,
    values: { cleared },
    data: { actionName: "LOGS", op: "delete", cleared },
  };
}

export const logsAction: Action = {
  name: "LOGS",
  contexts: ["admin", "agent_internal", "settings"],
  roleGate: { minRole: "OWNER" },
  similes: [
    // Old leaf action names
    "SEARCH_LOGS",
    "DELETE_LOGS",
    // Common aliases
    "QUERY_LOGS",
    "READ_LOGS",
    "GET_LOGS",
    "INSPECT_LOGS",
    "VIEW_LOGS",
    "LOOKUP_LOGS",
    "CLEAR_LOGS",
    "WIPE_LOGS",
    "RESET_LOGS",
    "EMPTY_LOGS",
  ],
  description:
    "Polymorphic log control: action='search' tails the in-memory log buffer (filterable by source/level/tag/since), action='delete' clears that whole buffer (it takes no filter).",
  descriptionCompressed: "search/delete in-mem agent logs owner-only",
  validate: async () => true,
  handler: async (
    _runtime,
    _message,
    _state,
    options,
  ): Promise<ActionResult> => {
    const params =
      ((options as HandlerOptions | undefined)?.parameters as
        | LogsParams
        | undefined) ?? {};
    const op = params.action ?? params.subaction ?? params.op;
    if (!op || !LOGS_OPS.includes(op)) {
      // Planner-facing only: internal op names are tool-speak, not chat.
      return failure(`Unknown LOGS op: ${String(op)}`, "LOGS_INVALID", {
        validOps: [...LOGS_OPS],
      });
    }

    if (op === "delete") {
      const filters = LOGS_SEARCH_FILTERS.filter(
        (name) => params[name] !== undefined,
      );
      if (filters.length > 0) {
        // The clear route takes no filter: honoring the call would remove
        // every buffered entry, not the subset the planner named.
        return failure(
          `LOGS delete clears the whole in-memory log buffer and cannot be limited by ${filters.join(", ")}. Nothing was cleared. Send action=delete with no filter to clear every entry.`,
          "LOGS_INVALID",
          { unsupportedFilters: filters },
        );
      }
    }

    try {
      return op === "search" ? await searchLogs(params) : await deleteLogs();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[LOGS] ${op} failed: ${msg}`);
      const code =
        op === "search" ? "LOGS_SEARCH_FAILED" : "LOGS_DELETE_FAILED";
      return failure(`Failed to ${op} logs: ${msg}`, code);
    }
  },
  parameters: [
    {
      name: "action",
      description: "Operation: search | delete.",
      required: true,
      schema: { type: "string" as const, enum: [...LOGS_OPS] },
    },
    {
      name: "source",
      description:
        "[search] Exact name of the emitting module: the log line's [bracket] prefix or its src field (e.g. eliza-api, runtime, web-fetch). Lines with neither have source 'agent'. For broad groups such as agent, server or plugins use tags.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "level",
      description:
        "[search] Filter by exact log level. One of trace/debug/info/warn/error/fatal. level=error does not include fatal.",
      required: false,
      schema: { type: "string" as const, enum: [...LOG_LEVELS] },
    },
    {
      name: "tags",
      description:
        "[search] Optional tag filter list; an entry must carry every tag. Tags hold the broad groups (e.g. agent, server, plugins) and each entry's source.",
      required: false,
      schema: { type: "array" as const, items: { type: "string" as const } },
    },
    {
      name: "since",
      description:
        "[search] Optional ISO timestamp or epoch-ms cutoff. Only entries at or after this time are returned.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "limit",
      description:
        "[search] Optional positive integer tail-page size. Omit to return every matching buffered entry.",
      required: false,
      schema: { type: "number" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Show me the last 20 error logs." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Showing recent error log entries...",
          action: "LOGS",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Clear the agent log buffer." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Cleared the in-memory log buffer.",
          action: "LOGS",
        },
      },
    ],
  ],
};
