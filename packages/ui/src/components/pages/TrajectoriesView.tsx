/**
 * Recorded agent activity in a responsive list/detail workspace. The list is
 * the phone's primary screen and becomes a persistent rail on wider surfaces.
 * Read capabilities are independent from management capabilities because
 * shared runtimes may expose trajectory history without export/delete routes.
 */
import { AlertTriangle, Download, Route, Trash2, XCircle } from "lucide-react";
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
import {
  isCapabilityWarmupAbort,
  isCapabilityWarmupMiss,
  useAbortableCapabilityWarmup,
} from "../../hooks/runtime-capability-retry";
import { useActiveAgentAuthority } from "../../hooks/useActiveAgentAuthority";
import { useIntervalWhenDocumentVisible } from "../../hooks/useDocumentVisibility";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import {
  FramedPage,
  FramedPageBody,
  FramedPageHeader,
} from "../../layouts/framed-page";
import { cn } from "../../lib/utils";
import { useAppSelector } from "../../state";
import { useRegisterViewChatBinding } from "../../state/view-chat-binding";
import {
  formatTrajectoryDuration,
  formatTrajectoryTimestamp,
  formatTrajectoryTokenCount,
} from "../../utils/trajectory-format";
import { PagePanel } from "../composites/page-panel";
import { TrajectorySidebarItem } from "../composites/trajectories/trajectory-sidebar-item";
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

const MOBILE_WORKSPACE_QUERY = "(max-width: 799px), (max-height: 599px)";
const PAGE_SIZE = 50;

type TrajectoryLoadIssue =
  | "dedicated-required"
  | "unavailable"
  | "restricted"
  | "offline"
  | "error";
type ManagementCapability = "checking" | "available" | "unavailable";

const TRAJECTORIES_RUNTIME_UNAVAILABLE_CODE =
  "trajectories_runtime_unavailable";

function isTrajectoriesRuntimeUnavailable(error: unknown): boolean {
  return (
    (error as { code?: unknown } | null)?.code ===
    TRAJECTORIES_RUNTIME_UNAVAILABLE_CODE
  );
}

/** Classify transport failures without leaking server text into the UI. */
export function classifyTrajectoryLoadError(
  error: unknown,
): TrajectoryLoadIssue {
  const candidate = error as {
    code?: unknown;
    kind?: unknown;
    status?: unknown;
  } | null;
  const status = typeof candidate?.status === "number" ? candidate.status : 0;
  const kind = typeof candidate?.kind === "string" ? candidate.kind : "";

  if (isTrajectoriesRuntimeUnavailable(error)) return "dedicated-required";
  if (status === 404 || status === 405) return "unavailable";
  if (status === 401 || status === 403) return "restricted";
  if (
    kind === "network" ||
    kind === "timeout" ||
    status === 202 ||
    status === 408 ||
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504
  ) {
    return "offline";
  }
  return "error";
}

function isMissingManagementCapability(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return (
    isTrajectoriesRuntimeUnavailable(error) || status === 404 || status === 405
  );
}

export function shouldRetryTrajectoryLoad(error: unknown): boolean {
  return (
    !isTrajectoriesRuntimeUnavailable(error) &&
    (isCapabilityWarmupMiss(error) ||
      (error as { status?: unknown } | null)?.status === 503)
  );
}

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

function formatTrajectorySourceLabel(trajectory: TrajectoryRecord): string {
  const parts = [trajectory.source];
  if (trajectory.scenarioId) parts.push(trajectory.scenarioId);
  if (trajectory.batchId) parts.push(trajectory.batchId);
  return parts.join(" / ");
}

function AgentTrajectorySidebarItem({
  trajectory,
  selected,
  onSelect,
}: {
  trajectory: TrajectoryRecord;
  selected: boolean;
  onSelect: () => void;
}) {
  const title = formatTrajectoryTimestamp(trajectory.createdAt, "smart");
  useAgentElement({
    id: `trajectory-${agentSafeId(trajectory.id)}`,
    role: "list-item",
    label: `Open trajectory ${title}`,
    group: "trajectories-list",
    status: selected ? "active" : trajectory.status,
    description: "Open this recorded agent run",
    onActivate: onSelect,
  });

  return (
    <TrajectorySidebarItem
      active={selected}
      onSelect={onSelect}
      callCount={trajectory.llmCallCount}
      title={title}
      sourceLabel={formatTrajectorySourceLabel(trajectory)}
      statusLabel={trajectory.status}
      statusColor={
        trajectory.status === "error"
          ? "var(--danger)"
          : trajectory.status === "active"
            ? "var(--info)"
            : "var(--settings-muted)"
      }
      tokenLabel={`${formatTrajectoryTokenCount(
        trajectory.totalPromptTokens + trajectory.totalCompletionTokens,
        { emptyLabel: "0" },
      )} tokens`}
      durationLabel={formatTrajectoryDuration(trajectory.durationMs)}
    />
  );
}

function issueCopy(issue: TrajectoryLoadIssue, hasSavedData: boolean) {
  if (hasSavedData) {
    if (issue === "dedicated-required") {
      return {
        title: "Showing saved activity",
        description:
          "A Dedicated agent is required for live trajectory history.",
      };
    }
    return issue === "unavailable"
      ? {
          title: "Showing saved activity",
          description: "Live trajectory history isn't available here.",
        }
      : {
          title: "Showing saved activity",
          description: "Live updates will resume when the agent reconnects.",
        };
  }

  switch (issue) {
    case "dedicated-required":
      return {
        title: "Trajectories need a Dedicated agent",
        description:
          "Switch this agent to Dedicated to record and manage trajectory history.",
      };
    case "unavailable":
      return {
        title: "Trajectory history unavailable",
        description: "This agent doesn't provide recorded trajectory history.",
      };
    case "restricted":
      return {
        title: "Trajectory history restricted",
        description: "This account can't access recorded trajectory history.",
      };
    case "offline":
      return {
        title: "Agent unavailable",
        description:
          "Trajectory history will appear when the agent reconnects.",
      };
    default:
      return {
        title: "Couldn't load activity",
        description: "Try again in a moment.",
      };
  }
}

export interface TrajectoriesViewProps {
  contentHeader?: ReactNode;
  selectedTrajectoryId?: string | null;
  onSelectTrajectory?: (id: string | null) => void;
}

export function TrajectoriesView(props: TrajectoriesViewProps) {
  const authority = useActiveAgentAuthority();
  return (
    <TrajectoriesViewForAuthority
      key={authority}
      {...props}
      authority={authority}
    />
  );
}

function TrajectoriesViewForAuthority({
  contentHeader,
  selectedTrajectoryId: controlledId,
  onSelectTrajectory: controlledOnSelect,
  authority,
}: TrajectoriesViewProps & { authority: string }) {
  const t = useAppSelector((s) => s.t);
  const setActionNotice = useAppSelector((s) => s.setActionNotice);
  const isMobileWorkspace = useMediaQuery(MOBILE_WORKSPACE_QUERY);
  const authorityRef = useRef(authority);
  authorityRef.current = authority;
  const runCapabilityWarmup = useAbortableCapabilityWarmup();
  const [loadIssue, setLoadIssue] = useState<TrajectoryLoadIssue | null>(null);
  const [managementCapability, setManagementCapability] =
    useState<ManagementCapability>("checking");

  const [internalId, setInternalId] = useState<string | null>(null);
  const selectedTrajectoryId = controlledOnSelect
    ? (controlledId ?? null)
    : internalId;
  const onSelectTrajectory = controlledOnSelect ?? setInternalId;

  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(0);
  const previousSearchQueryRef = useRef(searchQuery);
  const searchPlaceholder = t("trajectoriesview.Search", {
    defaultValue: "Search activity",
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

  const cacheKey = `trajectories:${authority}:${page}:${searchQuery}`;
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
      setLoadIssue(null);

      try {
        const trajectoryResult = await runCapabilityWarmup(
          () =>
            client.getTrajectories({
              limit: PAGE_SIZE,
              offset: page * PAGE_SIZE,
              search: searchQuery || undefined,
            }),
          {
            retryWhen: shouldRetryTrajectoryLoad,
          },
        );
        if (authorityRef.current !== authority) return;
        setResult(trajectoryResult);
        setCached(cacheKey, trajectoryResult);
        setLoading(false);
      } catch (error) {
        if (authorityRef.current !== authority) return;
        if (isCapabilityWarmupAbort(error)) return;
        const issue = classifyTrajectoryLoadError(error);
        setLoadIssue(issue);
        setLoading(false);
      }
    },
    [authority, cacheKey, page, runCapabilityWarmup, searchQuery],
  );

  useEffect(() => {
    setResult(getCached<TrajectoryListResult>(cacheKey)?.data ?? null);
    setLoadIssue(null);
    setManagementCapability("checking");
  }, [cacheKey]);

  useEffect(() => {
    void loadTrajectories({
      silent: getCached<TrajectoryListResult>(cacheKey) != null,
    });
  }, [loadTrajectories, cacheKey]);

  useEffect(() => {
    let cancelled = false;
    const requestedAuthority = authority;
    void runCapabilityWarmup(() => client.getTrajectoryConfig())
      .then(() => {
        if (!cancelled && authorityRef.current === requestedAuthority) {
          setManagementCapability("available");
        }
      })
      .catch((error: unknown) => {
        if (isCapabilityWarmupAbort(error)) return;
        if (!cancelled && authorityRef.current === requestedAuthority) {
          setManagementCapability(
            isMissingManagementCapability(error) ? "unavailable" : "checking",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [authority, runCapabilityWarmup]);

  useIntervalWhenDocumentVisible(() => {
    void loadTrajectories({ silent: true });
  }, 15000);

  useEffect(() => {
    const previousSearchQuery = previousSearchQueryRef.current;
    if (previousSearchQuery === searchQuery) return;
    previousSearchQueryRef.current = searchQuery;
    if (selectedTrajectoryId != null) onSelectTrajectory(null);
  }, [searchQuery, selectedTrajectoryId, onSelectTrajectory]);

  const trajectories = useMemo(() => result?.trajectories ?? [], [result]);
  const total = result?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const hasActiveFilters = searchQuery.trim().length > 0;

  useLayoutEffect(() => {
    if (loading) return;
    if (trajectories.length === 0) {
      if (selectedTrajectoryId != null) onSelectTrajectory(null);
      return;
    }
    if (isMobileWorkspace) {
      if (
        selectedTrajectoryId != null &&
        !trajectories.some(
          (trajectory) => trajectory.id === selectedTrajectoryId,
        )
      ) {
        onSelectTrajectory(null);
      }
      return;
    }
    if (
      selectedTrajectoryId == null ||
      (page === 0 &&
        !trajectories.some(
          (trajectory) => trajectory.id === selectedTrajectoryId,
        ))
    ) {
      onSelectTrajectory(trajectories[0].id);
    }
  }, [
    isMobileWorkspace,
    loading,
    onSelectTrajectory,
    page,
    selectedTrajectoryId,
    trajectories,
  ]);

  const detailTrajectoryId =
    selectedTrajectoryId &&
    trajectories.some((trajectory) => trajectory.id === selectedTrajectoryId)
      ? selectedTrajectoryId
      : isMobileWorkspace
        ? null
        : (trajectories[0]?.id ?? null);

  const managementUnavailable = useCallback(() => {
    setManagementCapability("unavailable");
    setActionNotice?.(
      "Trajectory management isn't available for this agent.",
      "info",
      3600,
    );
  }, [setActionNotice]);

  const actionFailed = useCallback(
    (message: string) => {
      setActionNotice?.(message, "error", 4200);
    },
    [setActionNotice],
  );

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
    } catch (error) {
      if (isMissingManagementCapability(error)) managementUnavailable();
      else actionFailed("Couldn't export trajectories.");
    } finally {
      setExporting(false);
    }
  };

  const handleDeleteTrajectory = useCallback(
    async (trajectoryId: string) => {
      const normalizedId = trajectoryId.trim();
      if (!normalizedId) return;

      setDeletingTrajectoryId(normalizedId);
      try {
        const response = await client.deleteTrajectories([normalizedId]);
        const deletedCount = Number(response.deleted ?? 0);
        if (selectedTrajectoryId === normalizedId) {
          const remaining = trajectories.filter(
            (trajectory) => trajectory.id !== normalizedId,
          );
          onSelectTrajectory(remaining[0]?.id ?? null);
        }
        if (page > 0 && trajectories.length <= 1) {
          setPage((currentPage) => Math.max(0, currentPage - 1));
        } else {
          await loadTrajectories();
        }
        setActionNotice?.(
          deletedCount > 0 ? "Trajectory deleted." : "Nothing was deleted.",
          deletedCount > 0 ? "success" : "info",
          2400,
        );
      } catch (error) {
        if (isMissingManagementCapability(error)) managementUnavailable();
        else actionFailed("Couldn't delete this trajectory.");
      } finally {
        setDeletingTrajectoryId((currentId) =>
          currentId === normalizedId ? null : currentId,
        );
      }
    },
    [
      actionFailed,
      loadTrajectories,
      managementUnavailable,
      onSelectTrajectory,
      page,
      selectedTrajectoryId,
      setActionNotice,
      trajectories,
    ],
  );

  const handleClearAllTrajectories = useCallback(async () => {
    setClearingAll(true);
    try {
      const response = await client.clearAllTrajectories();
      setResult({
        trajectories: [],
        total: 0,
        offset: 0,
        limit: PAGE_SIZE,
      });
      setPage(0);
      onSelectTrajectory(null);
      const deletedCount = Number(response.deleted ?? 0);
      setActionNotice?.(
        deletedCount > 0
          ? "Trajectory history cleared."
          : "Nothing was deleted.",
        deletedCount > 0 ? "success" : "info",
        2400,
      );
    } catch (error) {
      if (isMissingManagementCapability(error)) managementUnavailable();
      else actionFailed("Couldn't clear trajectory history.");
    } finally {
      setClearingAll(false);
    }
  }, [
    actionFailed,
    managementUnavailable,
    onSelectTrajectory,
    setActionNotice,
  ]);

  const clearAllDisabled =
    loading || clearingAll || deletingTrajectoryId !== null || total === 0;
  const issue = loadIssue
    ? issueCopy(loadIssue, trajectories.length > 0)
    : null;
  const canRetryIssue =
    loadIssue !== "dedicated-required" &&
    loadIssue !== "unavailable" &&
    loadIssue !== "restricted";
  const showList = !isMobileWorkspace || detailTrajectoryId === null;
  const showDetail = !isMobileWorkspace || detailTrajectoryId !== null;
  const showingMobileDetail = isMobileWorkspace && detailTrajectoryId !== null;

  const managementActions =
    managementCapability === "available" && trajectories.length > 0 ? (
      <div className="flex items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <AgentToolbarButton
              agentId="trajectories-export-open"
              agentLabel="Open trajectory export menu"
              agentDescription="Export recorded trajectory logs"
              agentStatus={exporting ? "disabled" : "ready"}
              variant="ghostMuted"
              size="icon-lg"
              type="button"
              disabled={exporting}
              title={t("common.export")}
            >
              <Download className="size-4" aria-hidden />
            </AgentToolbarButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
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
              onClick={() => handleExport("jsonl", true, "eliza_native_v1")}
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
        {detailTrajectoryId ? (
          <ConfirmDeleteControl
            agentId="trajectories-delete-current-open"
            agentLabel="Delete current trajectory"
            agentGroup="trajectories-toolbar"
            agentDescription="Delete the selected trajectory"
            confirmAgentId="trajectories-delete-current-confirm"
            cancelAgentId="trajectories-delete-current-cancel"
            triggerVariant="ghost"
            triggerClassName="h-11 w-11 text-danger hover:bg-danger/10 hover:text-danger"
            confirmClassName="h-11 border border-danger/25 bg-danger/10 px-4 text-sm font-semibold text-danger hover:bg-danger/15"
            cancelClassName="h-11 border border-[color:var(--settings-hairline)] bg-[var(--settings-panel)] px-4 text-sm font-semibold text-[color:var(--settings-muted)] hover:bg-[var(--settings-fill)]"
            disabled={loading || clearingAll || deletingTrajectoryId !== null}
            triggerLabel={<Trash2 className="size-4" />}
            triggerTitle="Delete current"
            promptText="Delete this trajectory?"
            busyLabel="Deleting..."
            onConfirm={() => void handleDeleteTrajectory(detailTrajectoryId)}
          />
        ) : null}
        <ConfirmDeleteControl
          agentId="trajectories-clear-all-open"
          agentLabel="Clear all trajectories"
          agentGroup="trajectories-toolbar"
          agentDescription="Delete every recorded trajectory"
          confirmAgentId="trajectories-clear-all-confirm"
          cancelAgentId="trajectories-clear-all-cancel"
          triggerVariant="ghost"
          triggerClassName="h-11 w-11 text-danger hover:bg-danger/10 hover:text-danger"
          confirmClassName="h-11 border border-danger/25 bg-danger/10 px-4 text-sm font-semibold text-danger hover:bg-danger/15"
          cancelClassName="h-11 border border-[color:var(--settings-hairline)] bg-[var(--settings-panel)] px-4 text-sm font-semibold text-[color:var(--settings-muted)] hover:bg-[var(--settings-fill)]"
          disabled={clearAllDisabled}
          triggerLabel={<XCircle className="size-4" />}
          triggerTitle="Clear all"
          promptText="Delete all trajectories?"
          busyLabel="Clearing..."
          onConfirm={() => void handleClearAllTrajectories()}
        />
      </div>
    ) : null;

  return (
    <ShellViewAgentSurface viewId="trajectories">
      <FramedPage
        gutterOwner="framed-page"
        className="settings-surface"
        data-testid="trajectories-view"
      >
        <FramedPageHeader
          title={
            showingMobileDetail
              ? t("trajectorydetailview.Title", {
                  defaultValue: "Run details",
                })
              : t("trajectoriesview.Title", {
                  defaultValue: "Trajectories",
                })
          }
          onBack={
            showingMobileDetail ? () => onSelectTrajectory(null) : undefined
          }
          backLabel={
            showingMobileDetail
              ? t("trajectorydetailview.BackToActivity", {
                  defaultValue: "Back to activity",
                })
              : undefined
          }
          actions={contentHeader}
          className="text-[color:var(--settings-foreground)]"
        />
        <FramedPageBody scroll="view" className="pt-2">
          {trajectories.length === 0 ? (
            <div className="flex min-h-0 flex-1 flex-col">
              {loading ? (
                <div
                  role="status"
                  aria-label="Loading trajectory history"
                  aria-busy="true"
                  className="py-3"
                >
                  <ListSkeleton rows={6} rowClassName="h-16" />
                </div>
              ) : issue ? (
                <PagePanel.ContentState
                  state="error"
                  placement="workspace"
                  tone="warning"
                  role="status"
                  className="flex-1"
                  icon={<AlertTriangle className="size-5" />}
                  title={issue.title}
                  description={issue.description}
                  action={
                    canRetryIssue ? (
                      <Button
                        type="button"
                        size="touch"
                        variant="outline"
                        onClick={() => void loadTrajectories()}
                      >
                        Retry
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <PagePanel.ContentState
                  state="empty"
                  placement="workspace"
                  className="flex-1"
                  icon={<Route className="size-5" />}
                  title={
                    hasActiveFilters
                      ? "No matching activity"
                      : "No recorded activity yet"
                  }
                  description={
                    hasActiveFilters
                      ? "Try a shorter search."
                      : "Agent runs will appear here when trajectory recording is enabled."
                  }
                />
              )}
            </div>
          ) : (
            <div className="grid min-h-0 flex-1 [@media(min-width:800px)_and_(min-height:600px)]:grid-cols-[19rem_minmax(0,1fr)]">
              <aside
                className={cn(
                  "min-h-0 flex-col [@media(min-width:800px)_and_(min-height:600px)]:border-r [@media(min-width:800px)_and_(min-height:600px)]:border-[color:var(--settings-hairline)] [@media(min-width:800px)_and_(min-height:600px)]:pr-4",
                  showList ? "flex" : "hidden",
                )}
                aria-label="Trajectory history"
              >
                <div className="flex min-h-11 shrink-0 items-center justify-between gap-3 px-4">
                  <div className="min-w-0">
                    <h2 className="text-[15px] font-semibold text-[color:var(--settings-foreground)]">
                      Activity
                    </h2>
                    <p className="text-xs leading-5 text-[color:var(--settings-muted)]">
                      {hasActiveFilters
                        ? `${total} matching ${total === 1 ? "run" : "runs"}`
                        : `${total} recorded ${total === 1 ? "run" : "runs"}`}
                    </p>
                  </div>
                  {managementActions}
                </div>

                {issue && trajectories.length > 0 ? (
                  <div
                    role="status"
                    className="mt-2 flex items-start gap-2 rounded-[12px] bg-[var(--settings-fill)] px-3 py-2.5 text-[13px] leading-5 text-[color:var(--settings-muted)]"
                  >
                    <AlertTriangle
                      className="mt-0.5 size-4 shrink-0"
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-[color:var(--settings-foreground)]">
                        {issue.title}
                      </div>
                      <div>{issue.description}</div>
                    </div>
                    {canRetryIssue ? (
                      <Button
                        type="button"
                        size="touch"
                        variant="ghostMuted"
                        className="shrink-0"
                        onClick={() => void loadTrajectories()}
                      >
                        Retry
                      </Button>
                    ) : null}
                  </div>
                ) : null}

                <div className="eliza-chat-scroll min-h-0 flex-1 overflow-y-auto pb-4 pt-3">
                  <div className="divide-y divide-[color:var(--settings-hairline)] border-y border-[color:var(--settings-hairline)]">
                    {trajectories.map((trajectory) => (
                      <AgentTrajectorySidebarItem
                        key={trajectory.id}
                        trajectory={trajectory}
                        selected={selectedTrajectoryId === trajectory.id}
                        onSelect={() => onSelectTrajectory(trajectory.id)}
                      />
                    ))}
                  </div>

                  {totalPages > 1 ? (
                    <nav
                      className="mt-3 flex min-h-11 items-center justify-between gap-2 px-1 text-xs text-[color:var(--settings-muted)]"
                      aria-label="Trajectory pages"
                    >
                      <span>
                        {page * PAGE_SIZE + 1}-
                        {Math.min((page + 1) * PAGE_SIZE, total)} of {total}
                      </span>
                      <div className="flex gap-1">
                        <AgentToolbarButton
                          agentId="trajectories-page-prev"
                          agentLabel="Previous trajectories page"
                          agentStatus={page === 0 ? "disabled" : "ready"}
                          onActivate={() =>
                            setPage((current) => Math.max(0, current - 1))
                          }
                          variant="ghostMuted"
                          size="touch"
                          className="px-3"
                          onClick={() =>
                            setPage((current) => Math.max(0, current - 1))
                          }
                          disabled={page === 0}
                        >
                          Previous
                        </AgentToolbarButton>
                        <AgentToolbarButton
                          agentId="trajectories-page-next"
                          agentLabel="Next trajectories page"
                          agentStatus={
                            page >= totalPages - 1 ? "disabled" : "ready"
                          }
                          onActivate={() => setPage((current) => current + 1)}
                          variant="ghostMuted"
                          size="touch"
                          className="px-3"
                          onClick={() => setPage((current) => current + 1)}
                          disabled={page >= totalPages - 1}
                        >
                          Next
                        </AgentToolbarButton>
                      </div>
                    </nav>
                  ) : null}
                </div>
              </aside>

              <main
                className={cn(
                  "eliza-chat-scroll min-h-0 overflow-y-auto pb-4 [@media(min-width:800px)_and_(min-height:600px)]:pl-4",
                  showDetail ? "block" : "hidden",
                )}
              >
                {detailTrajectoryId ? (
                  <TrajectoryDetailView trajectoryId={detailTrajectoryId} />
                ) : (
                  <PagePanel.ContentState
                    state="empty"
                    placement="workspace"
                    className="min-h-[24rem]"
                    title="Select a run"
                    description="Choose recorded activity to inspect its timeline and model calls."
                  />
                )}
              </main>
            </div>
          )}
        </FramedPageBody>
      </FramedPage>
    </ShellViewAgentSurface>
  );
}
