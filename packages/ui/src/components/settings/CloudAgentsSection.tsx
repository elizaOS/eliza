import {
  Bot,
  Check,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { client } from "../../api";
import {
  getCloudAuthToken,
  resolveCloudAgentApiBase,
} from "../../api/client-cloud";
import type { CloudCompatAgent } from "../../api/client-types-cloud";
import { getBootConfig } from "../../config/boot-config";
import { useBranding } from "../../config/branding";
import { useAppSelector } from "../../state";
import { upsertAndActivateAgentProfile } from "../../state/agent-profiles";
import {
  createPersistedActiveServer,
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "../../state/persistence";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { StatusBadge } from "../ui/status-badge";
import {
  agentLifecycleLabel,
  statusToneForState,
} from "../ui/status-badge.helpers";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";

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
  // Canonical Steward-first resolution (matches getCloudAuthToken: Steward JWT →
  // runtime global → client), then fall back to the persisted active-server
  // token for sessions without a Steward session. The old order read the
  // persisted token first and skipped the Steward JWT entirely, which could send
  // a stale/missing token from the agent manager.
  const canonical = getCloudAuthToken();
  if (canonical) return canonical;
  const persisted = loadPersistedActiveServer();
  if (persisted?.kind === "cloud" && persisted.accessToken) {
    return persisted.accessToken;
  }
  return "";
}

/**
 * Eliza Cloud agent manager. Lists the signed-in user's cloud agents and lets
 * them switch the active agent, create + name a new one, rename one, or delete
 * one — the in-app counterpart to the cloud web dashboard.
 */
export function CloudAgentsSection() {
  const elizaCloudConnected = useAppSelector((s) => s.elizaCloudConnected);
  const setActionNotice = useAppSelector((s) => s.setActionNotice);
  const { appName } = useBranding();
  const [agents, setAgents] = useState<CloudCompatAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  // The agent currently being woken (resumed + readiness-polled) before we
  // switch to it. Drives the "Waking <name>…" row state.
  const [wakingId, setWakingId] = useState<string | null>(null);
  const activeId = useMemo(() => activeCloudAgentId(), []);

  const cloudApiBase = getBootConfig().cloudApiBase || "https://elizacloud.ai";

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await client.getCloudCompatAgents();
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
      setLoadError(
        err instanceof Error
          ? err.message
          : "Could not load your cloud agents.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setLocalStatus = useCallback((agentId: string, status: string) => {
    setAgents((prev) =>
      prev.map((a) => (a.agent_id === agentId ? { ...a, status } : a)),
    );
  }, []);

  const bindAndReload = useCallback(
    (agentId: string, apiBase: string, label: string) => {
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
      // shows up (and is marked Active) in "My Runtimes" — a bind here otherwise
      // only writes the active-server and leaves the runtime switcher stale.
      upsertAndActivateAgentProfile({
        kind: "cloud",
        label,
        ...(persisted.apiBase !== undefined
          ? { apiBase: persisted.apiBase }
          : {}),
        ...(token ? { accessToken: token } : {}),
      });
      setActionNotice(`Switched to ${label}. Reloading…`, "success", 3000);
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
          return;
        } finally {
          setBusyId(null);
          setWakingId(null);
        }
      } else {
        setBusyId(agent.agent_id);
      }
      bindAndReload(agent.agent_id, apiBase, label);
    },
    [activeId, cloudApiBase, bindAndReload, setActionNotice, wakeUntilRunning],
  );

  const createAgent = useCallback(async () => {
    const name = newName.trim();
    if (!name) {
      setActionNotice("Give your agent a name first.", "error", 3000);
      return;
    }
    const token = currentCloudToken();
    if (!token) {
      setActionNotice(
        "Sign in to Eliza Cloud before creating an agent.",
        "error",
        4000,
      );
      return;
    }
    setCreating(true);
    try {
      const result = await client.selectOrProvisionCloudAgent({
        cloudApiBase,
        authToken: token,
        name,
        forceCreate: true,
        onProgress: () => {},
      });
      bindAndReload(result.agentId, result.apiBase, name);
    } catch (err) {
      setActionNotice(
        err instanceof Error ? err.message : "Failed to create agent.",
        "error",
        4000,
      );
      setCreating(false);
    }
  }, [newName, cloudApiBase, bindAndReload, setActionNotice]);

  /**
   * Poll a delete job until it reaches a terminal state. Resolves `true` on a
   * completed teardown, `false` (with the failure surfaced) when the job
   * fails, and throws on timeout so the caller can fall back to a refresh.
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
    [setActionNotice, waitForDeleteJob, refresh],
  );

  const startRename = useCallback((agent: CloudCompatAgent) => {
    setEditingId(agent.agent_id);
    setEditName(agent.agent_name || "");
  }, []);

  const saveRename = useCallback(
    async (agent: CloudCompatAgent) => {
      const name = editName.trim();
      if (!name || name === agent.agent_name) {
        setEditingId(null);
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
        // the persisted label so the switcher/header reflect the new name without
        // waiting for a re-bind (mirrors how switchTo/create set the label).
        if (agent.agent_id === activeId) {
          const active = loadPersistedActiveServer();
          if (active?.kind === "cloud") {
            savePersistedActiveServer({ ...active, label: name });
          }
        }
        setActionNotice(`Renamed to ${name}.`, "success", 3000);
        setEditingId(null);
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
      <p className="text-sm text-txt-muted">
        Sign in to Eliza Cloud to manage your cloud agents.
      </p>
    );
  }

  return (
    <SettingsStack>
      <SettingsGroup title="Your cloud agents">
        {loading ? (
          <div
            className="flex items-center gap-2 px-4 py-3 text-sm text-txt-muted"
            data-testid="cloud-agents-loading"
          >
            <RefreshCw className="h-4 w-4 animate-spin" aria-hidden />
            Loading agents…
          </div>
        ) : loadError ? (
          <div
            className="flex flex-col gap-2 px-4 py-3"
            data-testid="cloud-agents-error"
          >
            <p className="text-sm text-destructive">{loadError}</p>
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              data-testid="cloud-agents-error-retry"
              onClick={() => {
                void refresh();
              }}
            >
              <RefreshCw className="mr-1 h-4 w-4" aria-hidden />
              Try again
            </Button>
          </div>
        ) : agents.length === 0 ? (
          <p
            className="px-4 py-3 text-sm text-txt-muted"
            data-testid="cloud-agents-empty"
          >
            No cloud agents yet — create your first one below.
          </p>
        ) : (
          agents.map((agent) => {
            const isActive = agent.agent_id === activeId;
            const busy = busyId === agent.agent_id;
            // Show "Waking…" for a locally-driven resume (wakingId). The
            // first-run shared→dedicated handoff no longer surfaces here: it
            // re-points the live client SILENTLY (no row-level "waking" state),
            // and its in-flight progress is shown by the chat-shell handoff
            // toast (CloudHandoffBanner), not this Settings row.
            const waking = wakingId === agent.agent_id;
            const status = (agent.status || "").toLowerCase();
            const canSuspend = status === "running";
            const canResume = NON_RUNNING_STATES.has(status);
            // A broken agent: surface WHY (error_message) instead of a bare
            // status, so the user can tell a transient stop from a real fault.
            const errored = ERROR_STATES.has(status);
            const errorMessage = errored ? agent.error_message?.trim() : null;
            if (editingId === agent.agent_id) {
              return (
                <div
                  key={agent.agent_id}
                  className="flex items-center gap-2 px-4 py-3"
                >
                  <Bot
                    className="h-5 w-5 shrink-0 text-txt-muted"
                    aria-hidden
                  />
                  <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveRename(agent);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    className="flex-1"
                    aria-label="Agent name"
                    data-testid={`cloud-agent-rename-input-${agent.agent_id}`}
                    maxLength={AGENT_NAME_MAX_LENGTH}
                    disabled={busy}
                    autoFocus
                  />
                  <Button
                    variant="default"
                    size="sm"
                    disabled={busy}
                    data-testid={`cloud-agent-rename-save-${agent.agent_id}`}
                    onClick={() => void saveRename(agent)}
                  >
                    {busy ? "Saving…" : "Save"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    data-testid={`cloud-agent-rename-cancel-${agent.agent_id}`}
                    onClick={() => setEditingId(null)}
                  >
                    Cancel
                  </Button>
                </div>
              );
            }
            return (
              <SettingsRow
                key={agent.agent_id}
                icon={Bot}
                label={agent.agent_name || agent.agent_id}
                description={
                  <span className="flex flex-col gap-1">
                    <span className="inline-flex items-center gap-2">
                      {isActive ? "Active · this device" : null}
                      {waking ? (
                        <StatusBadge
                          tone="warning"
                          pulse
                          label={`Waking ${agent.agent_name || agent.agent_id}…`}
                          data-testid={`cloud-agent-status-${agent.agent_id}`}
                        />
                      ) : (
                        <StatusBadge
                          tone={
                            errored
                              ? "danger"
                              : statusToneForState(agent.status)
                          }
                          label={agentLifecycleLabel(agent.status)}
                          data-testid={`cloud-agent-status-${agent.agent_id}`}
                        />
                      )}
                    </span>
                    {errorMessage ? (
                      <span
                        className="text-2xs text-destructive"
                        data-testid={`cloud-agent-error-${agent.agent_id}`}
                      >
                        {errorMessage}
                      </span>
                    ) : null}
                  </span>
                }
                active={isActive}
                trailing={
                  <div className="flex items-center gap-2">
                    {isActive ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-accent">
                        <Check className="h-4 w-4" aria-hidden />
                        Active
                      </span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => void switchTo(agent)}
                      >
                        {waking ? "Waking…" : busy ? "Switching…" : "Use"}
                      </Button>
                    )}
                    {canSuspend && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={`Shut down ${agent.agent_name || agent.agent_id}`}
                        title="Shut down"
                        onClick={() => void suspendAgent(agent)}
                      >
                        <Power className="h-4 w-4" aria-hidden />
                      </Button>
                    )}
                    {canResume && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={`Start ${agent.agent_name || agent.agent_id}`}
                        title="Start"
                        onClick={() => void resumeAgent(agent)}
                      >
                        <Play className="h-4 w-4" aria-hidden />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-label={`Rename ${agent.agent_name || agent.agent_id}`}
                      data-testid={`cloud-agent-rename-${agent.agent_id}`}
                      onClick={() => startRename(agent)}
                    >
                      <Pencil className="h-4 w-4" aria-hidden />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || isActive}
                      aria-label={`Delete ${agent.agent_name || agent.agent_id}`}
                      onClick={() => deleteAgent(agent)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  </div>
                }
              />
            );
          })
        )}
        <SettingsRow
          icon={RefreshCw}
          label="Refresh"
          onClick={() => {
            void refresh();
          }}
        />
      </SettingsGroup>

      <SettingsGroup title="Create a new agent">
        <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={`Agent name (e.g. ${appName})`}
            className="flex-1"
            maxLength={AGENT_NAME_MAX_LENGTH}
            disabled={creating}
          />
          <Button
            variant="default"
            size="sm"
            disabled={creating}
            onClick={() => {
              void createAgent();
            }}
          >
            <Plus className="mr-1 h-4 w-4" aria-hidden />
            {creating ? "Creating…" : "Create"}
          </Button>
        </div>
      </SettingsGroup>
    </SettingsStack>
  );
}
