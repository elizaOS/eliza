/**
 * Logs state, one of the domain hooks AppContext composes.
 *
 * Manages log entries, sources, tags, and filter state.
 * The loadLogs callback reads all three filter values from state.
 */

import { useCallback, useRef, useState } from "react";
import type { LogEntry } from "../api";
import { client } from "../api";

function isLogEntry(value: unknown): value is LogEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.timestamp === "number" &&
    Number.isFinite(record.timestamp) &&
    typeof record.level === "string" &&
    typeof record.message === "string" &&
    typeof record.source === "string" &&
    Array.isArray(record.tags) &&
    record.tags.every((tag) => typeof tag === "string")
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function normalizeLogsPayload(value: unknown): {
  entries: LogEntry[];
  sources: string[];
  tags: string[];
} {
  if (typeof value !== "object" || value === null) {
    throw new Error("Logs response was not an object.");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.entries) || !record.entries.every(isLogEntry)) {
    throw new Error("Logs response contained invalid entries.");
  }
  if (!isStringArray(record.sources)) {
    throw new Error("Logs response contained invalid sources.");
  }
  if (!isStringArray(record.tags)) {
    throw new Error("Logs response contained invalid tags.");
  }
  return {
    entries: record.entries,
    sources: record.sources,
    tags: record.tags,
  };
}

export function useLogsState() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logSources, setLogSources] = useState<string[]>([]);
  const [logTags, setLogTags] = useState<string[]>([]);
  const [logTagFilter, setLogTagFilter] = useState("");
  const [logLevelFilter, setLogLevelFilter] = useState("");
  const [logSourceFilter, setLogSourceFilter] = useState("");
  const [logLoadError, setLogLoadError] = useState<string | null>(null);

  // Refs keep filter values readable at call-time without adding them to
  // useCallback's dep array. Stable identity means the initial-load useEffect
  // in LogsView fires exactly once on mount instead of on every filter change.
  const logTagFilterRef = useRef(logTagFilter);
  const logLevelFilterRef = useRef(logLevelFilter);
  const logSourceFilterRef = useRef(logSourceFilter);
  logTagFilterRef.current = logTagFilter;
  logLevelFilterRef.current = logLevelFilter;
  logSourceFilterRef.current = logSourceFilter;

  const loadLogs = useCallback(async () => {
    setLogLoadError(null);
    try {
      const filter: Record<string, string> = {};
      if (logTagFilterRef.current) filter.tag = logTagFilterRef.current;
      if (logLevelFilterRef.current) filter.level = logLevelFilterRef.current;
      if (logSourceFilterRef.current)
        filter.source = logSourceFilterRef.current;
      const data = normalizeLogsPayload(
        await client.getLogs(
          Object.keys(filter).length > 0 ? filter : undefined,
        ),
      );
      setLogs(data.entries);
      setLogSources(data.sources);
      setLogTags(data.tags);
    } catch (err) {
      setLogLoadError(
        err instanceof Error ? err.message : "Failed to load logs.",
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filter values read via refs; stable identity prevents spurious useEffect triggers
  }, []);

  return {
    state: {
      logs,
      logSources,
      logTags,
      logTagFilter,
      logLevelFilter,
      logSourceFilter,
      logLoadError,
    },
    setLogs,
    setLogTagFilter,
    setLogLevelFilter,
    setLogSourceFilter,
    loadLogs,
  };
}
