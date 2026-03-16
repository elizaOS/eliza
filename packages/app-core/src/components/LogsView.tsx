/**
 * Logs view component — logs viewer with filtering.
 */

import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@elizaos/ui";
import { useEffect, useMemo, useState } from "react";
import type { LogEntry } from "../api";
import { useApp } from "../state";
import { formatTime } from "./format";

/** Per-tag badge colour map. */
const TAG_COLORS: Record<string, { bg: string; fg: string }> = {
  agent: { bg: "rgba(99, 102, 241, 0.15)", fg: "rgb(99, 102, 241)" },
  server: { bg: "rgba(34, 197, 94, 0.15)", fg: "rgb(34, 197, 94)" },
  system: { bg: "rgba(156, 163, 175, 0.15)", fg: "rgb(156, 163, 175)" },
  cloud: { bg: "rgba(59, 130, 246, 0.15)", fg: "rgb(59, 130, 246)" },
  plugins: { bg: "rgba(168, 85, 247, 0.15)", fg: "rgb(168, 85, 247)" },
  autonomy: { bg: "rgba(245, 158, 11, 0.15)", fg: "rgb(245, 158, 11)" },
  websocket: { bg: "rgba(20, 184, 166, 0.15)", fg: "rgb(20, 184, 166)" },
};

export function LogsView() {
  const [searchQuery, setSearchQuery] = useState("");

  const {
    logs,
    logSources,
    logTags,
    logTagFilter,
    logLevelFilter,
    logSourceFilter,
    loadLogs,
    setState,
    t,
  } = useApp();

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  const handleClearFilters = () => {
    setState("logTagFilter", "");
    setState("logLevelFilter", "");
    setState("logSourceFilter", "");
    setSearchQuery("");
    void loadLogs();
  };

  const hasActiveFilters =
    logTagFilter !== "" ||
    logLevelFilter !== "" ||
    logSourceFilter !== "" ||
    searchQuery.trim() !== "";

  const normalizedSearch = searchQuery.trim().toLowerCase();

  const filteredLogs = useMemo(() => {
    if (!normalizedSearch) return logs;
    return logs.filter((entry) => {
      const haystack = [
        entry.message ?? "",
        entry.source ?? "",
        entry.level ?? "",
        ...(entry.tags ?? []),
      ];
      return haystack.some((part) =>
        part.toLowerCase().includes(normalizedSearch),
      );
    });
  }, [logs, normalizedSearch]);

  return (
    <div className="flex flex-col h-full">
      {/* Filters row — filters left, refresh right */}
      <div className="flex flex-wrap gap-1.5 mb-2.5 items-center">
        <input
          type="text"
          className="text-xs px-3 py-1.5 border border-border bg-card text-txt min-w-56"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t("logsview.SearchLogs")}
          aria-label="Search logs"
        />

        <Select
          value={logLevelFilter === "" ? "all" : logLevelFilter}
          onValueChange={(val) => {
            setState("logLevelFilter", val === "all" ? "" : val);
            void loadLogs();
          }}
        >
          <SelectTrigger className="h-8 px-3 py-1.5 text-xs bg-card border-border shadow-sm w-36">
            <SelectValue placeholder={t("logsview.AllLevels")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("logsview.AllLevels")}</SelectItem>
            <SelectItem value="debug">{t("logsview.Debug")}</SelectItem>
            <SelectItem value="info">{t("logsview.Info")}</SelectItem>
            <SelectItem value="warn">{t("logsview.Warn")}</SelectItem>
            <SelectItem value="error">{t("logsview.Error")}</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={logSourceFilter === "" ? "all" : logSourceFilter}
          onValueChange={(val) => {
            setState("logSourceFilter", val === "all" ? "" : val);
            void loadLogs();
          }}
        >
          <SelectTrigger className="h-8 px-3 py-1.5 text-xs bg-card border-border shadow-sm w-36">
            <SelectValue placeholder={t("logsview.AllSources")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("logsview.AllSources")}</SelectItem>
            {logSources.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {logTags.length > 0 && (
          <Select
            value={logTagFilter === "" ? "all" : logTagFilter}
            onValueChange={(val) => {
              setState("logTagFilter", val === "all" ? "" : val);
              void loadLogs();
            }}
          >
            <SelectTrigger className="h-8 px-3 py-1.5 text-xs bg-card border-border shadow-sm w-36">
              <SelectValue placeholder={t("logsview.AllTags")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("logsview.AllTags")}</SelectItem>
              {logTags.map((tag) => (
                <SelectItem key={tag} value={tag}>
                  {tag}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {hasActiveFilters && (
          <Button
            variant="outline"
            size="sm"
            className="h-auto min-h-[2rem] whitespace-normal break-words text-left text-xs bg-card text-txt hover:text-txt shadow-sm px-3 py-1.5"
            onClick={handleClearFilters}
          >
            {t("logsview.ClearFilters")}
          </Button>
        )}

        <Button
          variant="outline"
          size="sm"
          className="h-auto min-h-[2rem] whitespace-normal break-words text-left text-xs bg-card text-txt hover:text-txt shadow-sm ml-auto px-3 py-1.5"
          onClick={() => void loadLogs()}
        >
          {t("appsview.Refresh")}
        </Button>
      </div>

      {/* Log entries — full remaining height */}
      <div className="font-mono text-xs flex-1 min-h-0 overflow-y-auto border border-border p-2 bg-card">
        {filteredLogs.length === 0 ? (
          <div className="text-center py-8 text-muted">
            {t("logsview.NoLogEntries")}
            {hasActiveFilters ? " matching filters" : " yet"}.
          </div>
        ) : (
          filteredLogs.map((entry: LogEntry) => (
            <div
              key={`${entry.timestamp}-${entry.source}-${entry.level}-${entry.message}`}
              className="font-mono text-xs px-2 py-1 border-b border-border flex gap-2 items-baseline"
              data-testid="log-entry"
            >
              {/* Timestamp */}
              <span className="text-muted whitespace-nowrap">
                {formatTime(entry.timestamp, { fallback: "—" })}
              </span>

              {/* Level */}
              <span
                className={`font-semibold w-[44px] uppercase text-[11px] ${
                  entry.level === "error"
                    ? "text-danger"
                    : entry.level === "warn"
                      ? "text-warn"
                      : "text-muted"
                }`}
              >
                {entry.level}
              </span>

              {/* Source */}
              <span className="text-muted w-16 overflow-hidden text-ellipsis whitespace-nowrap text-[11px]">
                [{entry.source}]
              </span>

              {/* Tag badges */}
              <span className="inline-flex gap-0.5 shrink-0">
                {(entry.tags ?? []).map((t: string) => {
                  const c = TAG_COLORS[t];
                  return (
                    <span
                      key={t}
                      className="inline-block text-[10px] px-1.5 py-px rounded-lg mr-0.5"
                      style={{
                        background: c ? c.bg : "var(--bg-muted)",
                        color: c ? c.fg : "var(--muted)",
                        fontFamily: "var(--font-body, sans-serif)",
                      }}
                    >
                      {t}
                    </span>
                  );
                })}
              </span>

              {/* Message */}
              <span className="flex-1 break-all">{entry.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
