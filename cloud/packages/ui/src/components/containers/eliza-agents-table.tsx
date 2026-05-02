/**
 * Eliza Agents Table — lists AI agent sandboxes in the containers dashboard.
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
} from "@elizaos/cloud-ui";
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
import { openWebUIWithPairing } from "@/lib/hooks/open-web-ui";
import { useJobPoller } from "@/lib/hooks/use-job-poller";
import { type SandboxListAgent, useSandboxListPoll } from "@/lib/hooks/use-sandbox-status-poll";
import { AgentCostBadge } from "./agent-cost-badge";
import { CreateElizaAgentDialog } from "./create-eliza-agent-dialog";

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------

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

// ----------------------------------------------------------------
// Status helpers (shared across dashboard components)
// ----------------------------------------------------------------

import { formatRelative, statusBadgeColor, statusDotColor } from "@/lib/constants/sandbox-status";

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function isDockerBacked(sb: ElizaAgentRow): boolean {
  return !!sb.node_id;
}

// ----------------------------------------------------------------
// Status Cell — animated transitions
// ----------------------------------------------------------------

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
          className={`${statusBadgeColor(displayStatus)} w-fit text-[11px] font-medium px-2 py-0.5`}
        >
          <span
            className={`inline-block size-1.5 rounded-full mr-1.5 ${statusDotColor(displayStatus)}`}
          />
          {displayStatus}
        </Badge>
      </div>
      {isProvisioning && trackedJob && (
        <span className="text-[10px] text-blue-400/80 flex items-center gap-1 pl-0.5">
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
          Job {trackedJob.jobId.slice(0, 8)}
        </span>
      )}
      {errorMessage && (
        <Tooltip>
          <TooltipTrigger asChild>
            <p className="text-[11px] text-red-400/80 truncate max-w-[180px] cursor-help pl-0.5">
              {errorMessage}
            </p>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs bg-neutral-900 border-white/10">
            <p>{errorMessage}</p>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

// ----------------------------------------------------------------
// Component
// ----------------------------------------------------------------

export function ElizaAgentsTable({ sandboxes: initialSandboxes }: ElizaAgentsTableProps) {
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  // ── Client-side data management ──────────────────────────────
  // Initialize from server props, then manage locally for instant UI updates.
  const [localSandboxes, setLocalSandboxes] = useState<ElizaAgentRow[]>(initialSandboxes);
  const initialSandboxIdsRef = useRef([...initialSandboxes.map((sb) => sb.id)].sort().join(","));

  // Re-sync from server props if the initial set changes (e.g. page navigation)
  useEffect(() => {
    const newIds = [...initialSandboxes.map((sb) => sb.id)].sort().join(",");
    if (newIds !== initialSandboxIdsRef.current) {
      initialSandboxIdsRef.current = newIds;
      setLocalSandboxes(initialSandboxes);
    }
  }, [initialSandboxes]);

  /**
   * Merge camelCase API response into local snake_case state.
   * Preserves server-only fields (node_id, container_name, etc.) for existing
   * agents while updating status/error/heartbeat from the API.
   */
  const mergeApiData = useCallback((apiAgents: SandboxListAgent[]) => {
    setLocalSandboxes((prev) => {
      const apiIds = new Set(apiAgents.map((a) => a.id));
      const existingMap = new Map(prev.map((sb) => [sb.id, sb]));

      // Merge API agents with existing local state
      const merged = apiAgents.map((agent) => {
        const existing = existingMap.get(agent.id);
        return {
          // Spread existing server-only fields first (infra details)
          ...(existing ?? {}),
          // Then overlay API data (converting camelCase → snake_case)
          id: agent.id,
          agent_name: agent.agentName ?? existing?.agent_name ?? null,
          status: agent.status ?? existing?.status ?? "pending",
          error_message: agent.errorMessage ?? existing?.error_message ?? null,
          last_heartbeat_at: agent.lastHeartbeatAt ?? existing?.last_heartbeat_at ?? null,
          created_at: agent.createdAt ?? existing?.created_at ?? new Date().toISOString(),
          updated_at: agent.updatedAt ?? existing?.updated_at ?? new Date().toISOString(),
          // Preserve infra fields from existing data (API list doesn't return these)
          node_id: existing?.node_id ?? null,
          container_name: existing?.container_name ?? null,
          bridge_port: existing?.bridge_port ?? null,
          web_ui_port: existing?.web_ui_port ?? null,
          headscale_ip: existing?.headscale_ip ?? null,
          docker_image: existing?.docker_image ?? null,
          sandbox_id: existing?.sandbox_id ?? null,
          bridge_url: existing?.bridge_url ?? null,
          canonical_web_ui_url: existing?.canonical_web_ui_url ?? null,
        } as ElizaAgentRow;
      });

      // Preserve local-only entries (optimistic additions not yet in API response)
      const localOnly = prev.filter((sb) => !apiIds.has(sb.id));
      return [...merged, ...localOnly];
    });
  }, []);

  /** Fetch fresh data from the API and update local state. */
  const refreshData = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/eliza/agents");
      if (!res.ok) return;
      const json = await res.json();
      const agents: SandboxListAgent[] = json?.data ?? [];
      mergeApiData(agents);
    } catch {
      // Silent — will retry on next action or poll
    }
  }, [mergeApiData]);

  const poller = useJobPoller({
    onComplete: () => {
      toast.success("Agent provisioning completed");
      void refreshData();
    },
    onFailed: (job) => {
      toast.error(job.error ?? "Provisioning failed");
      void refreshData();
    },
  });

  // Auto-refresh polling: polls the list endpoint while any sandbox is active.
  // Pushes fresh data via onDataRefresh so the table updates without page reload.
  useSandboxListPoll(
    localSandboxes.map((sb) => ({
      id: sb.id,
      status: poller.isActive(sb.id) ? "provisioning" : sb.status,
    })),
    {
      intervalMs: 10_000,
      onTransitionToRunning: (_id, name) => {
        toast.success(`${name ?? "Agent"} is now running!`);
      },
      onDataRefresh: mergeApiData,
    },
  );

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortField, setSortField] = useState<"name" | "status" | "created">("created");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const handleSort = (field: typeof sortField) => {
    setSortDir((prev) => (sortField === field && prev === "asc" ? "desc" : "asc"));
    setSortField(field);
  };

  const filtered = useMemo(() => {
    let list = localSandboxes.filter((sb) => {
      const q = searchQuery.toLowerCase();
      const displayStatus = poller.isActive(sb.id) ? "provisioning" : sb.status;
      const matchSearch =
        !q ||
        (sb.agent_name ?? "").toLowerCase().includes(q) ||
        (sb.container_name ?? "").toLowerCase().includes(q) ||
        (sb.node_id ?? "").toLowerCase().includes(q) ||
        (sb.headscale_ip ?? "").toLowerCase().includes(q);
      const matchStatus = statusFilter === "all" || displayStatus === statusFilter;
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
        cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [localSandboxes, searchQuery, statusFilter, sortField, sortDir, poller.isActive]);

  // ── Actions ──────────────────────────────────────────────────────

  async function handleProvision(id: string) {
    setActionInProgress(id);
    // Optimistic: show provisioning status immediately
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
          poller.track(id, jobId);
          toast.info("Provisioning already in progress");
          return;
        }
      }

      if (!res.ok) {
        // Revert optimistic update
        void refreshData();
        throw new Error((data as { error?: string }).error ?? "Provision failed");
      }

      if (res.status === 202) {
        const jobId = (data as { data?: { jobId?: string } }).data?.jobId;
        if (jobId) {
          poller.track(id, jobId);
          toast.success("Agent provisioning queued");
          return;
        }

        toast.success("Agent provisioning started");
        void refreshData();
        return;
      }

      toast.success("Agent is already running");
      void refreshData();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to start agent: ${message}`);
    } finally {
      setActionInProgress(null);
    }
  }

  async function handleSuspend(id: string) {
    setActionInProgress(id);
    // Optimistic: show stopped status immediately
    setLocalSandboxes((prev) =>
      prev.map((sb) => (sb.id === id ? { ...sb, status: "stopped" } : sb)),
    );
    try {
      const res = await fetch(`/api/v1/eliza/agents/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "suspend" }),
      });
      if (!res.ok) {
        // Revert optimistic update
        void refreshData();
        throw new Error("Suspend failed");
      }
      toast.success("Agent suspended (snapshot saved)");
      void refreshData();
    } catch {
      toast.error("Failed to suspend agent");
    } finally {
      setActionInProgress(null);
    }
  }

  async function handleDelete(id: string) {
    setIsDeleting(true);
    // Optimistic: remove from list immediately
    const previousSandboxes = localSandboxes;
    setLocalSandboxes((prev) => prev.filter((sb) => sb.id !== id));
    try {
      const res = await fetch(`/api/v1/eliza/agents/${id}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Revert optimistic removal
        setLocalSandboxes(previousSandboxes);
        throw new Error((data as { error?: string }).error ?? "Delete failed");
      }
      toast.success("Agent deleted");
      // Confirm with a refresh (already removed optimistically)
      void refreshData();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete agent";
      toast.error(message);
    } finally {
      setIsDeleting(false);
      setDeleteId(null);
    }
  }

  const deleteTargetBusy = deleteId ? poller.isActive(deleteId) : false;

  // ── Empty state ──────────────────────────────────────────────────

  if (localSandboxes.length === 0) {
    return (
      <div className="border border-white/10 bg-black/40 p-8 md:p-12">
        <div className="flex flex-col items-center justify-center text-center space-y-4 max-w-sm mx-auto">
          <div className="flex size-12 items-center justify-center border border-white/10 bg-white/[0.03]">
            <Boxes className="h-6 w-6 text-white/40" />
          </div>
          <div className="space-y-1.5">
            <p className="text-white font-medium">No agents yet</p>
            <p className="text-sm text-white/45">Deploy your first agent to get started.</p>
          </div>
          <div className="pt-2">
            <CreateElizaAgentDialog
              onProvisionQueued={(agentId, jobId) => poller.track(agentId, jobId)}
              onCreated={refreshData}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {/* Search + filter + create */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/30" />
            <Input
              placeholder="Search agents…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-9 border-white/10 bg-black/40 text-white placeholder:text-white/30 focus-visible:ring-[#FF5800]/50"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-[150px] h-9 border-white/10 bg-black/40 text-sm">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent className="border-white/10 bg-neutral-900">
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="running">Running</SelectItem>
              <SelectItem value="provisioning">Provisioning</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="stopped">Stopped</SelectItem>
              <SelectItem value="disconnected">Disconnected</SelectItem>
              <SelectItem value="error">Error</SelectItem>
            </SelectContent>
          </Select>
          <CreateElizaAgentDialog
            onProvisionQueued={(agentId, jobId) => poller.track(agentId, jobId)}
            onCreated={refreshData}
          />
        </div>

        {(searchQuery || statusFilter !== "all") && (
          <p className="text-[11px] uppercase tracking-widest text-white/40 tabular-nums">
            {filtered.length} of {localSandboxes.length} agents
          </p>
        )}

        {/* Desktop table */}
        <div className="hidden md:block border border-white/10 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-black/40 border-b border-white/10 hover:bg-black/40">
                <TableHead className="w-[30%]">
                  <button
                    type="button"
                    onClick={() => handleSort("name")}
                    className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-widest text-white/40 hover:text-white/70 transition-colors"
                  >
                    Agent
                    <ArrowUpDown className="h-3 w-3" />
                  </button>
                </TableHead>
                <TableHead>
                  <button
                    type="button"
                    onClick={() => handleSort("status")}
                    className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-widest text-white/40 hover:text-white/70 transition-colors"
                  >
                    Status
                    <ArrowUpDown className="h-3 w-3" />
                  </button>
                </TableHead>
                <TableHead className="text-[11px] font-medium uppercase tracking-widest text-white/40">
                  Runtime
                </TableHead>
                <TableHead className="text-[11px] font-medium uppercase tracking-widest text-white/40">
                  Web UI
                </TableHead>
                <TableHead>
                  <button
                    type="button"
                    onClick={() => handleSort("created")}
                    className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-widest text-white/40 hover:text-white/70 transition-colors"
                  >
                    Created
                    <ArrowUpDown className="h-3 w-3" />
                  </button>
                </TableHead>
                <TableHead className="text-right text-[11px] font-medium uppercase tracking-widest text-white/40">
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center">
                    <div className="flex flex-col items-center justify-center gap-1 text-white/40">
                      <Search className="h-5 w-5 mb-1" />
                      <p className="text-sm">No agents match your filters</p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((sb) => {
                  const isDocker = isDockerBacked(sb);
                  const trackedJob = poller.getStatus(sb.id);
                  const isProvisioningActive = poller.isActive(sb.id);
                  const displayStatus = isProvisioningActive ? "provisioning" : sb.status;
                  const busy = actionInProgress === sb.id || isProvisioningActive;
                  const canStart =
                    ["stopped", "error", "pending", "disconnected"].includes(displayStatus) &&
                    !busy;
                  const canStop = displayStatus === "running" && !busy;

                  return (
                    <TableRow
                      key={sb.id}
                      className="hover:bg-white/[0.03] transition-colors border-b border-white/5"
                    >
                      {/* Agent name + type */}
                      <TableCell>
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <a
                              href={`/dashboard/agents/${sb.id}`}
                              className="font-medium text-white hover:text-[#FF5800] transition-colors"
                            >
                              {sb.agent_name ?? "Unnamed Agent"}
                            </a>
                            <AgentCostBadge status={displayStatus} />
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center gap-1 text-[10px] text-white/35">
                              {isDocker ? (
                                <Server className="h-2.5 w-2.5" />
                              ) : (
                                <Cloud className="h-2.5 w-2.5" />
                              )}
                              {isDocker ? "Docker" : "Sandbox"}
                            </span>
                            <span className="text-[10px] text-white/20 font-mono tabular-nums">
                              {sb.id.slice(0, 8)}
                            </span>
                          </div>
                        </div>
                      </TableCell>

                      {/* Status */}
                      <TableCell>
                        <StatusCell
                          displayStatus={displayStatus}
                          isProvisioning={isProvisioningActive}
                          trackedJob={trackedJob}
                          errorMessage={sb.error_message}
                        />
                      </TableCell>

                      {/* Runtime */}
                      <TableCell>
                        <span className="text-xs text-white/50">
                          {isDocker
                            ? "Managed runtime"
                            : sb.sandbox_id
                              ? "Cloud sandbox"
                              : "Not provisioned"}
                        </span>
                      </TableCell>

                      {/* Web UI */}
                      <TableCell>
                        {displayStatus === "running" ? (
                          <button
                            type="button"
                            onClick={() => openWebUIWithPairing(sb.id)}
                            className="inline-flex items-center gap-1 text-xs text-[#FF5800] hover:text-[#FF5800]/70 transition-colors bg-transparent border-0 p-0"
                          >
                            <ExternalLink className="h-3 w-3" />
                            Open
                          </button>
                        ) : (
                          <span className="text-xs text-white/20">
                            {displayStatus === "running" ? "Unavailable" : "—"}
                          </span>
                        )}
                      </TableCell>

                      {/* Created */}
                      <TableCell>
                        <div className="space-y-0.5">
                          <p className="text-sm text-white/70 tabular-nums">
                            {formatRelative(sb.created_at)}
                          </p>
                          {sb.last_heartbeat_at && (
                            <p className="text-[10px] text-white/30 tabular-nums">
                              Heartbeat {formatRelative(sb.last_heartbeat_at)}
                            </p>
                          )}
                        </div>
                      </TableCell>

                      {/* Actions */}
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-0.5">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <a
                                href={`/dashboard/agents/${sb.id}`}
                                className="p-2 text-white/30 hover:text-white hover:bg-white/5 transition-colors"
                              >
                                <FileText className="h-4 w-4" />
                              </a>
                            </TooltipTrigger>
                            <TooltipContent className="bg-neutral-900 border-white/10">
                              View details
                            </TooltipContent>
                          </Tooltip>

                          {displayStatus === "running" && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  onClick={() => openWebUIWithPairing(sb.id)}
                                  className="p-2 text-white/30 hover:text-[#FF5800] hover:bg-[#FF5800]/10 transition-colors"
                                >
                                  <ExternalLink className="h-4 w-4" />
                                </button>
                              </TooltipTrigger>
                              <TooltipContent className="bg-neutral-900 border-white/10">
                                Open Web UI
                              </TooltipContent>
                            </Tooltip>
                          )}

                          {canStart && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  onClick={() => handleProvision(sb.id)}
                                  disabled={busy}
                                  className="p-2 text-white/30 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-30"
                                >
                                  <Play className="h-4 w-4" />
                                </button>
                              </TooltipTrigger>
                              <TooltipContent className="bg-neutral-900 border-white/10">
                                Resume agent
                              </TooltipContent>
                            </Tooltip>
                          )}

                          {canStop && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  onClick={() => handleSuspend(sb.id)}
                                  disabled={busy}
                                  className="p-2 text-white/30 hover:text-orange-400 hover:bg-orange-500/10 transition-colors disabled:opacity-30"
                                >
                                  <Pause className="h-4 w-4" />
                                </button>
                              </TooltipTrigger>
                              <TooltipContent className="bg-neutral-900 border-white/10">
                                Suspend agent
                              </TooltipContent>
                            </Tooltip>
                          )}

                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                onClick={() => !busy && setDeleteId(sb.id)}
                                disabled={isDeleting || busy}
                                className="p-2 text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-30"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent className="bg-neutral-900 border-white/10">
                              Delete agent
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
        </div>

        {/* Mobile card list */}
        <div className="md:hidden space-y-2">
          {filtered.length === 0 ? (
            <div className="border border-white/10 bg-black/40 p-6 text-center">
              <Search className="h-5 w-5 mx-auto mb-2 text-white/30" />
              <p className="text-sm text-white/40">No agents match your filters</p>
            </div>
          ) : (
            filtered.map((sb) => {
              const isDocker = isDockerBacked(sb);
              const trackedJob = poller.getStatus(sb.id);
              const isProvisioningActive = poller.isActive(sb.id);
              const displayStatus = isProvisioningActive ? "provisioning" : sb.status;
              const busy = actionInProgress === sb.id || isProvisioningActive;
              const canStart =
                ["stopped", "error", "pending", "disconnected"].includes(displayStatus) && !busy;
              const canStop = displayStatus === "running" && !busy;

              return (
                <div key={sb.id} className="border border-white/10 bg-black/40 p-4 space-y-3">
                  {/* Header: name + status */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <a
                        href={`/dashboard/agents/${sb.id}`}
                        className="font-medium text-white hover:text-[#FF5800] transition-colors block truncate"
                      >
                        {sb.agent_name ?? "Unnamed Agent"}
                      </a>
                      <AgentCostBadge status={displayStatus} />
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center gap-1 text-[10px] text-white/35">
                          {isDocker ? (
                            <Server className="h-2.5 w-2.5" />
                          ) : (
                            <Cloud className="h-2.5 w-2.5" />
                          )}
                          {isDocker ? "Docker" : "Sandbox"}
                        </span>
                        <span className="text-[10px] text-white/20 font-mono tabular-nums">
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

                  {/* Meta row */}
                  <div className="flex items-center justify-between text-xs text-white/40 border-t border-white/5 pt-3">
                    <span className="tabular-nums">{formatRelative(sb.created_at)}</span>
                    {sb.last_heartbeat_at && (
                      <span className="tabular-nums">
                        Heartbeat {formatRelative(sb.last_heartbeat_at)}
                      </span>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 border-t border-white/5 pt-3">
                    <a
                      href={`/dashboard/agents/${sb.id}`}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs text-white/50 hover:text-white hover:bg-white/5 transition-colors border border-white/10"
                    >
                      <FileText className="h-3.5 w-3.5" />
                      Details
                    </a>

                    {displayStatus === "running" && (
                      <button
                        type="button"
                        onClick={() => openWebUIWithPairing(sb.id)}
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs text-[#FF5800] hover:bg-[#FF5800]/10 transition-colors border border-[#FF5800]/30"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        Web UI
                      </button>
                    )}

                    {canStart && (
                      <button
                        type="button"
                        onClick={() => handleProvision(sb.id)}
                        disabled={busy}
                        className="py-2 px-3 text-emerald-400 hover:bg-emerald-500/10 transition-colors border border-emerald-500/20 disabled:opacity-30"
                      >
                        <Play className="h-3.5 w-3.5" />
                      </button>
                    )}

                    {canStop && (
                      <button
                        type="button"
                        onClick={() => handleSuspend(sb.id)}
                        disabled={busy}
                        className="py-2 px-3 text-orange-400 hover:bg-orange-500/10 transition-colors border border-orange-500/20 disabled:opacity-30"
                      >
                        <Pause className="h-3.5 w-3.5" />
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => !busy && setDeleteId(sb.id)}
                      disabled={isDeleting || busy}
                      className="py-2 px-3 text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors border border-white/10 disabled:opacity-30"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Delete confirmation */}
      <AlertDialog open={deleteId !== null} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent className="bg-neutral-900 border-white/10">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-white">Delete Agent</AlertDialogTitle>
            <AlertDialogDescription className="text-white/50">
              {deleteTargetBusy
                ? "This agent is still provisioning. Wait for the job to finish before deleting."
                : "This will permanently delete the agent and stop any running container."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-white/10 bg-transparent text-white hover:bg-white/5">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteId && !deleteTargetBusy && handleDelete(deleteId)}
              disabled={isDeleting || deleteTargetBusy}
              className="bg-red-500 hover:bg-red-600 text-white disabled:opacity-50"
            >
              {isDeleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}
