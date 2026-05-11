import {
  Button,
  ContentLayout,
  Input,
  PagePanel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@elizaos/ui";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { LogEntry } from "../../api";
import { useApp } from "../../state";
import { formatTime } from "../../utils/format";

/**
 * Logs page — formerly split across `LogsPageView` (a 17-LOC ContentLayout
 * wrapper) and `LogsView` (the panel). Folded into one component since
 * neither caller passed contentHeader/inModal — both props default to
 * the same shape the wrapper used to apply.
 */
export function LogsView({
  contentHeader,
  inModal,
}: {
  contentHeader?: ReactNode;
  inModal?: boolean;
} = {}) {
  return (
    <ContentLayout contentHeader={contentHeader} inModal={inModal}>
      <LogsViewBody />
    </ContentLayout>
  );
}

function LogsViewBody() {
  const [searchQuery, setSearchQuery] = useState("");

  const {
    logs,
    logSources,
    logTags,
    logTagFilter,
    logLevelFilter,
    logSourceFilter,
    logLoadError,
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

  const activeFilterCount = [
    logTagFilter !== "",
    logLevelFilter !== "",
    logSourceFilter !== "",
    normalizedSearch !== "",
  ].filter(Boolean).length;

  return (
    <div className="flex h-full flex-col gap-3" data-testid="logs-view">
      {/* Filters row — filters left, refresh right */}
      <PagePanel variant="surface" className="space-y-3 p-3 sm:p-4">
        <div className="space-y-1">
          <div className="text-sm font-semibold text-txt">
            {t("logsview.FilterLogs")}
          </div>
          <p className="max-w-3xl text-xs leading-5 text-muted">
            {t("logsview.FilterLogsDescription")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="text"
            className="min-w-[15rem] flex-1 h-10 rounded-xl border-border/50 bg-bg/80 text-sm text-txt shadow-sm"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("logsview.SearchLogs")}
            aria-label={t("aria.searchLogs")}
          />

          <Select
            value={logLevelFilter === "" ? "all" : logLevelFilter}
            onValueChange={(val: string) => {
              setState("logLevelFilter", val === "all" ? "" : val);
            }}
          >
            <SelectTrigger className="w-40 h-10 rounded-xl border-border/50 bg-bg/80 text-sm text-txt shadow-sm">
              <SelectValue placeholder={t("logsview.AllLevels")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("logsview.AllLevels")}</SelectItem>
              <SelectItem value="debug">{t("logsview.Debug")}</SelectItem>
              <SelectItem value="info">{t("logsview.Info")}</SelectItem>
              <SelectItem value="warn">{t("logsview.Warn")}</SelectItem>
              <SelectItem value="error">{t("common.error")}</SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={logSourceFilter === "" ? "all" : logSourceFilter}
            onValueChange={(val: string) => {
              setState("logSourceFilter", val === "all" ? "" : val);
            }}
          >
            <SelectTrigger className="w-40 h-10 rounded-xl border-border/50 bg-bg/80 text-sm text-txt shadow-sm">
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
              onValueChange={(val: string) => {
                setState("logTagFilter", val === "all" ? "" : val);
              }}
            >
              <SelectTrigger className="w-40 h-10 rounded-xl border-border/50 bg-bg/80 text-sm text-txt shadow-sm">
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
              className="logs-toolbar-button"
              onClick={handleClearFilters}
            >
              {t("logsview.ClearFilters")}
            </Button>
          )}

          <Button
            variant="outline"
            size="sm"
            className="logs-toolbar-button ml-auto"
            onClick={() => void loadLogs()}
          >
            {t("common.refresh")}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div className="rounded-full border border-border/40 bg-bg-hover/60 px-2.5 py-1 text-muted tabular-nums">
            {t(
              filteredLogs.length === 1
                ? "logsview.ShowingEntry"
                : "logsview.ShowingEntries",
              { count: filteredLogs.length },
            )}
          </div>
          <div className="rounded-full border border-border/35 bg-bg/80 px-2.5 py-1 text-muted tabular-nums">
            {t(
              activeFilterCount === 1
                ? "logsview.ActiveFilter"
                : "logsview.ActiveFilters",
              { count: activeFilterCount },
            )}
          </div>
        </div>
        {logLoadError ? (
          <div
            role="alert"
            className="rounded-2xl border border-danger/35 bg-danger/8 px-3 py-2 text-xs text-danger"
          >
            {t("logsview.LoadFailed", {
              defaultValue: "Failed to load logs: {{message}}",
              message: logLoadError,
            })}
          </div>
        ) : null}
      </PagePanel>

      {/* Log entries — full remaining height */}
      <PagePanel
        variant="surface"
        className="flex-1 min-h-0 overflow-y-auto p-2 font-mono text-sm"
      >
        {filteredLogs.length === 0 ? (
          <PagePanel.Empty
            variant="panel"
            role="status"
            className="m-1 min-h-[16rem] rounded-xl border-border/35 bg-bg-hover/60 px-6 py-10"
            description={
              hasActiveFilters
                ? t("logsview.NoLogEntriesMatchingFiltersDescription")
                : t("logsview.NoLogEntriesYetDescription")
            }
            title={t(
              hasActiveFilters
                ? "logsview.NoLogEntriesMatchingFilters"
                : "logsview.NoLogEntriesYet",
            )}
          />
        ) : (
          <PagePanel variant="inset" className="overflow-hidden rounded-2xl">
            <div className="hidden grid-cols-[5.75rem_3.5rem_5rem_14rem_minmax(0,1fr)] gap-3 px-3 py-2 text-xs-tight font-medium uppercase tracking-[0.08em] text-muted md:grid">
              <span>{t("logsview.Time")}</span>
              <span>{t("logsview.Level")}</span>
              <span>{t("logsview.Source")}</span>
              <span>{t("logsview.Tags")}</span>
              <span>{t("common.message")}</span>
            </div>
            {filteredLogs.map((entry: LogEntry) => (
              <div
                key={`${entry.timestamp}-${entry.source}-${entry.level}-${entry.message}`}
                className="flex items-start gap-3 px-3 py-3 text-sm"
                data-testid="log-entry"
              >
                {/* Timestamp */}
                <span className="w-[5.75rem] shrink-0 whitespace-nowrap text-xs-tight text-muted tabular-nums">
                  {formatTime(entry.timestamp, { fallback: "—" })}
                </span>

                {/* Level */}
                <span
                  className={`w-14 shrink-0 font-semibold uppercase tracking-[0.08em] text-xs-tight ${
                    entry.level === "error"
                      ? "text-danger"
                      : entry.level === "warn"
                        ? "text-warning"
                        : entry.level === "info"
                          ? "text-muted-strong"
                          : entry.level === "debug"
                            ? "text-muted"
                            : "text-muted"
                  }`}
                >
                  {entry.level}
                </span>

                {/* Source */}
                <span className="w-20 shrink-0 truncate text-xs-tight text-muted">
                  [{entry.source}]
                </span>

                {/* Tag badges */}
                <span className="inline-flex max-w-[14rem] shrink-0 flex-wrap gap-1">
                  {(entry.tags ?? []).map((t: string) => {
                    return (
                      <span
                        key={t}
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-2xs font-medium ${
                          (
                            {
                              agent:
                                "border-accent/25 bg-accent/10 text-accent-fg",
                              server: "border-ok/25 bg-ok/10 text-ok",
                              system:
                                "border-border/40 bg-bg-hover text-muted-strong",
                              cloud: "border-accent/20 bg-accent/8 text-accent",
                              plugins:
                                "border-accent/25 bg-accent/10 text-accent-fg",
                              autonomy:
                                "border-warning/30 bg-warning/10 text-warning",
                              websocket: "border-ok/20 bg-ok/8 text-ok",
                            } as Record<string, string>
                          )[t] ??
                          "border-border/35 bg-bg-hover text-muted-strong"
                        }`}
                        style={{
                          fontFamily: "var(--font-body, sans-serif)",
                        }}
                      >
                        {t}
                      </span>
                    );
                  })}
                </span>

                {/* Message */}
                <span className="min-w-0 flex-1 break-words leading-6 text-txt">
                  {entry.message}
                </span>
              </div>
            ))}
          </PagePanel>
        )}
      </PagePanel>
    </div>
  );
}
