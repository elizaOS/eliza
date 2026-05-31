import {
  Braces,
  Download,
  FileJson,
  RefreshCw,
  Route,
  Trash2,
  XCircle,
} from "lucide-react";
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
import { PageLayout } from "../../layouts/page-layout/page-layout";
import { useApp } from "../../state/useApp";
import {
  formatTrajectoryDuration,
  formatTrajectoryTimestamp,
  formatTrajectoryTokenCount,
} from "../../utils/trajectory-format";
import { PagePanel } from "../composites/page-panel";
import { SidebarContent } from "../composites/sidebar/sidebar-content";
import { SidebarHeader } from "../composites/sidebar/sidebar-header";
import { SidebarPanel } from "../composites/sidebar/sidebar-panel";
import { SidebarScrollRegion } from "../composites/sidebar/sidebar-scroll-region";
import { TrajectorySidebarItem } from "../composites/trajectories/trajectory-sidebar-item";
import { AppPageSidebar } from "../shared/AppPageSidebar";
import { ConfirmDeleteControl } from "../shared/confirm-delete-control";
import { Button } from "../ui/button";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { TrajectoryDetailView } from "./TrajectoryDetailView";

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  // active uses the --info status color (blue is a legitimate status here).
  active: {
    bg: "color-mix(in srgb, var(--info) 15%, transparent)",
    fg: "var(--info)",
  },
  completed: { bg: "rgba(34, 197, 94, 0.15)", fg: "rgb(34, 197, 94)" },
  error: { bg: "rgba(239, 68, 68, 0.15)", fg: "rgb(239, 68, 68)" },
};

const SOURCE_COLORS: Record<string, { bg: string; fg: string }> = {
  // Source tags are decorative — route blue/indigo/violet through accent/muted.
  chat: {
    bg: "color-mix(in srgb, var(--accent) 15%, transparent)",
    fg: "var(--accent)",
  },
  autonomy: { bg: "rgba(245, 158, 11, 0.15)", fg: "rgb(245, 158, 11)" },
  telegram: { bg: "rgba(34, 197, 94, 0.15)", fg: "rgb(34, 197, 94)" },
  discord: {
    bg: "color-mix(in srgb, var(--muted) 15%, transparent)",
    fg: "var(--muted)",
  },
  api: { bg: "rgba(156, 163, 175, 0.15)", fg: "rgb(156, 163, 175)" },
  orchestrator: {
    bg: "color-mix(in srgb, var(--muted) 15%, transparent)",
    fg: "var(--muted)",
  },
};

const TRAJECTORY_EMPTY_FEATURES = [
  { id: "json", label: "JSON", icon: FileJson, tone: "text-info" },
  { id: "calls", label: "Calls", icon: Braces, tone: "text-accent" },
  { id: "refresh", label: "Refresh", icon: RefreshCw, tone: "text-ok" },
] as const;

function formatTrajectorySourceLabel(trajectory: TrajectoryRecord): string {
  const parts = [trajectory.source];
  if (trajectory.scenarioId) parts.push(trajectory.scenarioId);
  if (trajectory.batchId) parts.push(trajectory.batchId);
  return parts.join(" • ");
}

/**
 * Export dropdown trigger. The trigger is a composite (`DropdownMenuTrigger`
 * clones a `Button` via Radix `Slot`), so it registers with `onActivate` —
 * which opens the menu — rather than relying on a forwarded DOM ref.
 */
function TrajectoriesExportTrigger({
  disabled,
  label,
  onOpen,
}: {
  disabled: boolean;
  label: string;
  onOpen: () => void;
}) {
  const { agentProps } = useAgentElement({
    id: "action-export",
    role: "button",
    label,
    group: "trajectories-actions",
    description: "Open the trajectory export menu",
    onActivate: onOpen,
  });
  return (
    <DropdownMenuTrigger asChild>
      <Button
        variant="outline"
        size="icon"
        type="button"
        className="h-7 w-7 rounded-full"
        disabled={disabled}
        title={label}
        {...agentProps}
      >
        <Download className="h-3 w-3" />
      </Button>
    </DropdownMenuTrigger>
  );
}

/**
 * Agent-addressable wrapper for a `ConfirmDeleteControl`. The control is a
 * composite that doesn't forward a DOM ref, so it registers with `onActivate`
 * (which runs the confirmed action directly).
 */
function TrajectoriesDeleteControl({
  id,
  label,
  description,
  onActivate,
  ...controlProps
}: {
  id: string;
  label: string;
  description: string;
  onActivate: () => void;
} & ComponentProps<typeof ConfirmDeleteControl>) {
  useAgentElement({
    id,
    role: "button",
    label,
    group: "trajectories-actions",
    description,
    onActivate,
  });
  return <ConfirmDeleteControl {...controlProps} />;
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
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<TrajectoryListResult | null>(null);
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

  const [exporting, setExporting] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [deletingTrajectoryId, setDeletingTrajectoryId] = useState<
    string | null
  >(null);
  const [clearingAll, setClearingAll] = useState(false);

  const loadTrajectories = useCallback(async () => {
    setLoading(true);
    setError(null);

    for (let attempt = 0; attempt <= 3; attempt++) {
      try {
        const trajResult = await client.getTrajectories({
          limit: pageSize,
          offset: page * pageSize,
          search: searchQuery || undefined,
        });
        setResult(trajResult);
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
  }, [page, searchQuery, t]);

  useEffect(() => {
    void loadTrajectories();
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

  const searchAgent = useAgentElement<HTMLInputElement>({
    id: "input-search",
    role: "text-input",
    label: t("trajectoriesview.Search"),
    group: "trajectories-filters",
    description: "Filter trajectories by search text",
    getValue: () => searchQuery,
    onFill: (value) => {
      setSearchQuery(value);
      setPage(0);
    },
  });
  const refreshAgent = useAgentElement<HTMLButtonElement>({
    id: "action-refresh",
    role: "button",
    label: t("common.refresh"),
    group: "trajectories-actions",
    description: "Reload the trajectory list",
    onActivate: () => void loadTrajectories(),
  });
  const prevPageAgent = useAgentElement<HTMLButtonElement>({
    id: "action-prev-page",
    role: "button",
    label: t("common.prev"),
    group: "trajectories-pagination",
    description: "Go to the previous page of trajectories",
    onActivate: () => setPage((current) => Math.max(0, current - 1)),
  });
  const nextPageAgent = useAgentElement<HTMLButtonElement>({
    id: "action-next-page",
    role: "button",
    label: t("common.next"),
    group: "trajectories-pagination",
    description: "Go to the next page of trajectories",
    onActivate: () => setPage((current) => current + 1),
  });

  const trajectoriesSidebar = (
    <AppPageSidebar
      testId="trajectories-sidebar"
      collapsible
      contentIdentity="trajectories"
      aria-label={t("trajectoriesview.Entries", {
        defaultValue: "Entries",
      })}
      header={
        <SidebarHeader
          search={{
            value: searchQuery,
            onChange: (event) => {
              setSearchQuery(event.target.value);
              setPage(0);
            },
            onClear: () => {
              setSearchQuery("");
              setPage(0);
            },
            placeholder: t("trajectoriesview.Search"),
            "aria-label": t("trajectoriesview.Search"),
            ...searchAgent.agentProps,
          }}
        />
      }
    >
      <SidebarScrollRegion>
        <SidebarPanel>
          <SidebarContent.Toolbar className="mb-3 items-center justify-between gap-2">
            <SidebarContent.SectionLabel>
              {t("trajectoriesview.Entries", {
                defaultValue: "Entries",
              })}
            </SidebarContent.SectionLabel>
            <SidebarContent.ToolbarActions>
              <Button
                ref={refreshAgent.ref}
                variant="outline"
                size="icon"
                type="button"
                className="h-7 w-7 rounded-full"
                onClick={() => void loadTrajectories()}
                disabled={loading}
                title={t("common.refresh")}
                {...refreshAgent.agentProps}
              >
                <RefreshCw
                  className={`h-3 w-3${loading ? " animate-spin" : ""}`}
                />
              </Button>
              <DropdownMenu
                open={exportMenuOpen}
                onOpenChange={setExportMenuOpen}
              >
                <TrajectoriesExportTrigger
                  disabled={exporting || trajectories.length === 0}
                  label={t("common.export")}
                  onOpen={() => setExportMenuOpen(true)}
                />
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
              <TrajectoriesDeleteControl
                id="action-delete-current"
                label={t("trajectoriesview.DeleteCurrent", {
                  defaultValue: "Delete current",
                })}
                description="Delete the currently selected trajectory"
                onActivate={() => {
                  if (detailTrajectoryId) {
                    void handleDeleteTrajectory(detailTrajectoryId);
                  }
                }}
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
              <TrajectoriesDeleteControl
                id="action-clear-all"
                label={t("trajectoriesview.ClearAll", {
                  defaultValue: "Clear all",
                })}
                description="Delete all trajectories"
                onActivate={() => {
                  void handleClearAllTrajectories();
                }}
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
                const sourceColor =
                  SOURCE_COLORS[trajectory.source] ?? SOURCE_COLORS.api;

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
                    sourceColor={sourceColor.fg}
                    statusLabel={trajectory.status}
                    statusColor={statusColor.fg}
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
                  ref={prevPageAgent.ref}
                  variant="outline"
                  size="sm"
                  type="button"
                  className="h-8 rounded-full px-3 text-xs-tight"
                  onClick={() => setPage((current) => Math.max(0, current - 1))}
                  disabled={page === 0}
                  {...prevPageAgent.agentProps}
                >
                  {t("common.prev")}
                </Button>
                <Button
                  ref={nextPageAgent.ref}
                  variant="outline"
                  size="sm"
                  type="button"
                  className="h-8 rounded-full px-3 text-xs-tight"
                  onClick={() => setPage((current) => current + 1)}
                  disabled={page >= totalPages - 1}
                  {...nextPageAgent.agentProps}
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
        {error ? (
          <PagePanel.Notice tone="danger" className="mb-4">
            {error}
          </PagePanel.Notice>
        ) : null}

        {loading && trajectories.length === 0 ? (
          <PagePanel.Loading
            variant="surface"
            heading={t("trajectoriesview.LoadingTrajectories")}
          />
        ) : !loading && trajectories.length === 0 ? (
          <PagePanel.FeatureEmpty
            className="rounded-sm"
            features={TRAJECTORY_EMPTY_FEATURES}
            icon={Route}
            title={
              hasActiveFilters
                ? t("trajectoriesview.NoTrajectoriesMatchingFilters")
                : t("trajectoriesview.NoTrajectoriesYet")
            }
          />
        ) : detailTrajectoryId ? (
          <TrajectoryDetailView trajectoryId={detailTrajectoryId} />
        ) : null}
      </PageLayout>
    </ShellViewAgentSurface>
  );
}
