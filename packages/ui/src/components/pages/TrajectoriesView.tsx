import { Download, Route, Trash2, XCircle } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { client } from "../../api/client";
import type {
  TrajectoryListResult,
  TrajectoryRecord,
} from "../../api/client-types-cloud";
import { getCached, setCached } from "../../hooks/resource-cache";
import { PageLayout } from "../../layouts/page-layout/page-layout";
import { useApp } from "../../state/useApp";
import { useRegisterViewChatBinding } from "../../state/view-chat-binding";
import {
  formatTrajectoryDuration,
  formatTrajectoryTimestamp,
  formatTrajectoryTokenCount,
} from "../../utils/trajectory-format";
import { ChatSearchHint } from "../composites/chat-search-hint";
import { PagePanel } from "../composites/page-panel";
import { SidebarContent } from "../composites/sidebar/sidebar-content";
import { SidebarPanel } from "../composites/sidebar/sidebar-panel";
import { SidebarScrollRegion } from "../composites/sidebar/sidebar-scroll-region";
import { TrajectorySidebarItem } from "../composites/trajectories/trajectory-sidebar-item";
import { AppPageSidebar } from "../shared/AppPageSidebar";
import { ConfirmDeleteControl } from "../shared/confirm-delete-control";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { ListSkeleton } from "../ui/skeleton-layouts";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import { TrajectoryDetailView } from "./TrajectoryDetailView";

const NEUTRAL_FG = "var(--muted)";

// Only `error` is an alert; `active` rides the --info status color (info blue is
// allowed). `completed` is a terminal, non-alert state, so it stays neutral.
const STATUS_COLORS: Record<string, string> = {
  active: "var(--info)",
  completed: NEUTRAL_FG,
  error: "var(--danger)",
};

// Source tags are decorative metadata, not status — keep them all neutral.
const SOURCE_FG = NEUTRAL_FG;

function formatTrajectorySourceLabel(trajectory: TrajectoryRecord): string {
  const parts = [trajectory.source];
  if (trajectory.scenarioId) parts.push(trajectory.scenarioId);
  if (trajectory.batchId) parts.push(trajectory.batchId);
  return parts.join(" • ");
}

interface TrajectoriesViewProps {
  contentHeader?: ReactNode;
  selectedTrajectoryId?: string | null;
  onSelectTrajectory?: (id: string | null) => void;
}

export function TrajectoriesView({
  contentHeader,
  selectedTrajectoryId: controlledId,
  onSelectTrajectory: controlledOnSelect,
}: TrajectoriesViewProps) {
  const { t, setActionNotice } = useApp();
  const [error, setError] = useState<string | null>(null);

  // Self-manage selection when no external callback is provided (standalone mode).
  const [internalId, setInternalId] = useState<string | null>(null);
  const selectedTrajectoryId = controlledOnSelect
    ? (controlledId ?? null)
    : internalId;
  const onSelectTrajectory = controlledOnSelect ?? setInternalId;

  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(0);
  const pageSize = 50;
  const previousSearchQueryRef = useRef(searchQuery);

  // The one floating chat composer is this view's search box: typing in it
  // drives `searchQuery` (which re-queries via `loadTrajectories`) and resets
  // pagination. The binding clears when the view unmounts.
  const searchPlaceholder = t("trajectoriesview.Search", {
    defaultValue: "Search...",
  });
  const onQuery = useCallback((value: string) => {
    setSearchQuery(value);
    setPage(0);
  }, []);
  const chatBinding = useMemo(
    () => ({ placeholder: searchPlaceholder, onQuery }),
    [searchPlaceholder, onQuery],
  );
  useRegisterViewChatBinding(chatBinding);

  // Seed from the shared cache so a revisit paints the last-known page
  // instantly and revalidates silently, instead of flashing a spinner. The
  // key carries every fetch parameter so distinct pages/queries don't collide.
  const cacheKey = `trajectories:${page}:${searchQuery}`;
  const cachedResult = getCached<TrajectoryListResult>(cacheKey);
  const [result, setResult] = useState<TrajectoryListResult | null>(
    cachedResult?.data ?? null,
  );
  const [loading, setLoading] = useState(!cachedResult);

  const [exporting, setExporting] = useState(false);
  const [deletingTrajectoryId, setDeletingTrajectoryId] = useState<
    string | null
  >(null);
  const [clearingAll, setClearingAll] = useState(false);

  const loadTrajectories = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!options?.silent) setLoading(true);
      setError(null);

      for (let attempt = 0; attempt <= 3; attempt++) {
        try {
          const trajResult = await client.getTrajectories({
            limit: pageSize,
            offset: page * pageSize,
            search: searchQuery || undefined,
          });
          setResult(trajResult);
          setCached(cacheKey, trajResult);
          setLoading(false);
          return;
        } catch (err) {
          const status = (err as { status?: number }).status;
          if (status === 503 && attempt < 3) {
            await new Promise((resolve) =>
              setTimeout(resolve, 1000 * (attempt + 1)),
            );
            continue;
          }
          setError(
            err instanceof Error
              ? err.message
              : t("trajectoriesview.FailedToLoad"),
          );
          setLoading(false);
          return;
        }
      }
    },
    [cacheKey, page, searchQuery, t],
  );

  useEffect(() => {
    // Revalidate silently when this page/query is already cached on screen.
    void loadTrajectories({
      silent: getCached<TrajectoryListResult>(cacheKey) != null,
    });
  }, [loadTrajectories, cacheKey]);

  useEffect(() => {
    // Poll for new turns in the background instead of a manual refresh button.
    const interval = setInterval(() => {
      void loadTrajectories({ silent: true });
    }, 15000);
    return () => clearInterval(interval);
  }, [loadTrajectories]);

  useEffect(() => {
    const previousSearchQuery = previousSearchQueryRef.current;
    if (previousSearchQuery === searchQuery) {
      return;
    }
    previousSearchQueryRef.current = searchQuery;
    if (selectedTrajectoryId != null) {
      onSelectTrajectory?.(null);
    }
  }, [searchQuery, selectedTrajectoryId, onSelectTrajectory]);

  const handleExport = async (
    format: "json" | "jsonl" | "csv" | "zip",
    includePrompts: boolean,
    jsonShape?: "eliza_native_v1",
  ) => {
    setExporting(true);
    try {
      const blob = await client.exportTrajectories({
        format,
        includePrompts,
        ...(jsonShape ? { jsonShape } : {}),
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `trajectories-${new Date().toISOString().split("T")[0]}.${format}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("trajectoriesview.FailedToExport"),
      );
    } finally {
      setExporting(false);
    }
  };

  const hasActiveFilters = searchQuery !== "";
  const trajectories = useMemo(() => result?.trajectories ?? [], [result]);
  const total = result?.total ?? 0;
  const totalPages = Math.ceil(total / pageSize);

  useLayoutEffect(() => {
    if (loading) return;
    if (trajectories.length === 0) {
      if (selectedTrajectoryId != null) onSelectTrajectory?.(null);
      return;
    }
    if (selectedTrajectoryId == null) {
      onSelectTrajectory?.(trajectories[0].id);
      return;
    }
    if (
      page === 0 &&
      !trajectories.some((tr) => tr.id === selectedTrajectoryId)
    ) {
      onSelectTrajectory?.(trajectories[0].id);
    }
  }, [loading, trajectories, selectedTrajectoryId, onSelectTrajectory, page]);

  const detailTrajectoryId =
    trajectories.length === 0
      ? null
      : (selectedTrajectoryId ?? trajectories[0]?.id ?? null);
  const deleteDisabled =
    loading ||
    clearingAll ||
    deletingTrajectoryId !== null ||
    detailTrajectoryId === null;
  const clearAllDisabled =
    loading || clearingAll || deletingTrajectoryId !== null || total === 0;

  const handleDeleteTrajectory = useCallback(
    async (trajectoryId: string) => {
      const normalizedId = trajectoryId.trim();
      if (!normalizedId) return;

      setDeletingTrajectoryId(normalizedId);
      setError(null);

      try {
        const response = await client.deleteTrajectories([normalizedId]);
        const deletedCount = Number(response.deleted ?? 0);

        if (selectedTrajectoryId === normalizedId) {
          const remainingOnPage = trajectories.filter(
            (trajectory) => trajectory.id !== normalizedId,
          );
          onSelectTrajectory?.(remainingOnPage[0]?.id ?? null);
        }

        if (page > 0 && trajectories.length <= 1) {
          setPage((currentPage) => Math.max(0, currentPage - 1));
        } else {
          await loadTrajectories();
        }

        if (deletedCount > 0) {
          setActionNotice?.(
            t("trajectoriesview.TrajectoryDeleted", {
              defaultValue: "Trajectory deleted.",
            }),
            "success",
            2400,
          );
        } else {
          setActionNotice?.(
            t("trajectoriesview.NoTrajectoryDeleted", {
              defaultValue: "No trajectory was deleted.",
            }),
            "info",
            2400,
          );
        }
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : t("trajectoriesview.FailedToDelete", {
                defaultValue: "Failed to delete trajectory",
              });
        setError(message);
        setActionNotice?.(message, "error", 4200);
      } finally {
        setDeletingTrajectoryId((currentId) =>
          currentId === normalizedId ? null : currentId,
        );
      }
    },
    [
      loadTrajectories,
      onSelectTrajectory,
      page,
      selectedTrajectoryId,
      setActionNotice,
      t,
      trajectories,
    ],
  );

  const handleClearAllTrajectories = useCallback(async () => {
    setClearingAll(true);
    setError(null);

    try {
      const response = await client.clearAllTrajectories();
      setResult({
        trajectories: [],
        total: 0,
        offset: 0,
        limit: pageSize,
      });
      setPage(0);
      onSelectTrajectory?.(null);

      if (Number(response.deleted ?? 0) > 0) {
        setActionNotice?.(
          t("trajectoriesview.TrajectoriesCleared", {
            defaultValue: "Trajectories cleared.",
          }),
          "success",
          2400,
        );
      } else {
        setActionNotice?.(
          t("trajectoriesview.NoTrajectoryDeleted", {
            defaultValue: "No trajectory was deleted.",
          }),
          "info",
          2400,
        );
      }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t("trajectoriesview.FailedToClear", {
              defaultValue: "Failed to clear trajectories",
            });
      setError(message);
      setActionNotice?.(message, "error", 4200);
    } finally {
      setClearingAll(false);
    }
  }, [onSelectTrajectory, setActionNotice, t]);

  const trajectoriesSidebar = (
    <AppPageSidebar
      testId="trajectories-sidebar"
      collapsible
      contentIdentity="trajectories"
      aria-label={t("trajectoriesview.Entries", {
        defaultValue: "Entries",
      })}
    >
      <SidebarScrollRegion>
        <SidebarPanel>
          <SidebarContent.Toolbar className="mb-3 items-center justify-between gap-2">
            <span className="text-sm font-medium text-txt-strong">
              {t("trajectoriesview.Entries", {
                defaultValue: "Entries",
              })}
            </span>
            <SidebarContent.ToolbarActions>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    type="button"
                    className="h-7 w-7 rounded-full"
                    disabled={exporting || trajectories.length === 0}
                    title={t("common.export")}
                  >
                    <Download className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem onClick={() => handleExport("json", true)}>
                    {t("trajectoriesview.JSONWithPrompts")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      handleExport("jsonl", true, "eliza_native_v1")
                    }
                  >
                    {t("trajectoriesview.JSONLNativeTraining")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleExport("json", false)}>
                    {t("trajectoriesview.JSONRedacted")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleExport("csv", false)}>
                    {t("trajectoriesview.CSVSummaryOnly")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleExport("zip", true)}>
                    {t("trajectoriesview.ZIPFolders")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <ConfirmDeleteControl
                triggerVariant="outline"
                triggerClassName="h-7 w-7 rounded-full text-danger transition-all hover:bg-danger/10"
                confirmClassName="h-7 rounded-full border border-danger/25 bg-danger/14 px-3 text-2xs font-bold text-danger transition-all hover:bg-danger/20"
                cancelClassName="h-7 rounded-full border border-border/35 px-3 text-2xs font-bold text-muted-strong transition-all hover:border-border-strong hover:text-txt"
                disabled={deleteDisabled}
                triggerLabel={<Trash2 className="h-3 w-3" />}
                triggerTitle={t("trajectoriesview.DeleteCurrent", {
                  defaultValue: "Delete current",
                })}
                promptText={t("trajectoriesview.DeleteCurrentPrompt", {
                  defaultValue: "Delete this trajectory?",
                })}
                busyLabel={t("trajectoriesview.Deleting", {
                  defaultValue: "Deleting...",
                })}
                onConfirm={() => {
                  if (detailTrajectoryId) {
                    void handleDeleteTrajectory(detailTrajectoryId);
                  }
                }}
              />
              <ConfirmDeleteControl
                triggerVariant="outline"
                triggerClassName="h-7 w-7 rounded-full text-danger transition-all hover:bg-danger/10"
                confirmClassName="h-7 rounded-full border border-danger/25 bg-danger/14 px-3 text-2xs font-bold text-danger transition-all hover:bg-danger/20"
                cancelClassName="h-7 rounded-full border border-border/35 px-3 text-2xs font-bold text-muted-strong transition-all hover:border-border-strong hover:text-txt"
                disabled={clearAllDisabled}
                triggerLabel={<XCircle className="h-3 w-3" />}
                triggerTitle={t("trajectoriesview.ClearAll", {
                  defaultValue: "Clear all",
                })}
                promptText={t("trajectoriesview.ClearAllPrompt", {
                  defaultValue: "Delete all trajectories?",
                })}
                busyLabel={t("trajectoriesview.Clearing", {
                  defaultValue: "Clearing...",
                })}
                onConfirm={() => {
                  void handleClearAllTrajectories();
                }}
              />
            </SidebarContent.ToolbarActions>
          </SidebarContent.Toolbar>

          {loading && trajectories.length === 0 ? (
            <SidebarContent.EmptyState>
              {t("trajectoriesview.LoadingTrajectories")}
            </SidebarContent.EmptyState>
          ) : trajectories.length === 0 ? (
            <SidebarContent.EmptyState>
              {hasActiveFilters
                ? t("trajectoriesview.NoTrajectoriesMatchingFilters")
                : t("trajectoriesview.NoTrajectoriesYet")}
            </SidebarContent.EmptyState>
          ) : (
            <div className="space-y-1.5">
              {trajectories.map((trajectory: TrajectoryRecord) => {
                const selected = selectedTrajectoryId === trajectory.id;
                const statusColor =
                  STATUS_COLORS[trajectory.status] ?? STATUS_COLORS.completed;

                return (
                  <TrajectorySidebarItem
                    key={trajectory.id}
                    active={selected}
                    onSelect={() => onSelectTrajectory?.(trajectory.id)}
                    callCount={trajectory.llmCallCount}
                    title={formatTrajectoryTimestamp(
                      trajectory.createdAt,
                      "smart",
                    )}
                    sourceLabel={formatTrajectorySourceLabel(trajectory)}
                    sourceColor={SOURCE_FG}
                    statusLabel={trajectory.status}
                    statusColor={statusColor}
                    tokenLabel={`${formatTrajectoryTokenCount(
                      trajectory.totalPromptTokens +
                        trajectory.totalCompletionTokens,
                      { emptyLabel: "0" },
                    )} tokens`}
                    durationLabel={formatTrajectoryDuration(
                      trajectory.durationMs,
                    )}
                  />
                );
              })}
            </div>
          )}

          {totalPages > 1 && (
            <div className="mt-3 flex items-center justify-between gap-2 pt-3 text-xs text-muted">
              <span className="min-w-0">
                {t("trajectoriesview.ShowingRange", {
                  start: page * pageSize + 1,
                  end: Math.min((page + 1) * pageSize, total),
                  total,
                })}
              </span>
              <div className="flex gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  className="h-8 rounded-full px-3 text-xs-tight"
                  onClick={() => setPage((current) => Math.max(0, current - 1))}
                  disabled={page === 0}
                >
                  {t("common.prev")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  className="h-8 rounded-full px-3 text-xs-tight"
                  onClick={() => setPage((current) => current + 1)}
                  disabled={page >= totalPages - 1}
                >
                  {t("common.next")}
                </Button>
              </div>
            </div>
          )}
        </SidebarPanel>
      </SidebarScrollRegion>
    </AppPageSidebar>
  );

  return (
    <ShellViewAgentSurface viewId="trajectories">
      <PageLayout
        sidebar={trajectoriesSidebar}
        contentHeader={contentHeader}
        contentInnerClassName="mx-auto w-full max-w-[76rem]"
        data-testid="trajectories-view"
      >
        <ChatSearchHint
          noun="trajectories"
          query={searchQuery}
          className="mb-4"
        />

        {error ? (
          <PagePanel.Notice tone="danger" className="mb-4">
            {error}
          </PagePanel.Notice>
        ) : null}

        {loading && trajectories.length === 0 ? (
          <ListSkeleton rows={8} />
        ) : !loading && trajectories.length === 0 ? (
          <PagePanel.FeatureEmpty
            className="rounded-sm"
            icon={Route}
            title={
              hasActiveFilters
                ? t("trajectoriesview.NoTrajectoriesMatchingFilters")
                : t("trajectoriesview.NoTrajectoriesYet")
            }
            description={
              hasActiveFilters
                ? undefined
                : t("trajectoriesview.EmptyHint", {
                    defaultValue: "Run the agent and turns will show up here.",
                  })
            }
          />
        ) : detailTrajectoryId ? (
          <TrajectoryDetailView trajectoryId={detailTrajectoryId} />
        ) : null}
      </PageLayout>
    </ShellViewAgentSurface>
  );
}
