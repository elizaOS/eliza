/**
 * Logs page: renders the agent's structured server log stream as a searchable,
 * auto-refreshing list. Polls the logs store only while the document is
 * visible, and gates the first paint on a local loading flag so the empty state
 * never flashes mid-hydration. Mountable standalone or inside a modal.
 */

import { ScrollText } from "lucide-react";
import { memo, type ReactNode, useEffect, useMemo, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import type { LogEntry } from "../../api";
import { useIntervalWhenDocumentVisible } from "../../hooks/useDocumentVisibility";
import {
  LAYOUT_SHIFT_INTENT_ATTR,
  LAYOUT_SHIFT_INTENT_TRANSIENT,
} from "../../hooks/useLayoutShiftMonitor";
import { ContentLayout } from "../../layouts/content-layout/content-layout";
import { useAppSelectorShallow } from "../../state";
import { useRegisterViewChatBinding } from "../../state/view-chat-binding";
import { formatTime } from "../../utils/format";
import { ChatEmptyStateWithRecommendations } from "../composites/chat";
import { PagePanel } from "../composites/page-panel";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { ListSkeleton } from "../ui/skeleton-layouts";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

const LOG_HYDRATION_SETTLE_MS = 1200;
const LOG_INITIAL_SKELETON_ROWS = 4;
const LOG_INITIAL_SKELETON_ROW_CLASS = "h-[11.375rem]";

function logEntryKey(entry: LogEntry, index: number): string {
  return [
    entry.timestamp,
    entry.source,
    entry.level,
    entry.message,
    entry.tags.join(","),
    index,
  ].join("|");
}

/**
 * Logs page — formerly split across `LogsPageView` (a 17-LOC ContentLayout
 * wrapper) and `LogsView` (the panel). Folded into one component since
 * neither caller passed contentHeader/inModal — both props default to
 * the same shape the wrapper used to apply.
 */
// Memoized so the live-tail (which appends entries and re-renders the list)
// reconciles only NEW rows — each existing `entry` is a stable object, so memo
// skips re-rendering (and re-formatting) every prior row on every tail update.
const LogRow = memo(function LogRow({ entry }: { entry: LogEntry }) {
  return (
    <div
      className="flex flex-col gap-1 px-3 py-3 text-sm md:flex-row md:items-start md:gap-3"
      data-testid="log-entry"
    >
      {/* Timestamp */}
      <span className="shrink-0 whitespace-nowrap text-xs-tight text-muted tabular-nums md:w-[5.75rem]">
        {formatTime(entry.timestamp, { fallback: "—" })}
      </span>

      {/* Level */}
      <span
        className={`shrink-0 font-semibold uppercase tracking-[0.08em] text-xs-tight md:w-14 ${
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
      <span className="min-w-0 shrink-0 break-words text-xs-tight text-muted md:w-20 md:truncate">
        [{entry.source}]
      </span>

      {/* Tag badges */}
      <span className="inline-flex max-w-full shrink-0 flex-wrap gap-1 md:max-w-[14rem]">
        {(entry.tags ?? []).map((t: string) => {
          return (
            <span
              key={t}
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-2xs font-medium ${
                (
                  {
                    agent: "border-accent/25 bg-accent/10 text-accent-fg",
                    cloud: "border-accent/20 bg-accent/8 text-accent",
                    plugins: "border-accent/25 bg-accent/10 text-accent-fg",
                  } as Record<string, string>
                )[t] ?? "border-border/35 bg-bg-hover text-muted-strong"
              }`}
              style={{
                fontFamily: "var(--font-body, sans-serif)",
              }}
            >
              <span className="break-all">{t}</span>
            </span>
          );
        })}
      </span>

      {/* Message */}
      <span className="min-w-0 flex-1 break-words leading-6 text-txt">
        {entry.message}
      </span>
    </div>
  );
});

export function LogsView({
  contentHeader,
  inModal,
}: {
  contentHeader?: ReactNode;
  inModal?: boolean;
} = {}) {
  return (
    <ShellViewAgentSurface viewId="logs">
      <ContentLayout contentHeader={contentHeader} inModal={inModal}>
        <LogsViewBody />
      </ContentLayout>
    </ShellViewAgentSurface>
  );
}

function LogsViewBody() {
  const [searchQuery, setSearchQuery] = useState("");
  // The logs store does not track load progress, so gate the initial load
  // locally: until the first loadLogs() settles we show a loading state
  // instead of the "no entries yet" empty state (which is misleading mid-load).
  const [initialLoading, setInitialLoading] = useState(true);
  const [logHydrationSettling, setLogHydrationSettling] = useState(false);

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
  } = useAppSelectorShallow((s) => ({
    logs: s.logs,
    logSources: s.logSources,
    logTags: s.logTags,
    logTagFilter: s.logTagFilter,
    logLevelFilter: s.logLevelFilter,
    logSourceFilter: s.logSourceFilter,
    logLoadError: s.logLoadError,
    loadLogs: s.loadLogs,
    setState: s.setState,
    t: s.t,
  }));

  // The floating chat composer becomes this view's search box: while Logs is
  // open it takes over the composer placeholder and feeds the live draft into
  // searchQuery via onQuery. setSearchQuery is a stable useState setter.
  const searchPlaceholder = t("logsview.SearchLogs");
  const chatBinding = useMemo(
    () => ({ placeholder: searchPlaceholder, onQuery: setSearchQuery }),
    [searchPlaceholder],
  );
  useRegisterViewChatBinding(chatBinding);

  // Initial load + quiet live tail: poll instead of a user-facing refresh
  // button so the view stays current without an extra control to reason about.
  useEffect(() => {
    let cancelled = false;
    void loadLogs().finally(() => {
      if (cancelled) return;
      setLogHydrationSettling(true);
      setInitialLoading(false);
      window.setTimeout(() => {
        if (!cancelled) setLogHydrationSettling(false);
      }, LOG_HYDRATION_SETTLE_MS);
    });
    return () => {
      cancelled = true;
    };
  }, [loadLogs]);

  // Live tail only ticks while the document is visible; pauses when the
  // tab/window is hidden and resumes on visibilitychange.
  useIntervalWhenDocumentVisible(() => void loadLogs(), 5000);

  const handleClearFilters = () => {
    setState("logTagFilter", "");
    setState("logLevelFilter", "");
    setState("logSourceFilter", "");
    setSearchQuery("");
  };

  const levelControl = useAgentElement<HTMLButtonElement>({
    id: "logs-filter-level",
    role: "select",
    label: t("logsview.AllLevels"),
    group: "logs",
    options: ["all", "debug", "info", "warn", "error"],
    getValue: () => (logLevelFilter === "" ? "all" : logLevelFilter),
    onFill: (value) => setState("logLevelFilter", value === "all" ? "" : value),
  });

  const sourceControl = useAgentElement<HTMLButtonElement>({
    id: "logs-filter-source",
    role: "select",
    label: t("logsview.AllSources"),
    group: "logs",
    options: ["all", ...logSources],
    getValue: () => (logSourceFilter === "" ? "all" : logSourceFilter),
    onFill: (value) =>
      setState("logSourceFilter", value === "all" ? "" : value),
  });

  const tagControl = useAgentElement<HTMLButtonElement>({
    id: "logs-filter-tag",
    role: "select",
    label: t("logsview.AllTags"),
    group: "logs",
    options: ["all", ...logTags],
    getValue: () => (logTagFilter === "" ? "all" : logTagFilter),
    onFill: (value) => setState("logTagFilter", value === "all" ? "" : value),
  });

  const clearControl = useAgentElement<HTMLButtonElement>({
    id: "logs-clear",
    role: "button",
    label: t("logsview.ClearFilters"),
    group: "logs",
    onActivate: handleClearFilters,
  });

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

  const errorCount = useMemo(
    () => logs.filter((entry) => entry.level === "error").length,
    [logs],
  );
  const logPanelShiftIntentProps = logHydrationSettling
    ? { [LAYOUT_SHIFT_INTENT_ATTR]: LAYOUT_SHIFT_INTENT_TRANSIENT }
    : undefined;

  return (
    <div className="flex h-full flex-col gap-3" data-testid="logs-view">
      {/* Filters row — filters left, count beside the title */}
      <PagePanel variant="surface" className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted tabular-nums">
            {filteredLogs.length}
          </span>
          {errorCount > 0 ? (
            <span className="text-xs text-danger tabular-nums">
              {t("logsview.ErrorCount", {
                count: errorCount,
                defaultValue: "{{count}} errors",
              })}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={logLevelFilter === "" ? "all" : logLevelFilter}
            onValueChange={(val: string) => {
              setState("logLevelFilter", val === "all" ? "" : val);
            }}
          >
            <SelectTrigger
              ref={levelControl.ref}
              className="h-11 w-40 rounded-sm text-sm text-txt"
              {...levelControl.agentProps}
            >
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
            <SelectTrigger
              ref={sourceControl.ref}
              className="h-11 w-40 rounded-sm text-sm text-txt"
              {...sourceControl.agentProps}
            >
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
              <SelectTrigger
                ref={tagControl.ref}
                className="h-11 w-40 rounded-sm text-sm text-txt"
                {...tagControl.agentProps}
              >
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
              ref={clearControl.ref}
              variant="outline"
              size="sm"
              className="logs-toolbar-button"
              onClick={handleClearFilters}
              {...clearControl.agentProps}
            >
              {t("logsview.ClearFilters")}
            </Button>
          )}
        </div>
        {logLoadError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 px-3 py-2 text-xs text-danger"
          >
            <span>
              {t("logsview.LoadFailed", {
                defaultValue: "Failed to load logs: {{message}}",
                message: logLoadError,
              })}
            </span>
            <Button
              size="sm"
              className="text-black hover:text-black"
              onClick={() => void loadLogs()}
            >
              {t("common.retry", { defaultValue: "Retry" })}
            </Button>
          </div>
        ) : null}
      </PagePanel>

      {/* Log entries — full remaining height */}
      <PagePanel
        variant="surface"
        data-testid="logs-entry-panel"
        className="flex-1 min-h-0 overflow-y-auto font-mono text-sm"
        {...logPanelShiftIntentProps}
      >
        {initialLoading && filteredLogs.length === 0 && !logLoadError ? (
          <ListSkeleton
            className="m-1"
            rows={LOG_INITIAL_SKELETON_ROWS}
            rowClassName={LOG_INITIAL_SKELETON_ROW_CLASS}
          />
        ) : filteredLogs.length === 0 ? (
          <ChatEmptyStateWithRecommendations
            icon={ScrollText}
            title={
              hasActiveFilters
                ? t("logsview.NoLogEntriesMatchingFiltersDescription")
                : t("logsview.NoLogEntriesYetDescription")
            }
            recommendations={
              hasActiveFilters
                ? [
                    "Show me only error-level logs",
                    "What do the recent agent logs say?",
                  ]
                : [
                    "Why isn't the agent emitting any logs?",
                    "Summarize what the system has done so far",
                    "Show me recent errors and warnings",
                  ]
            }
            primaryAction={
              hasActiveFilters
                ? {
                    label: t("logsview.ClearFilters"),
                    onClick: handleClearFilters,
                  }
                : undefined
            }
          />
        ) : (
          <div className="overflow-hidden">
            {filteredLogs.map((entry: LogEntry, index) => (
              <LogRow key={logEntryKey(entry, index)} entry={entry} />
            ))}
          </div>
        )}
      </PagePanel>
    </div>
  );
}
