/**
 * Logs page: renders the agent's structured server log stream as a searchable,
 * auto-refreshing list. Polls the logs store only while the document is
 * visible, and gates the first paint on a local loading flag so the empty state
 * never flashes mid-hydration. Mountable standalone or inside a modal.
 */

import { ChevronDown, ScrollText } from "lucide-react";
import {
  memo,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { PagePanel } from "../composites/page-panel";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { ListSkeleton } from "../ui/skeleton-layouts";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

const LOG_HYDRATION_SETTLE_MS = 1200;
const LOG_INITIAL_SKELETON_ROWS = 4;
const LOG_INITIAL_SKELETON_ROW_CLASS = "h-16";

function logEntryKey(entry: LogEntry, index: number): string {
  return `${entry.timestamp}|${entry.source}|${entry.level}|${index}`;
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
      className="flex min-w-0 items-start gap-3 border-b border-border/35 px-1 py-4 text-sm last:border-b-0"
      data-testid="log-entry"
    >
      <div className="min-w-0 flex-1">
        <p className="break-words font-medium leading-5 text-txt">
          {entry.message}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs-tight text-muted">
          <span className="whitespace-nowrap tabular-nums">
            {formatTime(entry.timestamp, { fallback: "—" })}
          </span>
          <span aria-hidden>·</span>
          <span className="break-words">{entry.source}</span>
          {(entry.tags ?? []).map((tag) => (
            <span key={tag}>· {tag}</span>
          ))}
        </div>
      </div>
      <span
        className={`shrink-0 text-xs-tight font-semibold uppercase tracking-[0.08em] ${
          entry.level === "error"
            ? "text-danger"
            : entry.level === "warn"
              ? "text-warning"
              : "text-muted"
        }`}
      >
        {entry.level}
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

  // hydratedRef ensures the skeleton-to-content transition fires only on the
  // first load; subsequent filter-change reloads skip the animation entirely.
  const hydratedRef = useRef(false);

  // Initial load + filter-change reload: loadLogs has a stable identity
  // (reads filter values from refs at call-time) so adding the filter values
  // here makes the effect fire on mount AND whenever a dropdown filter changes,
  // without firing on every other re-render of the parent.
  // biome-ignore lint/correctness/useExhaustiveDependencies: filter values are intentional extra deps — loadLogs reads them via refs; we still want the effect to re-run when they change
  useEffect(() => {
    let cancelled = false;
    let settleTimer: number | undefined;
    void loadLogs().finally(() => {
      if (cancelled) return;
      if (!hydratedRef.current) {
        hydratedRef.current = true;
        setLogHydrationSettling(true);
        setInitialLoading(false);
        settleTimer = window.setTimeout(() => {
          if (!cancelled) setLogHydrationSettling(false);
        }, LOG_HYDRATION_SETTLE_MS);
      }
    });
    return () => {
      cancelled = true;
      if (settleTimer !== undefined) window.clearTimeout(settleTimer);
      // If deps change mid-settle, the re-run effect skips the hydratedRef
      // block entirely — reset here so the settling flag can't stick true.
      setLogHydrationSettling(false);
    };
  }, [loadLogs, logTagFilter, logLevelFilter, logSourceFilter]);

  // Live tail only ticks while the document is visible; pauses when the
  // tab/window is hidden and resumes on visibilitychange.
  useIntervalWhenDocumentVisible(() => void loadLogs(), 5000);

  const handleClearFilters = () => {
    setState("logTagFilter", "");
    setState("logLevelFilter", "");
    setState("logSourceFilter", "");
    setSearchQuery("");
  };

  const filterControl = useAgentElement<HTMLButtonElement>({
    id: "logs-filter",
    role: "button",
    label: "Filter logs",
    group: "logs",
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
      <PagePanel
        variant="section"
        className="space-y-3 border-b border-border/35 pb-3"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted">Show</span>
          <div className="flex items-center gap-3">
            {errorCount > 0 ? (
              <span className="text-xs text-danger tabular-nums">
                {t("logsview.ErrorCount", {
                  count: errorCount,
                  defaultValue: "{{count}} errors",
                })}
              </span>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  ref={filterControl.ref}
                  variant="ghost"
                  size="sm"
                  className="gap-2"
                  {...filterControl.agentProps}
                >
                  <span>{hasActiveFilters ? "Filtered" : "All logs"}</span>
                  <span className="text-muted tabular-nums">
                    {filteredLogs.length}
                  </span>
                  <ChevronDown className="size-4 text-muted" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-56">
                <DropdownMenuLabel>Level</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={logLevelFilter === "" ? "all" : logLevelFilter}
                  onValueChange={(value) =>
                    setState("logLevelFilter", value === "all" ? "" : value)
                  }
                >
                  <DropdownMenuRadioItem value="all">
                    {t("logsview.AllLevels")}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="debug">
                    {t("logsview.Debug")}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="info">
                    {t("logsview.Info")}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="warn">
                    {t("logsview.Warn")}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="error">
                    {t("common.error")}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                {logSources.length > 0 ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Source</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={logSourceFilter === "" ? "all" : logSourceFilter}
                      onValueChange={(value) =>
                        setState(
                          "logSourceFilter",
                          value === "all" ? "" : value,
                        )
                      }
                    >
                      <DropdownMenuRadioItem value="all">
                        {t("logsview.AllSources")}
                      </DropdownMenuRadioItem>
                      {logSources.map((source) => (
                        <DropdownMenuRadioItem key={source} value={source}>
                          {source}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </>
                ) : null}
                {logTags.length > 0 ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Tag</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={logTagFilter === "" ? "all" : logTagFilter}
                      onValueChange={(value) =>
                        setState("logTagFilter", value === "all" ? "" : value)
                      }
                    >
                      <DropdownMenuRadioItem value="all">
                        {t("logsview.AllTags")}
                      </DropdownMenuRadioItem>
                      {logTags.map((tag) => (
                        <DropdownMenuRadioItem key={tag} value={tag}>
                          {tag}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </>
                ) : null}
                {hasActiveFilters ? (
                  <>
                    <DropdownMenuSeparator />
                    <Button
                      ref={clearControl.ref}
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start"
                      onClick={handleClearFilters}
                      {...clearControl.agentProps}
                    >
                      {t("logsview.ClearFilters")}
                    </Button>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
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
            <Button size="sm" onClick={() => void loadLogs()}>
              {t("common.retry", { defaultValue: "Retry" })}
            </Button>
          </div>
        ) : null}
      </PagePanel>

      {/* Log entries — full remaining height */}
      <PagePanel
        variant="section"
        data-testid="logs-entry-panel"
        className="flex-1 min-h-0 overflow-y-auto text-sm"
        {...logPanelShiftIntentProps}
      >
        {initialLoading && filteredLogs.length === 0 && !logLoadError ? (
          <ListSkeleton
            className="m-1"
            rows={LOG_INITIAL_SKELETON_ROWS}
            rowClassName={LOG_INITIAL_SKELETON_ROW_CLASS}
          />
        ) : filteredLogs.length === 0 && !logLoadError ? (
          <PagePanel.Empty
            className="flex-1 [@media(max-height:480px)]:min-h-[9rem] [@media(max-height:480px)]:gap-2 [@media(max-height:480px)]:p-3"
            icon={<ScrollText className="size-6" aria-hidden />}
            title={
              hasActiveFilters
                ? t("logsview.NoLogEntriesMatchingFiltersDescription")
                : t("logsview.NoLogEntriesYetDescription")
            }
            action={
              hasActiveFilters ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleClearFilters}
                >
                  {t("logsview.ClearFilters")}
                </Button>
              ) : undefined
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
