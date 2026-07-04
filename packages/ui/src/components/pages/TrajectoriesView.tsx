/**
 * The Trajectories view: a paginated, searchable list of recorded model
 * trajectories (scenario/batch runs) with per-row select, download, and delete.
 * Selection can be controlled by a parent (master/detail) or self-managed
 * standalone. Binds the floating chat composer as its search box; data and
 * mutations flow through the trajectories API.
 */
import { Download, Route, Trash2, XCircle } from "lucide-react";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAgentElement } from "../../agent-surface";
import { client } from "../../api/client";
import type {
  TrajectoryListResult,
  TrajectoryRecord,
} from "../../api/client-types-cloud";
import { getCached, setCached } from "../../hooks/resource-cache";
import { useIntervalWhenDocumentVisible } from "../../hooks/useDocumentVisibility";
import { PageLayout } from "../../layouts/page-layout/page-layout";
import { useAppSelector } from "../../state";
import { useRegisterViewChatBinding } from "../../state/view-chat-binding";
import {
  formatTrajectoryDuration,
  formatTrajectoryTimestamp,
  formatTrajectoryTokenCount,
} from "../../utils/trajectory-format";
import { ChatEmptyStateWithRecommendations } from "../composites/chat";
import { PagePanel } from "../composites/page-panel";
import { SidebarContent } from "../composites/sidebar/sidebar-content";
import { SidebarPanel } from "../composites/sidebar/sidebar-panel";
import { SidebarScrollRegion } from "../composites/sidebar/sidebar-scroll-region";
import { TrajectorySidebarItem } from "../composites/trajectories/trajectory-sidebar-item";
import { AppPageSidebar } from "../shared/AppPageSidebar";
import { ConfirmDeleteControl } from "../shared/confirm-delete-control";
import { Button, type ButtonProps } from "../ui/button";
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

function agentSafeId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "trajectory"
  );
}

function AgentToolbarButton({
  agentId,
  agentLabel,
  agentDescription,
  agentGroup = "trajectories-toolbar",
  agentStatus,
  onActivate,
  ...buttonProps
}: ButtonProps & {
  agentId: string;
  agentLabel: string;
  agentDescription?: string;
  agentGroup?: string;
  agentStatus?: string;
  onActivate?: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "button",
    label: agentLabel,
    group: agentGroup,
    status: agentStatus,
    description: agentDescription,
    onActivate,
  });

  return <Button ref={ref} {...agentProps} {...buttonProps} />;
}

function AgentDropdownMenuItem({
  agentId,
  agentLabel,
  agentDescription,
  agentGroup = "trajectories-export",
  ...itemProps
}: ComponentProps<typeof DropdownMenuItem> & {
  agentId: string;
  agentLabel: string;
  agentDescription?: string;
  agentGroup?: string;
}) {
  const { ref, agentProps } = useAgentElement<HTMLDivElement>({
    id: agentId,
    role: "menu-item",
    label: agentLabel,
    group: agentGroup,
    description: agentDescription,
  });

  return <DropdownMenuItem ref={ref} {...agentProps} {...itemProps} />;
}

function AgentTrajectorySidebarItem({
  trajectory,
  selected,
  statusColor,
  onSelect,
}: {
  trajectory: TrajectoryRecord;
  selected: boolean;
  statusColor: string;
  onSelect: () => void;
}) {
  const title = formatTrajectoryTimestamp(trajectory.createdAt, "smart");
  useAgentElement({
    id: `trajectory-${agentSafeId(trajectory.id)}`,
    role: "list-item",
    label: `Open trajectory ${title}`,
    group: "trajectories-list",
    status: selected ? "active" : trajectory.status,
    description: "Select this trajectory and open its prompt/tool timeline",
    onActivate: onSelect,
  });

  return (
    <TrajectorySidebarItem
      active={selected}
      onSelect={onSelect}
      callCount={trajectory.llmCallCount}
      title={title}
      sourceLabel={formatTrajectorySourceLabel(trajectory)}
      sourceColor={SOURCE_FG}
      statusLabel={trajectory.status}
      statusColor={statusColor}
      tokenLabel={`${formatTrajectoryTokenCount(
        trajectory.totalPromptTokens + trajectory.totalCompletionTokens,
        { emptyLabel: "0" },
      )} tokens`}
      durationLabel={formatTrajectoryDuration(trajectory.durationMs)}
    />
  );
}

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
  const t = useAppSelector((s) => s.t);
  const setActionNotice = useAppSelector((s) => s.setActionNotice);
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

  // Poll for new turns in the background instead of a manual refresh button.
  // Gated on document visibility so a backgrounded window stops polling.
  useIntervalWhenDocumentVisible(() => {
    void loadTrajectories({ silent: true });
  }, 15000);

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
          <SidebarContent.Toolbar className="mb-3 items-center justify-end gap-2">
            <SidebarContent.ToolbarActions>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <AgentToolbarButton
                    agentId="trajectories-export-open"
                    agentLabel="Open trajectory export menu"
                    agentDescription="Open export options for trajectory logs"
                    agentStatus={
                      exporting || trajectories.length === 0
                        ? "disabled"
                        : "ready"
                    }
                    variant="outline"
                    size="icon"
                    type="button"
                    className="h-7 w-7 rounded-full"
                    disabled={exporting || trajectories.length === 0}
                    title={t("common.export")}
                  >
                    <Download className="h-3 w-3" />
                  </AgentToolbarButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <AgentDropdownMenuItem
                    agentId="trajectories-export-json-prompts"
                    agentLabel="Export trajectories as JSON with prompts"
                    onClick={() => handleExport("json", true)}
                  >
                    {t("trajectoriesview.JSONWithPrompts")}
                  </AgentDropdownMenuItem>
                  <AgentDropdownMenuItem
                    agentId="trajectories-export-jsonl-native"
                    agentLabel="Export trajectories as native JSONL training data"
                    onClick={() =>
                      handleExport("jsonl", true, "eliza_native_v1")
                    }
                  >
                    {t("trajectoriesview.JSONLNativeTraining")}
                  </AgentDropdownMenuItem>
                  <AgentDropdownMenuItem
                    agentId="trajectories-export-json-redacted"
                    agentLabel="Export trajectories as redacted JSON"
                    onClick={() => handleExport("json", false)}
                  >
                    {t("trajectoriesview.JSONRedacted")}
                  </AgentDropdownMenuItem>
                  <AgentDropdownMenuItem
                    agentId="trajectories-export-csv-summary"
                    agentLabel="Export trajectories as CSV summary"
                    onClick={() => handleExport("csv", false)}
                  >
                    {t("trajectoriesview.CSVSummaryOnly")}
                  </AgentDropdownMenuItem>
                  <AgentDropdownMenuItem
                    agentId="trajectories-export-zip-folders"
                    agentLabel="Export trajectories as ZIP folders"
                    onClick={() => handleExport("zip", true)}
                  >
                    {t("trajectoriesview.ZIPFolders")}
                  </AgentDropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <ConfirmDeleteControl
                agentId="trajectories-delete-current-open"
                agentLabel="Delete current trajectory"
                agentGroup="trajectories-toolbar"
                agentDescription="Open the confirmation controls for deleting the selected trajectory"
                confirmAgentId="trajectories-delete-current-confirm"
                cancelAgentId="trajectories-delete-current-cancel"
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
                agentId="trajectories-clear-all-open"
                agentLabel="Clear all trajectories"
                agentGroup="trajectories-toolbar"
                agentDescription="Open the confirmation controls for deleting every trajectory"
                confirmAgentId="trajectories-clear-all-confirm"
                cancelAgentId="trajectories-clear-all-cancel"
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
                  <AgentTrajectorySidebarItem
                    key={trajectory.id}
                    trajectory={trajectory}
                    selected={selected}
                    statusColor={statusColor}
                    onSelect={() => onSelectTrajectory?.(trajectory.id)}
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
                <AgentToolbarButton
                  agentId="trajectories-page-prev"
                  agentLabel="Previous trajectories page"
                  agentDescription="Move to the previous page of trajectory logs"
                  agentStatus={page === 0 ? "disabled" : "ready"}
                  onActivate={() =>
                    setPage((current) => Math.max(0, current - 1))
                  }
                  variant="outline"
                  size="sm"
                  type="button"
                  className="h-8 rounded-full px-3 text-xs-tight"
                  onClick={() => setPage((current) => Math.max(0, current - 1))}
                  disabled={page === 0}
                >
                  {t("common.prev")}
                </AgentToolbarButton>
                <AgentToolbarButton
                  agentId="trajectories-page-next"
                  agentLabel="Next trajectories page"
                  agentDescription="Move to the next page of trajectory logs"
                  agentStatus={page >= totalPages - 1 ? "disabled" : "ready"}
                  onActivate={() => setPage((current) => current + 1)}
                  variant="outline"
                  size="sm"
                  type="button"
                  className="h-8 rounded-full px-3 text-xs-tight"
                  onClick={() => setPage((current) => current + 1)}
                  disabled={page >= totalPages - 1}
                >
                  {t("common.next")}
                </AgentToolbarButton>
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
        {error ? (
          <PagePanel.Notice tone="danger" className="mb-4">
            {error}
          </PagePanel.Notice>
        ) : null}

        {loading && trajectories.length === 0 ? (
          <ListSkeleton rows={8} />
        ) : !loading && trajectories.length === 0 ? (
          <ChatEmptyStateWithRecommendations
            icon={Route}
            title={
              hasActiveFilters
                ? t("trajectoriesview.NoTrajectoriesMatchingFilters")
                : t("trajectoriesview.NoTrajectoriesYet")
            }
            recommendations={[
              t("trajectoriesview.RecRunAgent", {
                defaultValue: "Run the agent so a turn shows up here",
              }),
              t("trajectoriesview.RecSummarize", {
                defaultValue: "Summarize what the agent did on its last turn",
              }),
              t("trajectoriesview.RecExplainPipeline", {
                defaultValue: "Explain each stage of the reasoning pipeline",
              }),
            ]}
          />
        ) : detailTrajectoryId ? (
          <TrajectoryDetailView trajectoryId={detailTrajectoryId} />
        ) : null}
      </PageLayout>
    </ShellViewAgentSurface>
  );
}
