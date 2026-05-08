/**
 * Log inspection actions — let the agent introspect its own log buffer.
 *
 * SEARCH_LOGS (was QUERY_LOGS)  → GET /api/logs (filterable)
 * DELETE_LOGS (was CLEAR_LOGS) → DELETE /api/logs
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { resolveServerOnlyPort } from "@elizaos/shared";

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

interface QueryLogsParams {
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
  const lines = slice.map((entry) => {
    const ts = new Date(entry.timestamp).toISOString();
    const tagPart = entry.tags.length > 0 ? ` [${entry.tags.join(",")}]` : "";
    return `${ts} ${entry.level.toUpperCase().padEnd(5)} ${entry.source}${tagPart}: ${entry.message}`;
  });
  return lines.join("\n");
}

export const queryLogsAction: Action = {
  name: "SEARCH_LOGS",
  contexts: ["admin", "agent_internal", "settings"],
  roleGate: { minRole: "OWNER" },
  similes: [
    "QUERY_LOGS",
    "READ_LOGS",
    "GET_LOGS",
    "INSPECT_LOGS",
    "VIEW_LOGS",
    "LOOKUP_LOGS",
  ],
  description:
    "Read recent log entries from the agent's in-memory log buffer. Filter by source, level (debug/info/warn/error), tags, or since-timestamp.",
  descriptionCompressed:
    "GET /api/logs tail filter source level tags since owner",
  validate: async () => true,
  handler: async (
    _runtime,
    _message,
    _state,
    options,
  ): Promise<ActionResult> => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | QueryLogsParams
      | undefined;
    const limit = Math.max(1, Math.min(200, Math.floor(params?.limit ?? 50)));
    const tagFilter = (params?.tags ?? []).map((t) => t.trim()).filter(Boolean);
    const sinceMs = parseSince(params?.since);

    const search = new URLSearchParams();
    if (params?.source) search.set("source", params.source);
    if (params?.level && LOG_LEVELS.includes(params.level)) {
      search.set("level", params.level);
    }
    // Server only supports a single tag filter; use the first if multiple.
    if (tagFilter.length > 0) search.set("tag", tagFilter[0]);
    if (sinceMs !== undefined) search.set("since", String(sinceMs));

    const qs = search.toString();
    const url = `${getApiBase()}/api/logs${qs ? `?${qs}` : ""}`;

    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        return {
          success: false,
          text: `Failed to load logs: HTTP ${resp.status}`,
        };
      }
      const data = (await resp.json()) as LogsResponseShape;

      // Apply additional client-side tag filtering when multiple tags requested.
      const entries =
        tagFilter.length > 1
          ? data.entries.filter((entry) =>
              tagFilter.every((tag) => entry.tags.includes(tag)),
            )
          : data.entries;

      const preview = formatLogPreview(entries, limit);

      return {
        success: true,
        text: preview,
        values: {
          count: entries.length,
          totalSources: data.sources.length,
        },
        data: {
          actionName: "SEARCH_LOGS",
          entries: entries.slice(0, limit),
          sources: data.sources,
          tags: data.tags,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[query-logs] failed: ${msg}`);
      return { success: false, text: `Failed to load logs: ${msg}` };
    }
  },
  parameters: [
    {
      name: "source",
      description: "Optional source filter (e.g. agent, server, plugins).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "level",
      description: "Optional log level filter.",
      required: false,
      schema: { type: "string" as const, enum: [...LOG_LEVELS] },
    },
    {
      name: "tags",
      description:
        "Optional tag filter list. Server applies the first tag; remaining tags are intersected client-side.",
      required: false,
      schema: { type: "array" as const, items: { type: "string" as const } },
    },
    {
      name: "since",
      description:
        "Optional ISO timestamp or epoch-ms cutoff. Only entries at or after this time are returned.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "limit",
      description:
        "Maximum number of entries to include in the preview (1-200).",
      required: false,
      schema: { type: "number" as const },
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
          action: "SEARCH_LOGS",
        },
      },
    ],
  ],
};

export const clearLogsAction: Action = {
  name: "DELETE_LOGS",
  contexts: ["admin", "agent_internal", "settings"],
  roleGate: { minRole: "OWNER" },
  similes: ["CLEAR_LOGS", "WIPE_LOGS", "RESET_LOGS", "EMPTY_LOGS"],
  description:
    "Clear the agent's in-memory log buffer via DELETE /api/logs. Owner-only destructive reset when the user wants diagnostic logs wiped or the buffer emptied.",
  descriptionCompressed:
    "DELETE /api/logs wipe in-mem agent log buffer owner-only destructive",
  validate: async () => true,
  handler: async (_runtime, _message): Promise<ActionResult> => {
    try {
      const resp = await fetch(`${getApiBase()}/api/logs`, {
        method: "DELETE",
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        return {
          success: false,
          text: `Failed to clear logs: HTTP ${resp.status}`,
        };
      }
      const data = (await resp.json().catch(() => ({}))) as {
        cleared?: number;
      };
      const cleared =
        typeof data.cleared === "number" && Number.isFinite(data.cleared)
          ? data.cleared
          : 0;
      return {
        success: true,
        text: `Cleared ${cleared} log entries.`,
        values: { cleared },
        data: { actionName: "DELETE_LOGS", cleared },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[clear-logs] failed: ${msg}`);
      return { success: false, text: `Failed to clear logs: ${msg}` };
    }
  },
  parameters: [],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Clear the debug logs from the agent buffer." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Cleared the in-memory log buffer.",
          action: "DELETE_LOGS",
        },
      },
    ],
  ] as ActionExample[][],
};
