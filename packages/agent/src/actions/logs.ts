/**
 * LOGS — polymorphic action for log inspection and runtime log-level control.
 *
 *   search    → GET /api/logs   (filter by source/level/tag/since; HTTP because the log
 *                                buffer lives on server state, not the runtime)
 *   delete    → DELETE /api/logs (clears the in-memory log buffer; HTTP for the same reason)
 *   set_level → in-process per-room override on `runtime.logLevelOverrides`
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { elizaLogger, logger } from "@elizaos/core";
import { resolveServerOnlyPort } from "@elizaos/shared";

const LOGS_OPS = ["search", "delete", "set_level"] as const;
type LogsOp = (typeof LOGS_OPS)[number];

const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

const SEARCH_LEVELS: readonly LogLevel[] = [
  "debug",
  "info",
  "warn",
  "error",
] as const;

interface LogsParams {
  op?: LogsOp;
  // search-only
  source?: string;
  level?: LogLevel;
  tags?: string[];
  since?: string;
  limit?: number;
  // set_level-only
  roomId?: string;
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
  cleared?: number;
}

type RuntimeWithOverrides = IAgentRuntime & {
  logLevelOverrides?: Map<string, string>;
};

function getApiBase(): string {
  return `http://localhost:${resolveServerOnlyPort(process.env)}`;
}

function parseSince(since: string | undefined): number | undefined {
  if (!since) return undefined;
  const numeric = Number(since);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }
  const parsed = Date.parse(since);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function formatLogPreview(entries: LogEntry[], limit: number): string {
  const slice = entries.slice(0, limit);
  if (slice.length === 0) {
    return "No log entries match.";
  }
  return slice
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
  const limit = Math.max(1, Math.min(200, Math.floor(params.limit ?? 50)));
  const tagFilter = (params.tags ?? []).map((t) => t.trim()).filter(Boolean);
  const sinceMs = parseSince(params.since);

  const search = new URLSearchParams();
  if (params.source) search.set("source", params.source);
  if (params.level && SEARCH_LEVELS.includes(params.level)) {
    search.set("level", params.level);
  }
  // Server only filters on a single tag — additional tags are intersected client-side.
  if (tagFilter.length > 0) search.set("tag", tagFilter[0]);
  if (sinceMs !== undefined) search.set("since", String(sinceMs));

  const qs = search.toString();
  const url = `${getApiBase()}/api/logs${qs ? `?${qs}` : ""}`;

  const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
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

  return {
    success: true,
    text: formatLogPreview(entries, limit),
    values: { count: entries.length, totalSources: data.sources.length },
    data: {
      actionName: "LOGS",
      op: "search",
      entries: entries.slice(0, limit),
      sources: data.sources,
      tags: data.tags,
    },
  };
}

async function deleteLogs(): Promise<ActionResult> {
  const resp = await fetch(`${getApiBase()}/api/logs`, {
    method: "DELETE",
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    return failure(
      `Failed to clear logs: HTTP ${resp.status}`,
      "LOGS_DELETE_FAILED",
    );
  }
  const data = (await resp.json().catch(() => ({}))) as ClearResponseShape;
  const cleared =
    typeof data.cleared === "number" && Number.isFinite(data.cleared)
      ? data.cleared
      : 0;
  return {
    success: true,
    text: `Cleared ${cleared} log entries.`,
    values: { cleared },
    data: { actionName: "LOGS", op: "delete", cleared },
  };
}

function setLogLevel(
  runtime: IAgentRuntime,
  message: Memory,
  params: LogsParams,
  callback: HandlerCallback | undefined,
): ActionResult {
  const requested =
    typeof params.level === "string" ? params.level.toLowerCase() : "";
  if (!LOG_LEVELS.includes(requested as LogLevel)) {
    if (callback) {
      callback({
        text: `Please specify a valid log level: ${LOG_LEVELS.join(", ")}.`,
        action: "LOGS_SET_LEVEL_FAILED",
      });
    }
    return failure("Invalid log level.", "LOGS_SET_LEVEL_FAILED", {
      validLevels: [...LOG_LEVELS],
    });
  }
  const level = requested as LogLevel;
  const targetRoomId = params.roomId ?? message.roomId;

  const overrides = (runtime as RuntimeWithOverrides).logLevelOverrides;
  if (!overrides) {
    if (callback) {
      callback({
        text: "Dynamic log levels are not supported by this runtime version.",
        action: "LOGS_SET_LEVEL_FAILED",
      });
    }
    return failure(
      "Dynamic log levels are not supported by this runtime version.",
      "LOGS_SET_LEVEL_FAILED",
    );
  }

  overrides.set(String(targetRoomId), level);
  // Also raise the process-wide pino logger so emitted records are not filtered
  // out before they reach the per-room override listener.
  (logger as unknown as { level: string }).level = level;
  elizaLogger.info(`[LOGS] level set to ${level} for room ${targetRoomId}`);

  if (callback) {
    callback({
      text: `Log level changed to **${level.toUpperCase()}** for this room.`,
      action: "LOGS_SET_LEVEL",
    });
  }
  return {
    success: true,
    text: `Log level changed to ${level.toUpperCase()} for this room.`,
    values: { level },
    data: { actionName: "LOGS", op: "set_level", level, roomId: targetRoomId },
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
    "LOG_LEVEL",
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
    "SET_LOG_LEVEL",
    "CHANGE_LOG_LEVEL",
    "DEBUG_MODE",
    "SET_DEBUG",
    "CONFIGURE_LOGGING",
  ],
  description:
    "Polymorphic log control: op='search' tails the in-memory log buffer (filterable by source/level/tag/since), op='delete' clears that buffer, op='set_level' overrides the per-room log level (trace/debug/info/warn/error).",
  descriptionCompressed:
    "search/delete in-mem agent logs or set_level per-room owner-only",
  validate: async () => true,
  handler: async (
    runtime,
    message,
    _state,
    options,
    callback,
  ): Promise<ActionResult> => {
    const params =
      ((options as HandlerOptions | undefined)?.parameters as
        | LogsParams
        | undefined) ?? {};
    const op = params.op;
    if (!op || !LOGS_OPS.includes(op)) {
      if (callback) {
        callback({
          text: `Unknown LOGS op. Use one of: ${LOGS_OPS.join(", ")}.`,
          action: "LOGS_INVALID_OP",
        });
      }
      return failure(`Unknown LOGS op: ${String(op)}`, "LOGS_INVALID_OP", {
        validOps: [...LOGS_OPS],
      });
    }

    if (op === "set_level") {
      return setLogLevel(runtime, message, params, callback);
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
      name: "op",
      description: "Operation: search | delete | set_level.",
      required: true,
      schema: { type: "string" as const, enum: [...LOGS_OPS] },
    },
    {
      name: "source",
      description:
        "[search] Optional source filter (e.g. agent, server, plugins).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "level",
      description:
        "[search] Filter by log level (debug/info/warn/error). [set_level] New level to set (trace/debug/info/warn/error).",
      required: false,
      schema: { type: "string" as const, enum: [...LOG_LEVELS] },
    },
    {
      name: "tags",
      description:
        "[search] Optional tag filter list. Server applies the first; remaining are intersected client-side.",
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
        "[search] Maximum entries to include in the preview (1-200).",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "roomId",
      description:
        "[set_level] Optional room id to scope the override; defaults to the active room.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Show me the last 20 error logs from the agent." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Showing recent agent error log entries...",
          action: "LOGS",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Clear the debug logs from the agent buffer." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Cleared the in-memory log buffer.",
          action: "LOGS",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Set log level to debug" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Log level changed to **DEBUG** for this room.",
          action: "LOGS",
        },
      },
    ],
  ],
};

