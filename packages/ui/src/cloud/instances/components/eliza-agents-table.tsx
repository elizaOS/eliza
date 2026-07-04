/**
 * Eliza Agents Table — lists hosted agent sandboxes on the Instances page.
 * Auto-refreshes while any sandbox is in an active (pending/provisioning) state.
 */
"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  DashboardDataList,
  DashboardDataListDesktop,
  DashboardDataListFilteredCount,
  DashboardDataListMobile,
  DataListEmptyState,
  Input,
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
import {
  ArrowUpDown,
  Boxes,
  Cloud,
  ExternalLink,
  FileText,
  Loader2,
  Pause,
  Play,
  Search,
  Server,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "../../../components/ui/button";
import { useT } from "../lib/i18n";
import { openWebUIWithPairing } from "../lib/open-web-ui";
import {
  formatRelative,
  statusBadgeColor,
  statusDotColor,
} from "../lib/sandbox-status";
import { useJobPoller } from "../lib/use-job-poller";
import {
  type SandboxListAgent,
  useSandboxListPoll,
} from "../lib/use-sandbox-status-poll";
import { AgentCostBadge } from "./agent-cost-badge";
import { CreateElizaAgentDialog } from "./create-eliza-agent-dialog";

export interface ElizaAgentRow {
  id: string;
  agent_name: string | null;
  status: string;
  canonical_web_ui_url?: string | null;
  node_id: string | null;
  container_name: string | null;
  bridge_port: number | null;
  web_ui_port: number | null;
  headscale_ip: string | null;
  docker_image: string | null;
  execution_tier?: "shared" | "dedicated-lazy" | "dedicated-always" | "custom";
  sandbox_id: string | null;
  bridge_url: string | null;
  error_message: string | null;
  last_heartbeat_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ElizaAgentsTableProps {
  sandboxes: ElizaAgentRow[];
}

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
    sb.status === "provisioning"
  ) {
    return "sandbox";
  }
  return "notProvisioned";
}

function StatusCell({
  displayStatus,
  isProvisioning,
  trackedJob,
  errorMessage,
}: {
  displayStatus: string;
  isProvisioning: boolean;
  trackedJob?: { jobId: string } | null;
  errorMessage: string | null;
}) {
  const t = useT();
  const [prevStatus, setPrevStatus] = useState(displayStatus);
  const [animate, setAnimate] = useState<"success" | "error" | null>(null);

  useEffect(() => {
    if (prevStatus !== displayStatus) {
      if (
        displayStatus === "running" &&
        (prevStatus === "provisioning" || prevStatus === "pending")
      ) {
        setAnimate("success");
        const id = setTimeout(() => setAnimate(null), 1500);
        setPrevStatus(displayStatus);
        return () => clearTimeout(id);
      }
      if (displayStatus === "error") {
        setAnimate("error");
        const id = setTimeout(() => setAnimate(null), 600);
        setPrevStatus(displayStatus);
        return () => clearTimeout(id);
      }
      setPrevStatus(displayStatus);
    }
  }, [displayStatus, prevStatus]);

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
          className={`${statusBadgeColor(displayStatus)} w-fit text-xs-tight font-medium px-2 py-0.5`}
        >
          <span
            className={`inline-block size-1.5 rounded-full mr-1.5 ${statusDotColor(displayStatus)}`}
          />
          {displayStatus}
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
  sandboxes: initialSandboxes,
}: ElizaAgentsTableProps) {
  const t = useT();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  const [localSandboxes, setLocalSandboxes] =
    useState<ElizaAgentRow[]>(initialSandboxes);
  const initialSandboxIdsRef = useRef(
    [...initialSandboxes.map((sb) => sb.id)].sort().join(","),
  );

  useEffect(() => {
    const newIds = [...initialSandboxes.map((sb) => sb.id)].sort().join(",");
    if (newIds !== initialSandboxIdsRef.current) {
      initialSandboxIdsRef.current = newIds;
      setLocalSandboxes(initialSandboxes);
    }
  }, [initialSandboxes]);

  const mergeApiData = useCallback((apiAgents: SandboxListAgent[]) => {
    setLocalSandboxes((prev) => {
      const apiIds = new Set(apiAgents.map((a) => a.id));
      const existingMap = new Map(prev.map((sb) => [sb.id, sb]));

      const merged = apiAgents.map((agent) => {
        const existing = existingMap.get(agent.id);
        return {
          ...(existing ?? {}),
          id: agent.id,
          agent_name: agent.agentName ?? existing?.agent_name ?? null,
          status: agent.status ?? existing?.status ?? "pending",
          error_message: agent.errorMessage ?? existing?.error_message ?? null,
          last_heartbeat_at:
            agent.lastHeartbeatAt ?? existing?.last_heartbeat_at ?? null,
          created_at:
            agent.createdAt ?? existing?.created_at ?? new Date().toISOString(),
          updated_at:
            agent.updatedAt ?? existing?.updated_at ?? new Date().toISOString(),
          node_id: existing?.node_id ?? null,
          container_name: existing?.container_name ?? null,
          bridge_port: existing?.bridge_port ?? null,
          web_ui_port: existing?.web_ui_port ?? null,
          headscale_ip: existing?.headscale_ip ?? null,
          docker_image: agent.dockerImage ?? existing?.docker_image ?? null,
          execution_tier:
            agent.executionTier === undefined
              ? existing?.execution_tier
              : agent.executionTier,
          sandbox_id: existing?.sandbox_id ?? null,
          bridge_url: existing?.bridge_url ?? null,
          canonical_web_ui_url:
            agent.webUiUrl === undefined
              ? (existing?.canonical_web_ui_url ?? null)
              : agent.webUiUrl,
        } as ElizaAgentRow;
      });

      const localOnly = prev.filter((sb) => !apiIds.has(sb.id));
      return [...merged, ...localOnly];
    });
  }, []);

  const refreshData = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/eliza/agents");
      if (!res.ok) return;
      const json = await res.json();
      const agents: SandboxListAgent[] = json?.data ?? [];
      mergeApiData(agents);
    } catch {
      // Silent — retried on next action or poll.
    }
  }, [mergeApiData]);

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
      void refreshData();
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
      void refreshData();
    },
  });

  useSandboxListPoll(
    localSandboxes.map((sb) => ({
      id: sb.id,
      status: poller.isActive(sb.id) ? "provisioning" : sb.status,
    })),
    {
      intervalMs: 10_000,
      onTransitionToRunning: (_id, name) => {
        toast.success(
          t("cloud.elizaAgentsTable.nowRunning", {
            name:
              name ??
              t("cloud.elizaAgentsTable.agent", { defaultValue: "Agent" }),
            defaultValue: "{{name}} is now running!",
          }),
        );
      },
      onDataRefresh: mergeApiData,
    },
  );

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
    const list = localSandboxes.filter((sb) => {
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
    localSandboxes,
    searchQuery,
    statusFilter,
    sortField,
    sortDir,
    poller.isActive,
  ]);

  async function handleProvision(id: string) {
    setActionInProgress(id);
    setLocalSandboxes((prev) =>
      prev.map((sb) => (sb.id === id ? { ...sb, status: "provisioning" } : sb)),
    );
    try {
      const res = await fetch(`/api/v1/eliza/agents/${id}/provision`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 409) {
        const jobId = (data as { data?: { jobId?: string } }).data?.jobId;
        if (jobId) {
          jobActionById.current.set(
            jobId,
            t("cloud.elizaAgentsTable.agentProvisioning", {
              defaultValue: "Agent provisioning",
            }),
          );
          poller.track(id, jobId);
          toast.info(
            t("cloud.elizaAgentsTable.provisioningInProgress", {
              defaultValue: "Provisioning already in progress",
            }),
          );
          return;
        }
      }

      if (!res.ok) {
        void refreshData();
        throw new Error(
          (data as { error?: string }).error ??
            t("cloud.elizaAgentsTable.provisionFailed", {
              defaultValue: "Provision failed",
            }),
        );
      }

      if (res.status === 202) {
        const jobId = (data as { data?: { jobId?: string } }).data?.jobId;
        if (jobId) {
          jobActionById.current.set(
            jobId,
            t("cloud.elizaAgentsTable.agentProvisioning", {
              defaultValue: "Agent provisioning",
            }),
          );
          poller.track(id, jobId);
          toast.success(
            t("cloud.elizaAgentsTable.provisioningQueued", {
              defaultValue: "Agent provisioning queued",
            }),
          );
          return;
        }

        toast.success(
          t("cloud.elizaAgentsTable.provisioningStarted", {
            defaultValue: "Agent provisioning started",
          }),
        );
        void refreshData();
        return;
      }

      toast.success(
        t("cloud.elizaAgentsTable.alreadyRunning", {
          defaultValue: "Agent is already running",
        }),
      );
      void refreshData();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(
        t("cloud.elizaAgentsTable.failedToStart", {
          message,
          defaultValue: "Failed to start agent: {{message}}",
        }),
      );
    } finally {
      setActionInProgress(null);
    }
  }

  async function handleSuspend(id: string) {
    setActionInProgress(id);
    setLocalSandboxes((prev) =>
      prev.map((sb) => (sb.id === id ? { ...sb, status: "stopped" } : sb)),
    );
    try {
      const res = await fetch(`/api/v1/eliza/agents/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "suspend" }),
      });
      const data = await res.json().catch(() => ({}));
      const jobId = (data as { data?: { jobId?: string } }).data?.jobId;

      if (res.status === 409 && jobId) {
        jobActionById.current.set(
          jobId,
          t("cloud.elizaAgentsTable.agentSuspend", {
            defaultValue: "Agent suspend",
          }),
        );
        poller.track(id, jobId);
        toast.info(
          t("cloud.elizaAgentsTable.suspendInProgress", {
            defaultValue: "Suspend already in progress",
          }),
        );
        return;
      }

      if (!res.ok && res.status !== 202) {
        void refreshData();
        throw new Error(
          (data as { error?: string }).error ??
            t("cloud.elizaAgentsTable.suspendFailed", {
              defaultValue: "Suspend failed",
            }),
        );
      }

      if (res.status === 202 && jobId) {
        jobActionById.current.set(
          jobId,
          t("cloud.elizaAgentsTable.agentSuspend", {
            defaultValue: "Agent suspend",
          }),
        );
        poller.track(id, jobId);
        toast.success(
          t("cloud.elizaAgentsTable.suspendQueued", {
            defaultValue: "Suspend queued",
          }),
        );
        return;
      }

      toast.success(
        t("cloud.elizaAgentsTable.suspended", {
          defaultValue: "Agent suspended (snapshot saved)",
        }),
      );
      void refreshData();
    } catch {
      toast.error(
        t("cloud.elizaAgentsTable.failedToSuspend", {
          defaultValue: "Failed to suspend agent",
        }),
      );
    } finally {
      setActionInProgress(null);
    }
  }

  async function handleDelete(id: string) {
    setIsDeleting(true);
    const previousSandboxes = localSandboxes;
    setLocalSandboxes((prev) => prev.filter((sb) => sb.id !== id));
    try {
      const res = await fetch(`/api/v1/eliza/agents/${id}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLocalSandboxes(previousSandboxes);
        throw new Error(
          (data as { error?: string }).error ??
            t("cloud.elizaAgentsTable.deleteFailed", {
              defaultValue: "Delete failed",
            }),
        );
      }
      toast.success(
        t("cloud.elizaAgentsTable.agentDeleted", {
          defaultValue: "Agent deleted",
        }),
      );
      void refreshData();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t("cloud.elizaAgentsTable.failedToDelete", {
              defaultValue: "Failed to delete agent",
            });
      toast.error(message);
    } finally {
      setIsDeleting(false);
      setDeleteId(null);
    }
  }

  const deleteTargetBusy = deleteId ? poller.isActive(deleteId) : false;

  if (localSandboxes.length === 0) {
    return (
      <DataListEmptyState
        title={t("cloud.elizaAgentsTable.noAgentsYet", {
          defaultValue: "No agents yet",
        })}
        description={t("cloud.elizaAgentsTable.noAgentsYetDesc", {
          defaultValue: "Deploy your first agent to get started.",
        })}
        icon={Boxes}
        action={
          <CreateElizaAgentDialog
            onProvisionQueued={(agentId, jobId) => {
              jobActionById.current.set(
                jobId,
                t("cloud.elizaAgentsTable.agentProvisioning", {
                  defaultValue: "Agent provisioning",
                }),
              );
              poller.track(agentId, jobId);
            }}
            onCreated={refreshData}
          />
        }
      />
    );
  }

  return (
    <TooltipProvider>
      <DashboardDataList>
        {/* Search + filter + create */}
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
          <CreateElizaAgentDialog
            onProvisionQueued={(agentId, jobId) => {
              jobActionById.current.set(
                jobId,
                t("cloud.elizaAgentsTable.agentProvisioning", {
                  defaultValue: "Agent provisioning",
                }),
              );
              poller.track(agentId, jobId);
            }}
            onCreated={refreshData}
          />
        </div>

        {(searchQuery || statusFilter !== "all") && (
          <DashboardDataListFilteredCount
            filtered={filtered.length}
            total={localSandboxes.length}
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
                  <TableCell colSpan={6} className="h-24 text-center">
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
                  const isDocker = isDockerBacked(sb);
                  const trackedJob = poller.getStatus(sb.id);
                  const isProvisioningActive = poller.isActive(sb.id);
                  const displayStatus = isProvisioningActive
                    ? "provisioning"
                    : sb.status;
                  const busy =
                    actionInProgress === sb.id || isProvisioningActive;
                  const canStart =
                    ["stopped", "error", "pending", "disconnected"].includes(
                      displayStatus,
                    ) && !busy;
                  const canStop = displayStatus === "running" && !busy;
                  const hasStandaloneWebUi =
                    displayStatus === "running" &&
                    sb.execution_tier !== "shared" &&
                    Boolean(sb.canonical_web_ui_url);

                  return (
                    <TableRow
                      key={sb.id}
                      className="hover:bg-bg-hover transition-colors border-b border-border"
                    >
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
                            <AgentCostBadge status={displayStatus} />
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center gap-1 text-2xs text-muted">
                              {isDocker ? (
                                <Server className="h-2.5 w-2.5" />
                              ) : (
                                <Cloud className="h-2.5 w-2.5" />
                              )}
                              {isDocker
                                ? t("cloud.elizaAgentsTable.docker", {
                                    defaultValue: "Docker",
                                  })
                                : sb.execution_tier === "shared"
                                  ? t("cloud.elizaAgentsTable.shared", {
                                      defaultValue: "Shared",
                                    })
                                  : t("cloud.elizaAgentsTable.sandbox", {
                                      defaultValue: "Sandbox",
                                    })}
                            </span>
                            <span className="text-2xs text-muted font-mono tabular-nums">
                              {sb.id.slice(0, 8)}
                            </span>
                          </div>
                        </div>
                      </TableCell>

                      <TableCell>
                        <StatusCell
                          displayStatus={displayStatus}
                          isProvisioning={isProvisioningActive}
                          trackedJob={trackedJob}
                          errorMessage={sb.error_message}
                        />
                      </TableCell>

                      <TableCell>
                        <span className="text-xs text-muted-strong">
                          {getRuntimeKind(sb) === "managed"
                            ? t("cloud.elizaAgentsTable.managedRuntime", {
                                defaultValue: "Managed runtime",
                              })
                            : getRuntimeKind(sb) === "shared"
                              ? t("cloud.elizaAgentsTable.sharedRuntime", {
                                  defaultValue: "Shared runtime",
                                })
                              : getRuntimeKind(sb) === "sandbox"
                                ? t("cloud.elizaAgentsTable.cloudSandbox", {
                                    defaultValue: "Cloud sandbox",
                                  })
                                : t("cloud.elizaAgentsTable.notProvisioned", {
                                    defaultValue: "Not provisioned",
                                  })}
                        </span>
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

                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                type="button"
                                onClick={() => !busy && setDeleteId(sb.id)}
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
              const isDocker = isDockerBacked(sb);
              const trackedJob = poller.getStatus(sb.id);
              const isProvisioningActive = poller.isActive(sb.id);
              const displayStatus = isProvisioningActive
                ? "provisioning"
                : sb.status;
              const busy = actionInProgress === sb.id || isProvisioningActive;
              const canStart =
                ["stopped", "error", "pending", "disconnected"].includes(
                  displayStatus,
                ) && !busy;
              const canStop = displayStatus === "running" && !busy;
              const hasStandaloneWebUi =
                displayStatus === "running" &&
                sb.execution_tier !== "shared" &&
                Boolean(sb.canonical_web_ui_url);

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
                      <AgentCostBadge status={displayStatus} />
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center gap-1 text-2xs text-muted">
                          {isDocker ? (
                            <Server className="h-2.5 w-2.5" />
                          ) : (
                            <Cloud className="h-2.5 w-2.5" />
                          )}
                          {isDocker
                            ? t("cloud.elizaAgentsTable.docker", {
                                defaultValue: "Docker",
                              })
                            : sb.execution_tier === "shared"
                              ? t("cloud.elizaAgentsTable.shared", {
                                  defaultValue: "Shared",
                                })
                              : t("cloud.elizaAgentsTable.sandbox", {
                                  defaultValue: "Sandbox",
                                })}
                        </span>
                        <span className="text-2xs text-muted font-mono tabular-nums">
                          {sb.id.slice(0, 8)}
                        </span>
                      </div>
                    </div>
                    <StatusCell
                      displayStatus={displayStatus}
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

                    <Button
                      variant="ghost"
                      type="button"
                      onClick={() => !busy && setDeleteId(sb.id)}
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

      {/* Delete confirmation */}
      <AlertDialog
        open={deleteId !== null}
        onOpenChange={() => setDeleteId(null)}
      >
        <AlertDialogContent className="bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-txt-strong">
              {t("cloud.elizaAgentsTable.deleteAgentTitle", {
                defaultValue: "Delete Agent",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-muted">
              {deleteTargetBusy
                ? t("cloud.elizaAgentsTable.deleteBusyDesc", {
                    defaultValue:
                      "This agent is still provisioning. Wait for the job to finish before deleting.",
                  })
                : t("cloud.elizaAgentsTable.deleteDesc", {
                    defaultValue:
                      "This will permanently delete the agent and stop any running container.",
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border bg-transparent text-txt-strong hover:bg-bg-hover">
              {t("cloud.elizaAgentsTable.cancel", { defaultValue: "Cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                deleteId && !deleteTargetBusy && handleDelete(deleteId)
              }
              disabled={isDeleting || deleteTargetBusy}
              className="bg-destructive hover:bg-accent-hover text-accent-foreground disabled:opacity-50"
            >
              {isDeleting
                ? t("cloud.elizaAgentsTable.deleting", {
                    defaultValue: "Deleting…",
                  })
                : t("cloud.elizaAgentsTable.delete", {
                    defaultValue: "Delete",
                  })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}
