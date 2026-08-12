/**
 * Lists hosted agent sandboxes with lifecycle and billing actions on the
 * Instances page. The parent React Query result is the sole server-data
 * authority; this table keeps only short-lived action and notification state.
 */
"use client";

import type {
  AgentExecutionTier,
  AgentHostingCostDto,
  AgentSandboxStatus,
} from "@elizaos/cloud-shared/lib/types/cloud-api";
import {
  Badge,
  BulkDeleteDialog,
  BulkSelectionBar,
  DashboardDataList,
  DashboardDataListDesktop,
  DashboardDataListFilteredCount,
  DashboardDataListMobile,
  DataListEmptyState,
  Input,
  runBulkDelete,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@elizaos/ui/cloud-ui";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpDown,
  Boxes,
  Cloud,
  ExternalLink,
  FileText,
  Loader2,
  Moon,
  Pause,
  Play,
  Search,
  Server,
  Sun,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { currentElizaAppOrigin } from "../../../utils/cloud-agent-base";
import { api, apiWithStatus } from "../../lib/api-client";
import { AGENTS_QUERY_KEY } from "../lib/data/eliza-agents";
import { useT } from "../lib/i18n";
import { openWebUIWithPairing } from "../lib/open-web-ui";
import {
  agentStatusPresentation,
  formatRelative,
  statusBadgeColor,
  statusDotColor,
} from "../lib/sandbox-status";
import { type TrackedJob, useJobPoller } from "../lib/use-job-poller";
import { AgentCostBadge } from "./agent-cost-badge";
import { DeactivateAgentDialog } from "./deactivate-agent-dialog";

/**
 * Envelope the agent provision/suspend job endpoints return. 202 and 409
 * responses carry a `jobId` to hand to the job poller; error responses carry
 * a human-readable `error`.
 */
interface AgentJobEnvelope {
  data?: { jobId?: string };
  error?: string;
}

export interface ElizaAgentRow {
  id: string;
  agent_name: string | null;
  status: AgentSandboxStatus;
  canonical_web_ui_url: string | null;
  node_id: string | null;
  container_name: string | null;
  bridge_port: number | null;
  web_ui_port: number | null;
  headscale_ip: string | null;
  docker_image: string | null;
  execution_tier: AgentExecutionTier;
  hosting_cost: AgentHostingCostDto;
  sandbox_id: string | null;
  bridge_url: string | null;
  error_message: string | null;
  last_heartbeat_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

// Derive the create-agent / "Open Eliza app" target from the CURRENT console
// host so a signed-in staging user isn't bounced to the PROD app (different
// tenant/session) — #15161. Resolved once at module load: the console host is
// stable for the lifetime of the page.
const ELIZA_APP_AGENT_CREATE_URL = currentElizaAppOrigin();

function isDockerBacked(sb: ElizaAgentRow): boolean {
  return !!sb.node_id || sb.execution_tier === "custom" || !!sb.docker_image;
}

function getRuntimeKind(
  sb: ElizaAgentRow,
): "managed" | "shared" | "sandbox" | "notProvisioned" {
  if (isDockerBacked(sb)) return "managed";
  if (sb.execution_tier === "shared") return "shared";
  if (
    sb.sandbox_id ||
    sb.status === "running" ||
    sb.status === "provisioning" ||
    // A deactivated (sleeping) agent released its container but is still an
    // established sandbox with a restorable backup — "Not provisioned" would
    // misread as never-set-up.
    sb.status === "sleeping"
  ) {
    return "sandbox";
  }
  return "notProvisioned";
}

/**
 * Everything a single agent row needs to render, derived once from the raw row
 * plus the live poll/action state. The desktop table and the mobile card are
 * two views of the same row and must agree on status, action-availability, and
 * web-UI reachability; deriving here (rather than inline in each renderer) keeps
 * them from drifting and computes `runtimeKind` a single time.
 */
interface AgentRowViewModel {
  sb: ElizaAgentRow;
  isDocker: boolean;
  trackedJob: TrackedJob | undefined;
  isProvisioningActive: boolean;
  displayStatus: AgentSandboxStatus;
  statusPresentation: ReturnType<typeof agentStatusPresentation>;
  busy: boolean;
  canStart: boolean;
  canStop: boolean;
  /** Deactivate (sleep): only a running dedicated agent has compute to free —
   * shared-runtime rows have no container, so the endpoint would no-op. */
  canSleep: boolean;
  /** Reactivate (wake): offered exactly for the sleeping (deactivated) state. */
  canWake: boolean;
  hasStandaloneWebUi: boolean;
  runtimeKind: ReturnType<typeof getRuntimeKind>;
}

export function deriveAgentRow(
  sb: ElizaAgentRow,
  poller: Pick<ReturnType<typeof useJobPoller>, "getStatus" | "isActive">,
  actionInProgress: string | null,
): AgentRowViewModel {
  const isProvisioningActive = poller.isActive(sb.id);
  const displayStatus = isProvisioningActive ? "provisioning" : sb.status;
  const busy = actionInProgress === sb.id || isProvisioningActive;
  return {
    sb,
    isDocker: isDockerBacked(sb),
    trackedJob: poller.getStatus(sb.id),
    isProvisioningActive,
    displayStatus,
    statusPresentation: agentStatusPresentation(
      sb.execution_tier,
      displayStatus,
    ),
    busy,
    canStart:
      ["stopped", "error", "pending", "disconnected"].includes(displayStatus) &&
      !busy,
    canStop: displayStatus === "running" && !busy,
    canSleep:
      displayStatus === "running" && sb.execution_tier !== "shared" && !busy,
    canWake: displayStatus === "sleeping" && !busy,
    hasStandaloneWebUi:
      displayStatus === "running" &&
      sb.execution_tier !== "shared" &&
      Boolean(sb.canonical_web_ui_url),
    runtimeKind: getRuntimeKind(sb),
  };
}

/** The runtime label for one row, driven by a single precomputed `runtimeKind`
 * so the four kinds map to copy in one place rather than four `getRuntimeKind`
 * calls at the call site. */
function RuntimeLabel({
  runtimeKind,
}: {
  runtimeKind: AgentRowViewModel["runtimeKind"];
}) {
  const t = useT();
  const label =
    runtimeKind === "managed"
      ? t("cloud.elizaAgentsTable.managedRuntime", {
          defaultValue: "Managed runtime",
        })
      : runtimeKind === "shared"
        ? t("cloud.elizaAgentsTable.sharedRuntime", {
            defaultValue: "Shared runtime",
          })
        : runtimeKind === "sandbox"
          ? t("cloud.elizaAgentsTable.cloudSandbox", {
              defaultValue: "Cloud sandbox",
            })
          : t("cloud.elizaAgentsTable.notProvisioned", {
              defaultValue: "Not provisioned",
            });
  return <span className="text-xs text-muted-strong">{label}</span>;
}

/** Backing label (Docker / Shared / Sandbox) + short id, shared by the desktop
 * row and the mobile card. */
function RowBackingMeta({ vm }: { vm: AgentRowViewModel }) {
  const t = useT();
  const { sb, isDocker } = vm;
  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex items-center gap-1 text-2xs text-muted">
        {isDocker ? (
          <Server className="h-2.5 w-2.5" />
        ) : (
          <Cloud className="h-2.5 w-2.5" />
        )}
        {isDocker
          ? t("cloud.elizaAgentsTable.docker", { defaultValue: "Docker" })
          : sb.execution_tier === "shared"
            ? t("cloud.elizaAgentsTable.shared", { defaultValue: "Shared" })
            : t("cloud.elizaAgentsTable.sandbox", { defaultValue: "Sandbox" })}
      </span>
      <span className="text-2xs text-muted font-mono tabular-nums">
        {sb.id.slice(0, 8)}
      </span>
    </div>
  );
}

function StatusCell({
  presentation,
  isProvisioning,
  trackedJob,
  errorMessage,
}: {
  presentation: ReturnType<typeof agentStatusPresentation>;
  isProvisioning: boolean;
  trackedJob?: { jobId: string } | null;
  errorMessage: string | null;
}) {
  const t = useT();
  const { label, visualStatus } = presentation;
  const [prevStatus, setPrevStatus] = useState(visualStatus);
  const [animate, setAnimate] = useState<"success" | "error" | null>(null);

  useEffect(() => {
    if (prevStatus !== visualStatus) {
      if (
        visualStatus === "running" &&
        (prevStatus === "provisioning" || prevStatus === "pending")
      ) {
        setAnimate("success");
        const id = setTimeout(() => setAnimate(null), 1500);
        setPrevStatus(visualStatus);
        return () => clearTimeout(id);
      }
      if (visualStatus === "error") {
        setAnimate("error");
        const id = setTimeout(() => setAnimate(null), 600);
        setPrevStatus(visualStatus);
        return () => clearTimeout(id);
      }
      setPrevStatus(visualStatus);
    }
  }, [prevStatus, visualStatus]);

  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={`transition-transform ${
          animate === "success"
            ? "animate-[scaleIn_0.3s_ease-out]"
            : animate === "error"
              ? "animate-[shake_0.3s_ease-in-out]"
              : ""
        }`}
      >
        <Badge
          variant="outline"
          className={`${statusBadgeColor(visualStatus)} w-fit text-xs-tight font-medium px-2 py-0.5`}
        >
          <span
            className={`inline-block size-1.5 rounded-full mr-1.5 ${statusDotColor(visualStatus)}`}
          />
          {label}
        </Badge>
      </div>
      {isProvisioning && trackedJob && (
        <span className="text-2xs text-muted flex items-center gap-1 pl-0.5">
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
          {t("cloud.elizaAgentsTable.jobLabel", {
            jobId: trackedJob.jobId.slice(0, 8),
            defaultValue: "Job {{jobId}}",
          })}
        </span>
      )}
      {errorMessage && (
        <Tooltip>
          <TooltipTrigger asChild>
            <p className="text-xs-tight text-destructive/80 truncate max-w-[180px] cursor-help pl-0.5">
              {errorMessage}
            </p>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs bg-card border-border">
            <p>{errorMessage}</p>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

export function ElizaAgentsTable({
  sandboxes,
}: {
  sandboxes: ElizaAgentRow[];
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  // Deactivate (sleep) needs a billing-transparency confirm before the job is
  // enqueued; the row Moon button stages the id here and the dialog confirms.
  const [deactivateId, setDeactivateId] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );

  const previousStatusesRef = useRef(
    new Map(sandboxes.map((sandbox) => [sandbox.id, sandbox.status])),
  );

  // Transition notifications observe the canonical query result; they never
  // fetch or retain a second copy of list data.
  useEffect(() => {
    const nextStatuses = new Map<string, AgentSandboxStatus>();
    for (const sandbox of sandboxes) {
      const previousStatus = previousStatusesRef.current.get(sandbox.id);
      if (
        (previousStatus === "pending" || previousStatus === "provisioning") &&
        sandbox.status === "running"
      ) {
        toast.success(
          t("cloud.elizaAgentsTable.nowRunning", {
            name:
              sandbox.agent_name ??
              t("cloud.elizaAgentsTable.agent", { defaultValue: "Agent" }),
            defaultValue: "{{name}} is now running!",
          }),
        );
      }
      nextStatuses.set(sandbox.id, sandbox.status);
    }
    previousStatusesRef.current = nextStatuses;
  }, [sandboxes, t]);

  const jobActionById = useRef(new Map<string, string>());

  const poller = useJobPoller({
    autoRefresh: false,
    onComplete: (job) => {
      const action = jobActionById.current.get(job.jobId);
      jobActionById.current.delete(job.jobId);
      toast.success(
        t("cloud.elizaAgentsTable.jobCompleted", {
          action:
            action ??
            t("cloud.elizaAgentsTable.agentJob", {
              defaultValue: "Agent job",
            }),
          defaultValue: "{{action}} completed",
        }),
      );
      void queryClient.refetchQueries({ queryKey: AGENTS_QUERY_KEY });
    },
    onFailed: (job) => {
      const action = jobActionById.current.get(job.jobId);
      jobActionById.current.delete(job.jobId);
      toast.error(
        job.error ??
          t("cloud.elizaAgentsTable.jobFailed", {
            action:
              action ??
              t("cloud.elizaAgentsTable.agentJob", {
                defaultValue: "Agent job",
              }),
            defaultValue: "{{action}} failed",
          }),
      );
      void queryClient.refetchQueries({ queryKey: AGENTS_QUERY_KEY });
    },
  });

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortField, setSortField] = useState<"name" | "status" | "created">(
    "created",
  );
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const handleSort = (field: typeof sortField) => {
    setSortDir((prev) =>
      sortField === field && prev === "asc" ? "desc" : "asc",
    );
    setSortField(field);
  };

  const filtered = useMemo(() => {
    const list = sandboxes.filter((sb) => {
      const q = searchQuery.toLowerCase();
      const displayStatus = poller.isActive(sb.id) ? "provisioning" : sb.status;
      const matchSearch =
        !q ||
        (sb.agent_name ?? "").toLowerCase().includes(q) ||
        (sb.container_name ?? "").toLowerCase().includes(q) ||
        (sb.node_id ?? "").toLowerCase().includes(q) ||
        (sb.headscale_ip ?? "").toLowerCase().includes(q);
      const matchStatus =
        statusFilter === "all" || displayStatus === statusFilter;
      return matchSearch && matchStatus;
    });

    list.sort((a, b) => {
      let cmp = 0;
      const aStatus = poller.isActive(a.id) ? "provisioning" : a.status;
      const bStatus = poller.isActive(b.id) ? "provisioning" : b.status;
      if (sortField === "name") {
        cmp = (a.agent_name ?? "").localeCompare(b.agent_name ?? "");
      } else if (sortField === "status") {
        cmp = aStatus.localeCompare(bStatus);
      } else {
        cmp =
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [
    sandboxes,
    searchQuery,
    statusFilter,
    sortField,
    sortDir,
    poller.isActive,
  ]);

  /**
   * Shared skeleton of the async agent-job actions (provision/suspend): fire
   * the request, then branch on the job protocol. Canonical list refetches own
   * server status and pricing; the job poller alone owns in-flight display.
   */
  async function runAgentJob(
    id: string,
    opts: {
      request: () => Promise<{ status: number; data?: AgentJobEnvelope }>;
      labels: {
        jobAction: string;
        inProgress: string;
        failed: string;
        queued: string;
        /** Provision-only: 202 with no jobId means "started, nothing to track". */
        startedNoJob?: string;
        alreadyDone: string;
      };
      onError: (err: unknown) => void;
    },
  ) {
    const { request, labels, onError } = opts;
    setActionInProgress(id);
    try {
      const { status, data } = await request();
      const jobId = data?.data?.jobId;

      // 409 — the job is already in flight. Attach to it when the backend
      // returned one; either way this is informational, not an error.
      if (status === 409) {
        if (jobId) {
          jobActionById.current.set(jobId, labels.jobAction);
          poller.track(id, jobId);
        } else {
          void queryClient.refetchQueries({ queryKey: AGENTS_QUERY_KEY });
        }
        toast.info(labels.inProgress);
        return;
      }

      if (status < 200 || status >= 300) {
        throw new Error(data?.error ?? labels.failed);
      }

      // 202 — accepted: the backend queued a job to track.
      if (status === 202 && jobId) {
        jobActionById.current.set(jobId, labels.jobAction);
        poller.track(id, jobId);
        toast.success(labels.queued);
        return;
      }
      if (status === 202 && labels.startedNoJob) {
        toast.success(labels.startedNoJob);
        void queryClient.refetchQueries({ queryKey: AGENTS_QUERY_KEY });
        return;
      }

      toast.success(labels.alreadyDone);
      void queryClient.refetchQueries({ queryKey: AGENTS_QUERY_KEY });
    } catch (err) {
      // error-policy:J4 row actions translate request failures into a visible
      // toast, then the canonical query owns the resulting list error state.
      void queryClient.refetchQueries({ queryKey: AGENTS_QUERY_KEY });
      onError(err);
    } finally {
      setActionInProgress(null);
    }
  }

  function handleProvision(id: string) {
    return runAgentJob(id, {
      request: () =>
        apiWithStatus<AgentJobEnvelope>(
          `/api/v1/eliza/agents/${id}/provision`,
          {
            method: "POST",
          },
        ),
      labels: {
        jobAction: t("cloud.elizaAgentsTable.agentProvisioning", {
          defaultValue: "Agent provisioning",
        }),
        inProgress: t("cloud.elizaAgentsTable.provisioningInProgress", {
          defaultValue: "Provisioning already in progress",
        }),
        failed: t("cloud.elizaAgentsTable.provisionFailed", {
          defaultValue: "Provision failed",
        }),
        queued: t("cloud.elizaAgentsTable.provisioningQueued", {
          defaultValue: "Agent provisioning queued",
        }),
        startedNoJob: t("cloud.elizaAgentsTable.provisioningStarted", {
          defaultValue: "Agent provisioning started",
        }),
        alreadyDone: t("cloud.elizaAgentsTable.alreadyRunning", {
          defaultValue: "Agent is already running",
        }),
      },
      onError: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(
          t("cloud.elizaAgentsTable.failedToStart", {
            message,
            defaultValue: "Failed to start agent: {{message}}",
          }),
        );
      },
    });
  }

  function handleSuspend(id: string) {
    return runAgentJob(id, {
      request: () =>
        apiWithStatus<AgentJobEnvelope>(`/api/v1/eliza/agents/${id}`, {
          method: "PATCH",
          json: { action: "suspend" },
        }),
      labels: {
        jobAction: t("cloud.elizaAgentsTable.agentSuspend", {
          defaultValue: "Agent suspend",
        }),
        inProgress: t("cloud.elizaAgentsTable.suspendInProgress", {
          defaultValue: "Suspend already in progress",
        }),
        failed: t("cloud.elizaAgentsTable.suspendFailed", {
          defaultValue: "Suspend failed",
        }),
        queued: t("cloud.elizaAgentsTable.suspendQueued", {
          defaultValue: "Suspend queued",
        }),
        alreadyDone: t("cloud.elizaAgentsTable.suspended", {
          defaultValue: "Agent suspended (snapshot saved)",
        }),
      },
      onError: () => {
        toast.error(
          t("cloud.elizaAgentsTable.failedToSuspend", {
            defaultValue: "Failed to suspend agent",
          }),
        );
      },
    });
  }

  /** Deactivate = the `sleep` lifecycle action: durable encrypted backup, then
   * container + compute slot released, so hourly billing stops entirely. Fired
   * from the confirm dialog only — never directly from the row button. */
  function handleSleep(id: string) {
    return runAgentJob(id, {
      request: () =>
        apiWithStatus<AgentJobEnvelope>(`/api/v1/eliza/agents/${id}/sleep`, {
          method: "POST",
        }),
      labels: {
        jobAction: t("cloud.elizaAgentsTable.agentDeactivation", {
          defaultValue: "Agent deactivation",
        }),
        inProgress: t("cloud.elizaAgentsTable.deactivateInProgress", {
          defaultValue: "Agent provisioning is still in progress",
        }),
        failed: t("cloud.elizaAgentsTable.deactivateFailed", {
          defaultValue: "Deactivate failed",
        }),
        queued: t("cloud.elizaAgentsTable.deactivateQueued", {
          defaultValue: "Deactivation queued — saving an encrypted backup",
        }),
        alreadyDone: t("cloud.elizaAgentsTable.alreadyDeactivated", {
          defaultValue: "Agent is already deactivated",
        }),
      },
      onError: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(
          t("cloud.elizaAgentsTable.failedToDeactivate", {
            message,
            defaultValue: "Failed to deactivate agent: {{message}}",
          }),
        );
      },
    });
  }

  /** Reactivate = the `wake` lifecycle action: re-provisions compute and
   * restores the encrypted backup. Can take minutes — the tracked job keeps
   * the row in its in-progress state until the poll sees completion. */
  function handleWake(id: string) {
    return runAgentJob(id, {
      request: () =>
        apiWithStatus<AgentJobEnvelope>(`/api/v1/eliza/agents/${id}/wake`, {
          method: "POST",
        }),
      labels: {
        jobAction: t("cloud.elizaAgentsTable.agentReactivation", {
          defaultValue: "Agent reactivation",
        }),
        inProgress: t("cloud.elizaAgentsTable.reactivateInProgress", {
          defaultValue: "Reactivation already in progress",
        }),
        failed: t("cloud.elizaAgentsTable.reactivateFailed", {
          defaultValue: "Reactivate failed",
        }),
        queued: t("cloud.elizaAgentsTable.reactivateQueued", {
          defaultValue:
            "Reactivation queued — restoring from backup (this can take a few minutes)",
        }),
        alreadyDone: t("cloud.elizaAgentsTable.alreadyRunning", {
          defaultValue: "Agent is already running",
        }),
      },
      onError: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(
          t("cloud.elizaAgentsTable.failedToReactivate", {
            message,
            defaultValue: "Failed to reactivate agent: {{message}}",
          }),
        );
      },
    });
  }

  /**
   * Delete one or many agents, then refetch the canonical rows and summary.
   * The row remains visible until the server omits it so eventual consistency
   * cannot make a deleted agent look unbilled before that is authoritative.
   */
  async function handleDelete(ids: string[]) {
    setIsDeleting(true);
    try {
      const outcome = await runBulkDelete(ids, (id) =>
        api(`/api/v1/eliza/agents/${id}`, { method: "DELETE" }),
      );
      const failed = outcome.failed;
      if (failed.length > 0) {
        const firstError = outcome.firstError;
        toast.error(
          t("cloud.elizaAgentsTable.deleteSomeFailed", {
            count: failed.length,
            defaultValue: "Failed to delete {{count}} agent(s)",
          }),
          {
            description:
              firstError instanceof Error ? firstError.message : undefined,
          },
        );
      }
      const deleted = ids.length - failed.length;
      if (deleted > 0) {
        toast.success(
          deleted === 1
            ? t("cloud.elizaAgentsTable.agentDeleted", {
                defaultValue: "Agent deleted",
              })
            : t("cloud.elizaAgentsTable.agentsDeleted", {
                count: deleted,
                defaultValue: "{{count}} agents deleted",
              }),
        );
      }
      setSelectedIds(new Set());
      void queryClient.refetchQueries({ queryKey: AGENTS_QUERY_KEY });
    } finally {
      setIsDeleting(false);
      setDeleteIds(null);
    }
  }

  const deleteTargetBusy = (deleteIds ?? []).some((id) => poller.isActive(id));
  const deactivateTarget =
    deactivateId === null
      ? undefined
      : sandboxes.find((sandbox) => sandbox.id === deactivateId);

  if (sandboxes.length === 0) {
    // Agent creation lives in the Eliza app, not the console; this surface only
    // lists and manages existing agents.
    return (
      <DataListEmptyState
        title={t("cloud.elizaAgentsTable.noAgentsYet", {
          defaultValue: "No agents yet",
        })}
        description={t("cloud.elizaAgentsTable.noAgentsYetDesc", {
          defaultValue: "Create and manage agents from the Eliza app.",
        })}
        icon={Boxes}
        action={
          <Button asChild size="sm">
            <a
              href={ELIZA_APP_AGENT_CREATE_URL}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink className="h-4 w-4" />
              {t("cloud.elizaAgentsTable.openElizaApp", {
                defaultValue: "Open Eliza app",
              })}
            </a>
          </Button>
        }
      />
    );
  }

  const selectableIds = filtered
    .filter((sb) => !poller.isActive(sb.id))
    .map((sb) => sb.id);
  const allSelected =
    selectableIds.length > 0 &&
    selectableIds.every((id) => selectedIds.has(id));
  const toggleSelected = (id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  return (
    <TooltipProvider>
      <DashboardDataList>
        <BulkSelectionBar
          count={selectedIds.size}
          onClear={() => setSelectedIds(new Set())}
          onDelete={() =>
            setDeleteIds(
              [...selectedIds].filter((id) =>
                sandboxes.some((sb) => sb.id === id),
              ),
            )
          }
          deleteDisabled={isDeleting}
          labels={{
            selected: t("cloud.elizaAgentsTable.selectedCount", {
              count: selectedIds.size,
              defaultValue: "{{count}} selected",
            }),
            clear: t("cloud.elizaAgentsTable.clearSelection", {
              defaultValue: "Clear",
            }),
            deleteSelected: t("cloud.elizaAgentsTable.deleteSelected", {
              defaultValue: "Delete selected",
            }),
          }}
        />
        {/* Search and filter controls for the visible agent set. */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted" />
            <Input
              placeholder={t("cloud.elizaAgentsTable.searchAgents", {
                defaultValue: "Search agents…",
              })}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-9 border-border bg-card text-txt placeholder:text-muted"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-[150px] h-9 border-border bg-card text-sm">
              <SelectValue
                placeholder={t("cloud.elizaAgentsTable.allStatuses", {
                  defaultValue: "All statuses",
                })}
              />
            </SelectTrigger>
            <SelectContent className="border-border bg-card">
              <SelectItem value="all">
                {t("cloud.elizaAgentsTable.allStatuses", {
                  defaultValue: "All statuses",
                })}
              </SelectItem>
              <SelectItem value="running">
                {t("cloud.elizaAgentsTable.running", {
                  defaultValue: "Running",
                })}
              </SelectItem>
              <SelectItem value="provisioning">
                {t("cloud.elizaAgentsTable.provisioning", {
                  defaultValue: "Provisioning",
                })}
              </SelectItem>
              <SelectItem value="pending">
                {t("cloud.elizaAgentsTable.pending", {
                  defaultValue: "Pending",
                })}
              </SelectItem>
              <SelectItem value="stopped">
                {t("cloud.elizaAgentsTable.stopped", {
                  defaultValue: "Stopped",
                })}
              </SelectItem>
              <SelectItem value="sleeping">
                {t("cloud.elizaAgentsTable.deactivatedFilter", {
                  defaultValue: "Deactivated",
                })}
              </SelectItem>
              <SelectItem value="disconnected">
                {t("cloud.elizaAgentsTable.disconnected", {
                  defaultValue: "Disconnected",
                })}
              </SelectItem>
              <SelectItem value="error">
                {t("cloud.elizaAgentsTable.error", { defaultValue: "Error" })}
              </SelectItem>
            </SelectContent>
          </Select>
          <Button asChild size="sm" className="h-9">
            <a
              href={ELIZA_APP_AGENT_CREATE_URL}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink className="h-4 w-4" />
              {t("cloud.elizaAgentsTable.openElizaApp", {
                defaultValue: "Open Eliza app",
              })}
            </a>
          </Button>
        </div>

        {(searchQuery || statusFilter !== "all") && (
          <DashboardDataListFilteredCount
            filtered={filtered.length}
            total={sandboxes.length}
            label={t("cloud.elizaAgentsTable.agentsLabel", {
              defaultValue: "agents",
            })}
          />
        )}

        {/* Desktop table */}
        <DashboardDataListDesktop>
          <Table>
            <TableHeader>
              <TableRow className="bg-bg-muted border-b border-border hover:bg-bg-muted">
                <TableHead className="w-10">
                  <Checkbox
                    aria-label={t("cloud.elizaAgentsTable.selectAll", {
                      defaultValue: "Select all agents",
                    })}
                    checked={allSelected}
                    onCheckedChange={(checked) =>
                      setSelectedIds(
                        checked === true ? new Set(selectableIds) : new Set(),
                      )
                    }
                  />
                </TableHead>
                <TableHead className="w-[30%]">
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() => handleSort("name")}
                    className="flex items-center gap-1.5 text-xs-tight font-medium uppercase tracking-widest text-muted hover:text-txt transition-colors"
                  >
                    {t("cloud.elizaAgentsTable.colAgent", {
                      defaultValue: "Agent",
                    })}
                    <ArrowUpDown className="h-3 w-3" />
                  </Button>
                </TableHead>
                <TableHead>
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() => handleSort("status")}
                    className="flex items-center gap-1.5 text-xs-tight font-medium uppercase tracking-widest text-muted hover:text-txt transition-colors"
                  >
                    {t("cloud.elizaAgentsTable.colStatus", {
                      defaultValue: "Status",
                    })}
                    <ArrowUpDown className="h-3 w-3" />
                  </Button>
                </TableHead>
                <TableHead className="text-xs-tight font-medium uppercase tracking-widest text-muted">
                  {t("cloud.elizaAgentsTable.colRuntime", {
                    defaultValue: "Runtime",
                  })}
                </TableHead>
                <TableHead className="text-xs-tight font-medium uppercase tracking-widest text-muted">
                  {t("cloud.elizaAgentsTable.colWebUi", {
                    defaultValue: "Web UI",
                  })}
                </TableHead>
                <TableHead>
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() => handleSort("created")}
                    className="flex items-center gap-1.5 text-xs-tight font-medium uppercase tracking-widest text-muted hover:text-txt transition-colors"
                  >
                    {t("cloud.elizaAgentsTable.colCreated", {
                      defaultValue: "Created",
                    })}
                    <ArrowUpDown className="h-3 w-3" />
                  </Button>
                </TableHead>
                <TableHead className="text-right text-xs-tight font-medium uppercase tracking-widest text-muted">
                  {t("cloud.elizaAgentsTable.colActions", {
                    defaultValue: "Actions",
                  })}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center">
                    <div className="flex flex-col items-center justify-center gap-1 text-muted">
                      <Search className="h-5 w-5 mb-1" />
                      <p className="text-sm">
                        {t("cloud.elizaAgentsTable.noMatch", {
                          defaultValue: "No agents match your filters",
                        })}
                      </p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((sb) => {
                  const vm = deriveAgentRow(sb, poller, actionInProgress);
                  const {
                    trackedJob,
                    isProvisioningActive,
                    displayStatus,
                    busy,
                    canStart,
                    canStop,
                    hasStandaloneWebUi,
                  } = vm;

                  return (
                    <TableRow
                      key={sb.id}
                      className="hover:bg-bg-hover transition-colors border-b border-border"
                    >
                      <TableCell className="w-10">
                        <Checkbox
                          aria-label={t("cloud.elizaAgentsTable.selectAgent", {
                            defaultValue: "Select agent",
                          })}
                          checked={selectedIds.has(sb.id)}
                          disabled={isProvisioningActive}
                          onCheckedChange={(checked) =>
                            toggleSelected(sb.id, checked === true)
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <a
                              href={`/dashboard/agents/${sb.id}`}
                              className="font-medium text-txt-strong hover:opacity-75 transition-opacity"
                            >
                              {sb.agent_name ??
                                t("cloud.elizaAgentsTable.unnamedAgent", {
                                  defaultValue: "Unnamed Agent",
                                })}
                            </a>
                            <AgentCostBadge hostingCost={sb.hosting_cost} />
                          </div>
                          <RowBackingMeta vm={vm} />
                        </div>
                      </TableCell>

                      <TableCell>
                        <StatusCell
                          presentation={vm.statusPresentation}
                          isProvisioning={isProvisioningActive}
                          trackedJob={trackedJob}
                          errorMessage={sb.error_message}
                        />
                      </TableCell>

                      <TableCell>
                        <RuntimeLabel runtimeKind={vm.runtimeKind} />
                      </TableCell>

                      <TableCell>
                        {hasStandaloneWebUi ? (
                          <Button
                            variant="ghost"
                            type="button"
                            onClick={() => openWebUIWithPairing(sb.id)}
                            className="inline-flex items-center gap-1 text-xs text-muted-strong hover:text-txt-strong transition-colors bg-transparent border-0 p-0"
                          >
                            <ExternalLink className="h-3 w-3" />
                            {t("cloud.elizaAgentsTable.open", {
                              defaultValue: "Open",
                            })}
                          </Button>
                        ) : (
                          <span className="text-xs text-muted">
                            {displayStatus === "running" &&
                            sb.execution_tier !== "shared"
                              ? t("cloud.elizaAgentsTable.unavailable", {
                                  defaultValue: "Unavailable",
                                })
                              : "—"}
                          </span>
                        )}
                      </TableCell>

                      <TableCell>
                        <div className="space-y-0.5">
                          <p className="text-sm text-txt tabular-nums">
                            {formatRelative(sb.created_at)}
                          </p>
                          {sb.last_heartbeat_at && (
                            <p className="text-2xs text-muted tabular-nums">
                              {t("cloud.elizaAgentsTable.heartbeat", {
                                time: formatRelative(sb.last_heartbeat_at),
                                defaultValue: "Heartbeat {{time}}",
                              })}
                            </p>
                          )}
                        </div>
                      </TableCell>

                      <TableCell className="text-right">
                        <div className="flex justify-end gap-0.5">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <a
                                href={`/dashboard/agents/${sb.id}`}
                                className="inline-flex size-touch items-center justify-center text-muted hover:text-txt-strong hover:bg-bg-hover transition-colors"
                              >
                                <FileText className="h-4 w-4" />
                              </a>
                            </TooltipTrigger>
                            <TooltipContent className="bg-card border-border">
                              {t("cloud.elizaAgentsTable.viewDetails", {
                                defaultValue: "View details",
                              })}
                            </TooltipContent>
                          </Tooltip>

                          {hasStandaloneWebUi && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  type="button"
                                  onClick={() => openWebUIWithPairing(sb.id)}
                                  className="inline-flex size-touch items-center justify-center text-muted hover:text-txt-strong hover:bg-bg-hover transition-colors"
                                >
                                  <ExternalLink className="h-4 w-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent className="bg-card border-border">
                                {t("cloud.elizaAgentsTable.openWebUi", {
                                  defaultValue: "Open Web UI",
                                })}
                              </TooltipContent>
                            </Tooltip>
                          )}

                          {canStart && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  type="button"
                                  onClick={() => handleProvision(sb.id)}
                                  disabled={busy}
                                  className="inline-flex size-touch items-center justify-center text-muted hover:text-status-success hover:bg-status-success-bg transition-colors disabled:opacity-30"
                                >
                                  <Play className="h-4 w-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent className="bg-card border-border">
                                {t("cloud.elizaAgentsTable.resumeAgent", {
                                  defaultValue: "Resume agent",
                                })}
                              </TooltipContent>
                            </Tooltip>
                          )}

                          {canStop && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  type="button"
                                  onClick={() => handleSuspend(sb.id)}
                                  disabled={busy}
                                  className="inline-flex size-touch items-center justify-center text-muted hover:text-txt-strong hover:bg-bg-hover transition-colors disabled:opacity-30"
                                >
                                  <Pause className="h-4 w-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent className="bg-card border-border">
                                {t("cloud.elizaAgentsTable.suspendAgent", {
                                  defaultValue: "Suspend agent",
                                })}
                              </TooltipContent>
                            </Tooltip>
                          )}

                          {vm.canWake && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  type="button"
                                  aria-label={t(
                                    "cloud.elizaAgentsTable.reactivateAgent",
                                    { defaultValue: "Reactivate agent" },
                                  )}
                                  onClick={() => handleWake(sb.id)}
                                  disabled={busy}
                                  className="inline-flex size-touch items-center justify-center text-muted hover:text-status-success hover:bg-status-success-bg transition-colors disabled:opacity-30"
                                >
                                  <Sun className="h-4 w-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent className="bg-card border-border">
                                {t("cloud.elizaAgentsTable.reactivateAgent", {
                                  defaultValue: "Reactivate agent",
                                })}
                              </TooltipContent>
                            </Tooltip>
                          )}

                          {vm.canSleep && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  type="button"
                                  aria-label={t(
                                    "cloud.elizaAgentsTable.deactivateAgent",
                                    { defaultValue: "Deactivate agent" },
                                  )}
                                  onClick={() =>
                                    !busy && setDeactivateId(sb.id)
                                  }
                                  disabled={busy}
                                  className="inline-flex size-touch items-center justify-center text-muted hover:text-txt-strong hover:bg-bg-hover transition-colors disabled:opacity-30"
                                >
                                  <Moon className="h-4 w-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent className="bg-card border-border">
                                {t("cloud.elizaAgentsTable.deactivateAgent", {
                                  defaultValue: "Deactivate agent",
                                })}
                              </TooltipContent>
                            </Tooltip>
                          )}

                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                type="button"
                                onClick={() => !busy && setDeleteIds([sb.id])}
                                disabled={isDeleting || busy}
                                className="inline-flex size-touch items-center justify-center text-muted hover:text-destructive hover:bg-destructive-subtle transition-colors disabled:opacity-30"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent className="bg-card border-border">
                              {t("cloud.elizaAgentsTable.deleteAgent", {
                                defaultValue: "Delete agent",
                              })}
                            </TooltipContent>
                          </Tooltip>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </DashboardDataListDesktop>

        {/* Mobile card list */}
        <DashboardDataListMobile>
          {filtered.length === 0 ? (
            <div className="border border-border bg-card p-6 text-center">
              <Search className="h-5 w-5 mx-auto mb-2 text-muted" />
              <p className="text-sm text-muted">
                {t("cloud.elizaAgentsTable.noMatch", {
                  defaultValue: "No agents match your filters",
                })}
              </p>
            </div>
          ) : (
            filtered.map((sb) => {
              const vm = deriveAgentRow(sb, poller, actionInProgress);
              const {
                trackedJob,
                isProvisioningActive,
                busy,
                canStart,
                canStop,
                hasStandaloneWebUi,
              } = vm;

              return (
                <div
                  key={sb.id}
                  className="border border-border bg-card p-4 space-y-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <a
                        href={`/dashboard/agents/${sb.id}`}
                        className="font-medium text-txt-strong hover:opacity-75 transition-opacity block truncate"
                      >
                        {sb.agent_name ??
                          t("cloud.elizaAgentsTable.unnamedAgent", {
                            defaultValue: "Unnamed Agent",
                          })}
                      </a>
                      <AgentCostBadge hostingCost={sb.hosting_cost} />
                      <RowBackingMeta vm={vm} />
                    </div>
                    <StatusCell
                      presentation={vm.statusPresentation}
                      isProvisioning={isProvisioningActive}
                      trackedJob={trackedJob}
                      errorMessage={sb.error_message}
                    />
                  </div>

                  <div className="flex items-center justify-between text-xs text-muted border-t border-border pt-3">
                    <span className="tabular-nums">
                      {formatRelative(sb.created_at)}
                    </span>
                    {sb.last_heartbeat_at && (
                      <span className="tabular-nums">
                        {t("cloud.elizaAgentsTable.heartbeat", {
                          time: formatRelative(sb.last_heartbeat_at),
                          defaultValue: "Heartbeat {{time}}",
                        })}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-1 border-t border-border pt-3">
                    <a
                      href={`/dashboard/agents/${sb.id}`}
                      className="flex-1 flex min-h-touch items-center justify-center gap-1.5 py-2 text-xs text-muted-strong hover:text-txt-strong hover:bg-bg-hover transition-colors"
                    >
                      <FileText className="h-3.5 w-3.5" />
                      {t("cloud.elizaAgentsTable.details", {
                        defaultValue: "Details",
                      })}
                    </a>

                    {hasStandaloneWebUi && (
                      <Button
                        variant="ghost"
                        type="button"
                        onClick={() => openWebUIWithPairing(sb.id)}
                        className="flex-1 flex min-h-touch items-center justify-center gap-1.5 py-2 text-xs text-accent hover:bg-bg-hover transition-colors"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        {t("cloud.elizaAgentsTable.webUi", {
                          defaultValue: "Web UI",
                        })}
                      </Button>
                    )}

                    {canStart && (
                      <Button
                        variant="ghost"
                        type="button"
                        onClick={() => handleProvision(sb.id)}
                        disabled={busy}
                        className="min-h-touch px-3 text-status-success hover:bg-status-success-bg transition-colors disabled:opacity-30"
                      >
                        <Play className="h-3.5 w-3.5" />
                      </Button>
                    )}

                    {canStop && (
                      <Button
                        variant="ghost"
                        type="button"
                        onClick={() => handleSuspend(sb.id)}
                        disabled={busy}
                        className="min-h-touch px-3 text-accent hover:bg-bg-hover transition-colors disabled:opacity-30"
                      >
                        <Pause className="h-3.5 w-3.5" />
                      </Button>
                    )}

                    {vm.canWake && (
                      <Button
                        variant="ghost"
                        type="button"
                        aria-label={t(
                          "cloud.elizaAgentsTable.reactivateAgent",
                          {
                            defaultValue: "Reactivate agent",
                          },
                        )}
                        onClick={() => handleWake(sb.id)}
                        disabled={busy}
                        className="min-h-touch px-3 text-status-success hover:bg-status-success-bg transition-colors disabled:opacity-30"
                      >
                        <Sun className="h-3.5 w-3.5" />
                      </Button>
                    )}

                    {vm.canSleep && (
                      <Button
                        variant="ghost"
                        type="button"
                        aria-label={t(
                          "cloud.elizaAgentsTable.deactivateAgent",
                          {
                            defaultValue: "Deactivate agent",
                          },
                        )}
                        onClick={() => !busy && setDeactivateId(sb.id)}
                        disabled={busy}
                        className="min-h-touch px-3 text-muted hover:text-txt-strong hover:bg-bg-hover transition-colors disabled:opacity-30"
                      >
                        <Moon className="h-3.5 w-3.5" />
                      </Button>
                    )}

                    <Button
                      variant="ghost"
                      type="button"
                      onClick={() => !busy && setDeleteIds([sb.id])}
                      disabled={isDeleting || busy}
                      className="min-h-touch px-3 text-muted hover:text-destructive hover:bg-destructive-subtle transition-colors disabled:opacity-30"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </DashboardDataListMobile>
      </DashboardDataList>

      {/* Delete confirmation — one dialog for the row action and the bulk bar */}
      <BulkDeleteDialog
        open={deleteIds !== null}
        onOpenChange={() => setDeleteIds(null)}
        title={
          (deleteIds?.length ?? 0) > 1
            ? t("cloud.elizaAgentsTable.deleteAgentsTitle", {
                count: deleteIds?.length,
                defaultValue: "Delete {{count}} Agents",
              })
            : t("cloud.elizaAgentsTable.deleteAgentTitle", {
                defaultValue: "Delete Agent",
              })
        }
        description={
          deleteTargetBusy
            ? t("cloud.elizaAgentsTable.deleteBusyDesc", {
                defaultValue:
                  "This agent is still provisioning. Wait for the job to finish before deleting.",
              })
            : (deleteIds?.length ?? 0) > 1
              ? t("cloud.elizaAgentsTable.deleteManyDesc", {
                  count: deleteIds?.length,
                  defaultValue:
                    "This will permanently delete {{count}} agents and stop their running containers.",
                })
              : t("cloud.elizaAgentsTable.deleteDesc", {
                  defaultValue:
                    "This will permanently delete the agent and stop any running container.",
                })
        }
        cancelLabel={t("cloud.elizaAgentsTable.cancel", {
          defaultValue: "Cancel",
        })}
        confirmLabel={
          isDeleting
            ? t("cloud.elizaAgentsTable.deleting", {
                defaultValue: "Deleting…",
              })
            : t("cloud.elizaAgentsTable.delete", { defaultValue: "Delete" })
        }
        confirmDisabled={isDeleting || deleteTargetBusy}
        onConfirm={() =>
          deleteIds &&
          deleteIds.length > 0 &&
          !deleteTargetBusy &&
          handleDelete(deleteIds)
        }
      />

      {deactivateTarget && (
        <DeactivateAgentDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeactivateId(null);
          }}
          hostingCost={deactivateTarget.hosting_cost}
          confirmDisabled={
            poller.isActive(deactivateTarget.id) ||
            actionInProgress === deactivateTarget.id
          }
          isConfirming={actionInProgress === deactivateTarget.id}
          onConfirm={() => {
            setDeactivateId(null);
            void handleSleep(deactivateTarget.id);
          }}
        />
      )}
    </TooltipProvider>
  );
}
