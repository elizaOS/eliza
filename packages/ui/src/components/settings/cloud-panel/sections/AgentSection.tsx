/**
 * Cloud agent management section for the cloud-only settings panel. Lists the
 * signed-in user's Eliza Cloud agents and drives their lifecycle — create,
 * rename, suspend/resume (with status polling), delete (with job polling), and
 * "wake then switch to" — through the typed cloud API client. The active cloud
 * server is tracked in persisted App state so the current agent is highlighted
 * at the top and in each row.
 */

import { Button as NuphyButton } from "@extrastu/nuphy-ui";
import {
  Circle,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client, ElizaClient } from "../../../../api";
import {
  getCloudAuthToken,
  resolveCloudAgentApiBase,
} from "../../../../api/client-cloud";
import type { CloudCompatAgent } from "../../../../api/client-types-cloud";
import { getBootConfig } from "../../../../config/boot-config";
import { useBranding } from "../../../../config/branding";
import { cn } from "../../../../lib/utils";
import { useAppSelector } from "../../../../state";
import { upsertAndActivateAgentProfile } from "../../../../state/agent-profiles";
import { clearStalePairCredentialsForAgent } from "../../../../state/cloud-pair-token";
import {
  createPersistedActiveServer,
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "../../../../state/persistence";
import { Input } from "../../../ui/input";
import { StatusBadge } from "../../../ui/status-badge";
import {
  agentLifecycleLabel,
  statusToneForState,
} from "../../../ui/status-badge.helpers";
import { NuphyRow, SettingsGroup, SettingsStack } from "../nuphy-settings-primitives";

/** Maximum length accepted for a (new or edited) cloud agent name. */
const AGENT_NAME_MAX_LENGTH = 60;
/** How long to poll a delete job before giving up and forcing a refresh. */
const DELETE_POLL_TIMEOUT_MS = 60_000;
/** Delay between delete-job poll attempts. */
const DELETE_POLL_INTERVAL_MS = 1_500;
/** Delay between status re-sync poll attempts after a suspend/resume. */
const STATUS_POLL_INTERVAL_MS = 3_000;
/** How many times to poll an agent's status after a suspend/resume before
 * giving up (the daemon's job should have flipped the status by then). */
const STATUS_POLL_ATTEMPTS = 5;
/** How long to poll a waking agent before entering anyway with a warning. */
const WAKE_POLL_TIMEOUT_MS = 60_000;
/** Delay between waking-readiness poll attempts. */
const WAKE_POLL_INTERVAL_MS = 2_000;

/** Statuses that mean an agent is not running and must be woken before use. */
const NON_RUNNING_STATES = new Set(["stopped", "sleeping", "suspended"]);
/** Statuses that indicate the agent failed / is in an error state. */
const ERROR_STATES = new Set(["error", "failed"]);

/** The agent id currently bound as the active cloud server, if any. */
function activeCloudAgentId(): string | null {
  const active = loadPersistedActiveServer();
  if (active?.kind !== "cloud") return null;
  const id = active.id?.startsWith("cloud:")
    ? active.id.slice("cloud:".length)
    : "";
  // Older builds mistakenly stored a URL as the id — not a real agent id.
  return id && !id.includes("/") ? id : null;
}

/** The cloud access token for the current session. */
function currentCloudToken(): string {
  // Agent management crosses the control-plane boundary, so only the
  // independently stored Steward session is admissible. The active server's
  // access token authenticates its container and must never substitute here.
  return getCloudAuthToken() ?? "";
}

/** Tailwind text color for a status dot: green/amber/red/muted by lifecycle. */
function statusDotClass(status: string): string {
  switch (status.toLowerCase()) {
    case "running":
    case "ready":
      return "text-emerald-500";
    case "sleeping":
    case "suspended":
    case "suspending":
      return "text-amber-500";
    case "stopped":
      return "text-muted-foreground";
    case "error":
    case "failed":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

/** Truncate an agent id for compact display (first 8 chars + ellipsis). */
function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

/** ISO timestamp → "YYYY-MM-DD" slice, safe for render-time use (no Date math). */
function dateSlice(iso: string | null | undefined): string {
  return typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : "—";
}

/**
 * Eliza Cloud agent manager for the cloud-only settings panel. Shows the active
 * agent up top, lists every cloud agent with lifecycle actions, and expands an
 * inline details panel when renaming.
 */
export function AgentSection() {
  const elizaCloudConnected = useAppSelector((s) => s.elizaCloudConnected);
  const setActionNotice = useAppSelector((s) => s.setActionNotice);
  const { appName } = useBranding();
  const [agents, setAgents] = useState<CloudCompatAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  // The agent whose inline details panel is open (rename view). Null when the
  // panel is closed.
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  // The agent currently being woken (resumed + readiness-polled) before we
  // switch to it. Drives the "Waking <name>…" row state.
  const [wakingId, setWakingId] = useState<string | null>(null);
  const refreshRequestIdRef = useRef(0);
  const activeId = useMemo(() => activeCloudAgentId(), []);

  const cloudApiBase = getBootConfig().cloudApiBase || "https://eliza.app";

  const refresh = useCallback(async () => {
    const requestId = ++refreshRequestIdRef.current;
    const ownsRefreshState = () => refreshRequestIdRef.current === requestId;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await client.getCloudCompatAgents();
      if (!ownsRefreshState()) return;
      // A failed fetch is NOT an empty list — surface it so the user can retry
      // instead of seeing the indistinguishable "No cloud agents yet" copy.
      if (!res.success) {
        setLoadError(res.error || "Could not load your cloud agents.");
        return;
      }
      const list = [...res.data];
      list.sort((a, b) =>
        String(b.created_at).localeCompare(String(a.created_at)),
      );
      setAgents(list);
    } catch (err) {
      if (!ownsRefreshState()) return;
      setLoadError(
        err instanceof Error
          ? err.message
          : "Could not load your cloud agents.",
      );
    } finally {
      if (ownsRefreshState()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      // Strict Mode can clean up and restart this effect while the first
      // request is still live. Invalidating its ownership prevents that stale
      // result from updating either an unmounted view or the restarted effect.
      refreshRequestIdRef.current += 1;
    };
  }, [refresh]);

  const setLocalStatus = useCallback((agentId: string, status: string) => {
    setAgents((prev) =>
      prev.map((a) => (a.agent_id === agentId ? { ...a, status } : a)),
    );
  }, []);

  const bindAndReload = useCallback(
    (agentId: string, apiBase: string, label: string, notice?: string) => {
      const token = currentCloudToken();
      const persisted = createPersistedActiveServer({
        kind: "cloud",
        id: `cloud:${agentId}`,
        apiBase,
        ...(token ? { accessToken: token } : {}),
        label,
      });
      savePersistedActiveServer(persisted);
      // Mirror into the agent-profile registry so the switched-to cloud agent
      // shows up (and is marked Active) in "My Runtimes" — a bind here
      // otherwise only writes the active-server and leaves the runtime
      // switcher stale.
      upsertAndActivateAgentProfile({
        kind: "cloud",
        label,
        cloudAgentId: agentId,
        ...(persisted.apiBase !== undefined
          ? { apiBase: persisted.apiBase }
          : {}),
        ...(token ? { accessToken: token } : {}),
      });
      setActionNotice(
        notice ?? `Switched to ${label}. Reloading…`,
        "success",
        3000,
      );
      // Re-boot the web app so startup restore re-binds the client + chat to
      // the newly-selected agent (same path a returning user takes).
      setTimeout(() => window.location.reload(), 250);
    },
    [setActionNotice],
  );

  /**
   * Resume a non-running agent and gate entry on a short readiness poll, so we
   * only hand the user a live container. Resolves `true` once the agent reports
   * `running`; resolves `false` (with the failure surfaced) if the resume call
   * is rejected. Throws on timeout so the caller can decide whether to enter
   * anyway. Mirrors the delete-job poll loop.
   */
  const wakeUntilRunning = useCallback(
    async (agent: CloudCompatAgent) => {
      const res = await client.resumeCloudCompatAgent(agent.agent_id);
      if (!res.success) {
        return { ok: false as const, error: "Start failed" };
      }
      setLocalStatus(agent.agent_id, "resuming");
      const deadline = Date.now() + WAKE_POLL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((resolve) =>
          setTimeout(resolve, WAKE_POLL_INTERVAL_MS),
        );
        const statusRes = await client.getCloudCompatAgentStatus(
          agent.agent_id,
        );
        const status = statusRes.success
          ? statusRes.data.status.toLowerCase()
          : "";
        if (status) setLocalStatus(agent.agent_id, status);
        if (status === "running") return { ok: true as const };
        if (ERROR_STATES.has(status)) {
          return {
            ok: false as const,
            error: statusRes.data.suspendedReason || "Agent failed to start.",
          };
        }
      }
      throw new Error("Timed out waiting for the agent to start.");
    },
    [setLocalStatus],
  );

  const switchTo = useCallback(
    async (agent: CloudCompatAgent) => {
      if (agent.agent_id === activeId) return;
      const apiBase = resolveCloudAgentApiBase({
        bridgeUrl: agent.bridge_url,
        webUiUrl: agent.web_ui_url ?? agent.webUiUrl,
        agentId: agent.agent_id,
        cloudApiBase,
      });
      const label = agent.agent_name || "Eliza Cloud";
      const status = (agent.status || "").toLowerCase();
      if (ERROR_STATES.has(status)) {
        setActionNotice(
          agent.error_message ||
            `${label} failed to start. Resolve the failure before connecting.`,
          "error",
          5000,
        );
        return;
      }
      // A non-running agent has no live container to talk to — wake it and
      // wait for readiness before binding, so chat doesn't land on a 404.
      if (NON_RUNNING_STATES.has(status)) {
        setBusyId(agent.agent_id);
        setWakingId(agent.agent_id);
        setActionNotice(`Waking ${label}…`, "success", 3000);
        try {
          const outcome = await wakeUntilRunning(agent);
          if (!outcome.ok) {
            setActionNotice(outcome.error, "error", 4000);
            setBusyId(null);
            return;
          }
        } catch (err) {
          // Readiness timed out — surface it and let the user retry rather
          // than binding to a container that may still be coming up.
          setActionNotice(
            err instanceof Error ? err.message : "Failed to start agent.",
            "error",
            4000,
          );
          setBusyId(null);
          return;
        } finally {
          setWakingId(null);
        }
      } else {
        setBusyId(agent.agent_id);
      }
      try {
        // Probe with an isolated client. Mutating the shared singleton or the
        // persisted target before this succeeds would strand the whole shell
        // on a failed/unreachable agent after reload.
        const targetClient = new ElizaClient(apiBase, currentCloudToken());
        await targetClient.listConversations();
        bindAndReload(agent.agent_id, apiBase, label);
      } catch {
        setActionNotice(
          `Could not connect to ${label}. Your current agent is still active.`,
          "error",
          5000,
        );
      } finally {
        setBusyId(null);
      }
    },
    [activeId, cloudApiBase, bindAndReload, setActionNotice, wakeUntilRunning],
  );

  const createAgent = useCallback(async () => {
    const name = newName.trim();
    if (!name) {
      const message = "Give your agent a name first.";
      setCreateError(message);
      setActionNotice(message, "error", 3000);
      return;
    }
    const token = currentCloudToken();
    if (!token) {
      const message = "Sign in to Eliza Cloud before creating an agent.";
      setCreateError(message);
      setActionNotice(message, "error", 4000);
      return;
    }
    setCreateError(null);
    setCreating(true);
    try {
      const result = await client.selectOrProvisionCloudAgent({
        cloudApiBase,
        authToken: token,
        name,
        forceCreate: true,
        onProgress: () => {},
      });
      if (result.created !== true) {
        const message =
          "Eliza Cloud did not confirm that a new agent was created. No agent was opened; refresh your session and try again.";
        setCreateError(message);
        setActionNotice(message, "error", 7000);
        setCreating(false);
        return;
      }
      bindAndReload(result.agentId, result.apiBase, name);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create agent.";
      setCreateError(message);
      setActionNotice(message, "error", 4000);
      setCreating(false);
    }
  }, [newName, cloudApiBase, bindAndReload, setActionNotice]);

  /**
   * Poll a delete job until it reaches a terminal state. Resolves `true` on a
   * completed teardown, `false` (with the failure surfaced) when the job fails,
   * and throws on timeout so the caller can fall back to a refresh.
   */
  const waitForDeleteJob = useCallback(async (jobId: string) => {
    const deadline = Date.now() + DELETE_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const res = await client.getCloudCompatJobStatus(jobId);
      const status = res.success ? res.data.status : "failed";
      if (status === "completed") return { ok: true as const };
      if (status === "failed") {
        return {
          ok: false as const,
          error: res.data.error || "Agent delete failed.",
        };
      }
      await new Promise((resolve) =>
        setTimeout(resolve, DELETE_POLL_INTERVAL_MS),
      );
    }
    throw new Error("Timed out waiting for the agent to be deleted.");
  }, []);

  const deleteAgent = useCallback(
    async (agent: CloudCompatAgent) => {
      // Destructive + irreversible — tears down the container and its data.
      // Confirm first (matches the window.confirm pattern in the other settings
      // sections: wallet keys, vault profiles, remote plugin hosts).
      if (
        !window.confirm(
          `Delete "${agent.agent_name || agent.agent_id}"? This permanently removes the agent and its data and can't be undone.`,
        )
      ) {
        return;
      }
      setBusyId(agent.agent_id);
      try {
        const res = await client.deleteCloudCompatAgent(agent.agent_id);
        if (!res.success) {
          throw new Error(res.error || "Delete failed");
        }
        // A 202 async delete returns a jobId — the teardown may still fail
        // later, so poll the job and only drop the row once it actually
        // completes. A synchronous delete (no jobId) is already terminal.
        if (res.data.jobId) {
          const outcome = await waitForDeleteJob(res.data.jobId);
          if (!outcome.ok) {
            throw new Error(outcome.error);
          }
        }
        setAgents((prev) => prev.filter((a) => a.agent_id !== agent.agent_id));
        if (detailsId === agent.agent_id) setDetailsId(null);
        // Purge this agent's persisted pair credentials (durable pair key,
        // active-server token, profile accessTokens) so a deleted agent's
        // at-rest credentials are never re-adopted on a later boot. Scoped
        // to the deleted agent — other agents' credentials stay untouched.
        clearStalePairCredentialsForAgent(agent.agent_id);
        setActionNotice(`Deleted ${agent.agent_name}.`, "success", 3000);
      } catch (err) {
        setActionNotice(
          err instanceof Error ? err.message : "Failed to delete agent.",
          "error",
          4000,
        );
        // The teardown failed or timed out — re-sync so the row reflects the
        // real server state rather than a stale optimistic removal.
        void refresh();
      } finally {
        setBusyId(null);
      }
    },
    [setActionNotice, waitForDeleteJob, refresh, detailsId],
  );

  const openDetails = useCallback((agent: CloudCompatAgent) => {
    setDetailsId(agent.agent_id);
    setEditName(agent.agent_name || "");
  }, []);

  const saveRename = useCallback(
    async (agent: CloudCompatAgent) => {
      const name = editName.trim();
      if (!name || name === agent.agent_name) {
        setDetailsId(null);
        return;
      }
      setBusyId(agent.agent_id);
      try {
        const res = await client.updateCloudCompatAgent(agent.agent_id, {
          agentName: name,
        });
        if (!res.success) {
          throw new Error(res.error || "Rename failed");
        }
        setAgents((prev) =>
          prev.map((a) =>
            a.agent_id === agent.agent_id ? { ...a, agent_name: name } : a,
          ),
        );
        // If we just renamed the agent bound as the active cloud server, refresh
        // the persisted label so the switcher/header reflect the new name
        // without waiting for a re-bind (mirrors how switchTo/create set it).
        if (agent.agent_id === activeId) {
          const active = loadPersistedActiveServer();
          if (active?.kind === "cloud") {
            savePersistedActiveServer({ ...active, label: name });
          }
        }
        setActionNotice(`Renamed to ${name}.`, "success", 3000);
        setDetailsId(null);
      } catch (err) {
        setActionNotice(
          err instanceof Error ? err.message : "Failed to rename agent.",
          "error",
          4000,
        );
      } finally {
        setBusyId(null);
      }
    },
    [editName, activeId, setActionNotice],
  );

  /**
   * After a suspend/resume the row status lies (it shows the optimistic
   * transition) until a manual Refresh. Poll the agent's status a few times so
   * the row reconciles to the real server state as the daemon's job flips it.
   */
  const resyncStatus = useCallback(
    async (agentId: string) => {
      for (let attempt = 0; attempt < STATUS_POLL_ATTEMPTS; attempt++) {
        await new Promise((resolve) =>
          setTimeout(resolve, STATUS_POLL_INTERVAL_MS),
        );
        const res = await client.getCloudCompatAgentStatus(agentId);
        if (!res.success) continue;
        const status = res.data.status.toLowerCase();
        if (!status) continue;
        setLocalStatus(agentId, status);
        // Once the agent reaches a settled (non-transitional) state there is
        // nothing left to reconcile — stop polling early.
        if (status === "running" || NON_RUNNING_STATES.has(status)) return;
      }
    },
    [setLocalStatus],
  );

  const suspendAgent = useCallback(
    async (agent: CloudCompatAgent) => {
      setBusyId(agent.agent_id);
      try {
        const res = await client.suspendCloudCompatAgent(agent.agent_id);
        if (!res.success) {
          throw new Error("Shutdown failed");
        }
        // Async job — show the transition optimistically, then re-sync the row
        // from the server so it reconciles to "stopped" once the container is
        // actually stopped (no manual Refresh needed).
        setLocalStatus(agent.agent_id, "stopping");
        setActionNotice(
          `Shutting down ${agent.agent_name || "agent"}…`,
          "success",
          3000,
        );
        void resyncStatus(agent.agent_id);
      } catch (err) {
        setActionNotice(
          err instanceof Error ? err.message : "Failed to shut down agent.",
          "error",
          4000,
        );
      } finally {
        setBusyId(null);
      }
    },
    [setActionNotice, setLocalStatus, resyncStatus],
  );

  const resumeAgent = useCallback(
    async (agent: CloudCompatAgent) => {
      setBusyId(agent.agent_id);
      try {
        const res = await client.resumeCloudCompatAgent(agent.agent_id);
        if (!res.success) {
          throw new Error("Start failed");
        }
        setLocalStatus(agent.agent_id, "resuming");
        setActionNotice(
          `Starting ${agent.agent_name || "agent"}…`,
          "success",
          3000,
        );
        void resyncStatus(agent.agent_id);
      } catch (err) {
        setActionNotice(
          err instanceof Error ? err.message : "Failed to start agent.",
          "error",
          4000,
        );
      } finally {
        setBusyId(null);
      }
    },
    [setActionNotice, setLocalStatus, resyncStatus],
  );

  const hasToken = Boolean(currentCloudToken());
  if (!elizaCloudConnected && !hasToken) {
    return (
      <SettingsStack>
        <p className="text-sm text-muted-foreground">
          Connect to Eliza Cloud to manage your agents.
        </p>
      </SettingsStack>
    );
  }

  const activeAgent = agents.find((a) => a.agent_id === activeId) ?? null;
  const otherAgents = agents.filter((a) => a.agent_id !== activeId);

  return (
    <SettingsStack>
      {/* Active agent card */}
      <SettingsGroup
        title="Active Agent"
        footer="The cloud agent currently driving this device."
      >
        {activeAgent ? (
          <>
            <NuphyRow
              label={
                <span className="flex items-center gap-2">
                  <Circle
                    className={cn(
                      "h-2.5 w-2.5 shrink-0 fill-current",
                      statusDotClass(activeAgent.status),
                    )}
                    aria-hidden
                  />
                  <span className="truncate">
                    {activeAgent.agent_name || activeAgent.agent_id}
                  </span>
                </span>
              }
              description={shortId(activeAgent.agent_id)}
              control={
                <StatusBadge
                  tone={statusToneForState(activeAgent.status)}
                  label={agentLifecycleLabel(activeAgent.status)}
                />
              }
            />
            {otherAgents.length > 0 ? (
              <NuphyRow
                label={`${otherAgents.length} other ${otherAgents.length === 1 ? "agent" : "agents"} available`}
                control={
                  <NuphyButton
                    variant="secondary"
                    size="sm"
                    disabled={Boolean(busyId)}
                    onClick={() => void switchTo(otherAgents[0])}
                    title={`Switch to ${otherAgents[0].agent_name || otherAgents[0].agent_id}`}
                  >
                    Switch
                  </NuphyButton>
                }
              />
            ) : null}
          </>
        ) : (
          <NuphyRow label="No active cloud agent on this device." />
        )}
      </SettingsGroup>

      {/* Cloud agents list with lifecycle actions */}
      <SettingsGroup
        title="Your Cloud Agents"
        footer="Create, rename, start, pause, or delete cloud agents."
      >
        <NuphyRow
          label="Refresh"
          description="Reload the agent list from Eliza Cloud."
          control={
            <NuphyButton
              variant="ghost"
              size="sm"
              aria-label="Refresh agents"
              onClick={() => {
                void refresh();
              }}
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
            </NuphyButton>
          }
        />
        {loading ? (
          <NuphyRow
            label="Loading agents…"
            data-testid="cloud-agents-loading"
          />
        ) : loadError ? (
          <NuphyRow
            label={loadError}
            data-testid="cloud-agents-error"
            control={
              <NuphyButton
                variant="secondary"
                size="sm"
                data-testid="cloud-agents-error-retry"
                onClick={() => {
                  void refresh();
                }}
              >
                <RefreshCw className="mr-1 h-4 w-4" aria-hidden />
                Try again
              </NuphyButton>
            }
          />
        ) : agents.length === 0 ? (
          <NuphyRow
            label="No cloud agents yet"
            description="Create one to get started."
            data-testid="cloud-agents-empty"
          />
        ) : (
          agents.map((agent) => {
            const isActive = agent.agent_id === activeId;
            const busy = busyId === agent.agent_id;
            const waking = wakingId === agent.agent_id;
            const status = (agent.status || "").toLowerCase();
            const canSuspend = status === "running";
            const canResume = NON_RUNNING_STATES.has(status);
            const errored = ERROR_STATES.has(status);
            const errorMessage = errored ? agent.error_message?.trim() : null;
            const detailsOpen = detailsId === agent.agent_id;
            return (
              <NuphyRow
                key={agent.agent_id}
                data-testid={`cloud-agent-row-${agent.agent_id}`}
                label={
                  <span className="flex items-center gap-2">
                    <Circle
                      className={cn(
                        "h-2.5 w-2.5 shrink-0",
                        isActive
                          ? cn("fill-current", statusDotClass(status))
                          : "text-muted-foreground/50",
                      )}
                      aria-hidden
                    />
                    <span className="truncate">
                      {agent.agent_name || agent.agent_id}
                    </span>
                  </span>
                }
                description={
                  <span className="flex items-center gap-2">
                    {waking ? (
                      <StatusBadge
                        tone="warning"
                        pulse
                        label={`Waking ${agent.agent_name || agent.agent_id}…`}
                      />
                    ) : (
                      <StatusBadge
                        tone={
                          errored
                            ? "danger"
                            : statusToneForState(agent.status)
                        }
                        label={agentLifecycleLabel(agent.status)}
                      />
                    )}
                    {errorMessage ? (
                      <span className="truncate text-2xs text-destructive">
                        {errorMessage}
                      </span>
                    ) : null}
                  </span>
                }
                control={
                  <span className="flex items-center gap-1">
                    {isActive ? null : (
                      <NuphyButton
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() => void switchTo(agent)}
                      >
                        {waking ? "Waking…" : busy ? "Switching…" : "Use"}
                      </NuphyButton>
                    )}
                    {canSuspend ? (
                      <NuphyButton
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={`Suspend ${agent.agent_name || agent.agent_id}`}
                        title="Suspend"
                        onClick={() => void suspendAgent(agent)}
                      >
                        <Pause className="h-4 w-4" aria-hidden />
                      </NuphyButton>
                    ) : null}
                    {canResume ? (
                      <NuphyButton
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={`Wake ${agent.agent_name || agent.agent_id}`}
                        title="Wake"
                        onClick={() => void resumeAgent(agent)}
                      >
                        <Play className="h-4 w-4" aria-hidden />
                      </NuphyButton>
                    ) : null}
                    <NuphyButton
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-label={`Rename ${agent.agent_name || agent.agent_id}`}
                      title="Rename"
                      onClick={() => openDetails(agent)}
                    >
                      <Pencil className="h-4 w-4" aria-hidden />
                    </NuphyButton>
                    <NuphyButton
                      variant="ghost"
                      size="sm"
                      disabled={busy || isActive}
                      aria-label={`Delete ${agent.agent_name || agent.agent_id}`}
                      title="Delete"
                      onClick={() => deleteAgent(agent)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </NuphyButton>
                  </span>
                }
                below={
                  detailsOpen ? (
                    <div className="flex flex-col gap-3 pt-3">
                      <div className="flex flex-col gap-1.5">
                        <label
                          htmlFor={`agent-details-name-${agent.agent_id}`}
                          className="text-xs font-medium text-muted-foreground"
                        >
                          Name
                        </label>
                        <Input
                          id={`agent-details-name-${agent.agent_id}`}
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void saveRename(agent);
                            if (e.key === "Escape") setDetailsId(null);
                          }}
                          className="flex-1"
                          maxLength={AGENT_NAME_MAX_LENGTH}
                          disabled={busy}
                          autoFocus
                        />
                      </div>
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                        <dt className="text-muted-foreground">Created</dt>
                        <dd className="text-foreground">
                          {dateSlice(agent.created_at)}
                        </dd>
                        <dt className="text-muted-foreground">Status</dt>
                        <dd className="text-foreground">
                          {agentLifecycleLabel(agent.status)}
                        </dd>
                        <dt className="text-muted-foreground">Last active</dt>
                        <dd className="text-foreground">
                          {dateSlice(
                            agent.last_heartbeat_at ?? agent.updated_at,
                          )}
                        </dd>
                      </dl>
                      <div className="flex items-center gap-2">
                        <NuphyButton
                          variant="primary"
                          size="sm"
                          disabled={busy}
                          onClick={() => void saveRename(agent)}
                        >
                          {busy ? "Saving…" : "Save"}
                        </NuphyButton>
                        <NuphyButton
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => setDetailsId(null)}
                        >
                          Cancel
                        </NuphyButton>
                      </div>
                    </div>
                  ) : null
                }
              />
            );
          })
        )}

        {/* Create new agent — inline form toggled by the + New Agent button. */}
        {showCreate ? (
          <NuphyRow
            label="New agent"
            description={`Agent name (e.g. ${appName})`}
            control={
              <span className="flex items-center gap-2">
                <Input
                  value={newName}
                  onChange={(e) => {
                    setNewName(e.target.value);
                    setCreateError(null);
                  }}
                  placeholder={`Agent name (e.g. ${appName})`}
                  className="flex-1"
                  maxLength={AGENT_NAME_MAX_LENGTH}
                  disabled={creating}
                  aria-label="New agent name"
                  autoFocus
                />
                <NuphyButton
                  variant="primary"
                  size="sm"
                  disabled={creating}
                  onClick={() => {
                    void createAgent();
                  }}
                >
                  <Plus className="mr-1 h-4 w-4" aria-hidden />
                  {creating ? "Creating…" : "Create"}
                </NuphyButton>
                <NuphyButton
                  variant="ghost"
                  size="sm"
                  disabled={creating}
                  onClick={() => {
                    setShowCreate(false);
                    setNewName("");
                    setCreateError(null);
                  }}
                >
                  Cancel
                </NuphyButton>
              </span>
            }
          />
        ) : (
          <NuphyRow
            label="New agent"
            description="Create a new cloud agent."
            control={
              <NuphyButton
                variant="secondary"
                size="sm"
                onClick={() => setShowCreate(true)}
              >
                <Plus className="mr-1 h-4 w-4" aria-hidden />
                New Agent
              </NuphyButton>
            }
          />
        )}
        {createError ? (
          <NuphyRow
            label={createError}
            data-testid="cloud-agent-create-error"
          />
        ) : null}
      </SettingsGroup>
    </SettingsStack>
  );
}
