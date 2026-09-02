/**
 * Owns the shared cloud-agent management lifecycle used by both settings presentations.
 * Callers provide the management-token boundary and retain their own rendering contracts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client, ElizaClient } from "../../api";
import { resolveCloudAgentApiBase } from "../../api/client-cloud";
import type { CloudCompatAgent } from "../../api/client-types-cloud";
import { getBootConfig } from "../../config/boot-config";
import { useBranding } from "../../config/branding";
import { useAppSelector } from "../../state";
import { upsertAndActivateAgentProfile } from "../../state/agent-profiles";
import { clearStalePairCredentialsForAgent } from "../../state/cloud-pair-token";
import {
  createPersistedActiveServer,
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "../../state/persistence";

const DELETE_POLL_TIMEOUT_MS = 60_000;
const DELETE_POLL_INTERVAL_MS = 1_500;
const STATUS_POLL_INTERVAL_MS = 3_000;
const STATUS_POLL_ATTEMPTS = 5;
const WAKE_POLL_TIMEOUT_MS = 60_000;
const WAKE_POLL_INTERVAL_MS = 2_000;
const NON_RUNNING_STATES = new Set(["stopped", "sleeping", "suspended"]);
const ERROR_STATES = new Set(["error", "failed"]);

function activeCloudAgentId(): string | null {
  const active = loadPersistedActiveServer();
  if (active?.kind !== "cloud") return null;
  const id = active.id?.startsWith("cloud:")
    ? active.id.slice("cloud:".length)
    : "";
  return id && !id.includes("/") ? id : null;
}

export function useCloudAgentManagement(getManagementToken: () => string) {
  const elizaCloudConnected = useAppSelector((s) => s.elizaCloudConnected);
  const setActionNotice = useAppSelector((s) => s.setActionNotice);
  const { appName } = useBranding();
  const [agents, setAgents] = useState<CloudCompatAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
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
      const token = getManagementToken();
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
    [setActionNotice, getManagementToken],
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
        const targetClient = new ElizaClient(apiBase, getManagementToken());
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
    [
      activeId,
      cloudApiBase,
      bindAndReload,
      setActionNotice,
      wakeUntilRunning,
      getManagementToken,
    ],
  );

  const createAgent = useCallback(async () => {
    const name = newName.trim();
    if (!name) {
      const message = "Give your agent a name first.";
      setCreateError(message);
      setActionNotice(message, "error", 3000);
      return;
    }
    const token = getManagementToken();
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
      } else {
        bindAndReload(result.agentId, result.apiBase, name);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create agent.";
      setCreateError(message);
      setActionNotice(message, "error", 4000);
      setCreating(false);
    }
  }, [
    newName,
    cloudApiBase,
    bindAndReload,
    setActionNotice,
    getManagementToken,
  ]);

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
  return {
    appName,
    elizaCloudConnected,
    agents,
    loading,
    loadError,
    busyId,
    creating,
    newName,
    setNewName,
    createError,
    setCreateError,
    editingId,
    setEditingId,
    editName,
    setEditName,
    wakingId,
    activeId,
    refresh,
    switchTo,
    createAgent,
    deleteAgent,
    startRename,
    saveRename,
    suspendAgent,
    resumeAgent,
  };
}
