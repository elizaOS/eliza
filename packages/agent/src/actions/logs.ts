/**
 * Log inspection actions — let the agent introspect its own log buffer.
 *
 * SEARCH_LOGS (was QUERY_LOGS)  → GET /api/logs (filterable)
 * EXPORT_LOGS                  → POST /api/logs/export (json or csv)
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

interface ExportLogsParams {
  format?: "json" | "csv";
  filter?: {
    source?: string;
    level?: LogLevel;
    tags?: string[];
    since?: string;
    limit?: number;
  };
}

export const exportLogsAction: Action = {
  name: "EXPORT_LOGS",
  contexts: ["admin", "agent_internal", "settings", "files"],
  roleGate: { minRole: "OWNER" },
  similes: ["DOWNLOAD_LOGS", "DUMP_LOGS", "SAVE_LOGS"],
  description:
    "Export the agent's log buffer to JSON or CSV via POST /api/logs/export.",
  descriptionCompressed: "POST /api/logs/export json or csv buffer dump owner",
  validate: async () => true,
  handler: async (
    _runtime,
    _message,
    _state,
    options,
  ): Promise<ActionResult> => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | ExportLogsParams
      | undefined;
    const format = params?.format === "csv" ? "csv" : "json";
    const filter = params?.filter ?? {};

    const body: Record<string, unknown> = { format };
    if (typeof filter.source === "string" && filter.source.trim()) {
      body.source = filter.source.trim();
    }
    if (filter.level && LOG_LEVELS.includes(filter.level)) {
      body.level = filter.level;
    }
    if (Array.isArray(filter.tags)) {
      const tags = filter.tags
        .map((t) => (typeof t === "string" ? t.trim() : ""))
        .filter(Boolean);
      if (tags.length > 0) body.tags = tags;
    }
    if (typeof filter.since === "string" && filter.since.trim()) {
      body.since = filter.since;
    }
    if (typeof filter.limit === "number" && Number.isFinite(filter.limit)) {
      body.limit = filter.limit;
    }

    try {
      const resp = await fetch(`${getApiBase()}/api/logs/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return {
          success: false,
          text: `Failed to export logs: HTTP ${resp.status}${text ? ` — ${text}` : ""}`,
        };
      }
      const contentType = resp.headers.get("content-type") ?? "";
      const disposition = resp.headers.get("content-disposition") ?? "";
      const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
      const filename = filenameMatch?.[1] ?? `logs.${format}`;
      const buffer = Buffer.from(await resp.arrayBuffer());

      let entryCount: number | undefined;
      if (contentType.includes("application/json")) {
        const parsed = JSON.parse(buffer.toString("utf-8")) as {
          entries?: unknown[];
        };
        entryCount = Array.isArray(parsed.entries)
          ? parsed.entries.length
          : undefined;
      }

      return {
        success: true,
        text: `Exported ${entryCount ?? "log"} entries as ${format} (${buffer.byteLength} bytes).`,
        values: {
          format,
          bytes: buffer.byteLength,
          ...(entryCount !== undefined ? { count: entryCount } : {}),
        },
        data: {
          actionName: "EXPORT_LOGS",
          format,
          filename,
          contentType,
          bytes: buffer.byteLength,
          base64: buffer.toString("base64"),
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[export-logs] failed: ${msg}`);
      return { success: false, text: `Failed to export logs: ${msg}` };
    }
  },
  parameters: [
    {
      name: "format",
      description: "Export format: json or csv.",
      required: true,
      schema: { type: "string" as const, enum: ["json", "csv"] },
    },
    {
      name: "filter",
      description:
        "Optional log filter (same shape as SEARCH_LOGS parameters).",
      required: false,
      schema: { type: "object" as const },
    },
  ],
  examples: [],
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
