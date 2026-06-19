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
import { resolveCloudAgentApiBase } from "../../api/client-cloud";
import type { CloudCompatAgent } from "../../api/client-types-cloud";
import { getBootConfig } from "../../config/boot-config";
import { useApp } from "../../state";
import {
  createPersistedActiveServer,
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "../../state/persistence";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";

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

/** The cloud access token for the current session (persisted, or runtime). */
function currentCloudToken(): string {
  const persisted = loadPersistedActiveServer();
  if (persisted?.kind === "cloud" && persisted.accessToken) {
    return persisted.accessToken;
  }
  const runtime = (globalThis as Record<string, unknown>)
    .__ELIZA_CLOUD_AUTH_TOKEN__;
  return typeof runtime === "string" ? runtime : "";
}

/**
 * Eliza Cloud agent manager. Lists the signed-in user's cloud agents and lets
 * them switch the active agent, create + name a new one, rename one, or delete
 * one — the in-app counterpart to the cloud web dashboard.
 */
export function CloudAgentsSection() {
  const { elizaCloudConnected, setActionNotice } = useApp();
  const [agents, setAgents] = useState<CloudCompatAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const activeId = useMemo(() => activeCloudAgentId(), []);

  const cloudApiBase =
    getBootConfig().cloudApiBase || "https://www.elizacloud.ai";

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await client.getCloudCompatAgents();
      const list = res.success ? res.data : [];
      list.sort((a, b) =>
        String(b.created_at).localeCompare(String(a.created_at)),
      );
      setAgents(list);
    } catch {
      setAgents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const bindAndReload = useCallback(
    (agentId: string, apiBase: string, label: string) => {
      const token = currentCloudToken();
      savePersistedActiveServer(
        createPersistedActiveServer({
          kind: "cloud",
          id: `cloud:${agentId}`,
          apiBase,
          ...(token ? { accessToken: token } : {}),
          label,
        }),
      );
      setActionNotice(`Switched to ${label}. Reloading…`, "success", 3000);
      // Re-boot the web app so startup restore re-binds the client + chat to
      // the newly-selected agent (same path a returning user takes).
      setTimeout(() => window.location.reload(), 250);
    },
    [setActionNotice],
  );

  const switchTo = useCallback(
    (agent: CloudCompatAgent) => {
      if (agent.agent_id === activeId) return;
      setBusyId(agent.agent_id);
      const apiBase = resolveCloudAgentApiBase({
        bridgeUrl: agent.bridge_url,
        webUiUrl: agent.web_ui_url ?? agent.webUiUrl,
        agentId: agent.agent_id,
        cloudApiBase,
      });
      bindAndReload(agent.agent_id, apiBase, agent.agent_name || "Eliza Cloud");
    },
    [activeId, cloudApiBase, bindAndReload],
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

  const deleteAgent = useCallback(
    async (agent: CloudCompatAgent) => {
      setBusyId(agent.agent_id);
      try {
        const res = await client.deleteCloudCompatAgent(agent.agent_id);
        if (!res.success) {
          throw new Error("Delete failed");
        }
        setAgents((prev) => prev.filter((a) => a.agent_id !== agent.agent_id));
        setActionNotice(`Deleted ${agent.agent_name}.`, "success", 3000);
      } catch (err) {
        setActionNotice(
          err instanceof Error ? err.message : "Failed to delete agent.",
          "error",
          4000,
        );
      } finally {
        setBusyId(null);
      }
    },
    [setActionNotice],
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
    [editName, setActionNotice],
  );

  const setLocalStatus = useCallback((agentId: string, status: string) => {
    setAgents((prev) =>
      prev.map((a) => (a.agent_id === agentId ? { ...a, status } : a)),
    );
  }, []);

  const suspendAgent = useCallback(
    async (agent: CloudCompatAgent) => {
      setBusyId(agent.agent_id);
      try {
        const res = await client.suspendCloudCompatAgent(agent.agent_id);
        if (!res.success) {
          throw new Error("Shutdown failed");
        }
        // Async job — show the transition optimistically; a Refresh reflects the
        // daemon flipping it to "stopped" once the container is actually stopped.
        setLocalStatus(agent.agent_id, "stopping");
        setActionNotice(
          `Shutting down ${agent.agent_name || "agent"}…`,
          "success",
          3000,
        );
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
    [setActionNotice, setLocalStatus],
  );

  const resumeAgent = useCallback(
    async (agent: CloudCompatAgent) => {
      setBusyId(agent.agent_id);
      try {
        const res = await client.resumeCloudCompatAgent(agent.agent_id);
        if (!res.success) {
          throw new Error("Start failed");
        }
        setLocalStatus(agent.agent_id, "provisioning");
        setActionNotice(
          `Starting ${agent.agent_name || "agent"}…`,
          "success",
          3000,
        );
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
    [setActionNotice, setLocalStatus],
  );

  const hasToken = Boolean(currentCloudToken());
  if (!elizaCloudConnected && !hasToken) {
    return (
      <p className="text-sm text-txt-muted">
        Sign in to Eliza Cloud (AI Model settings) to manage your cloud agents.
      </p>
    );
  }

  return (
    <SettingsStack>
      <SettingsGroup
        title="Your cloud agents"
        description="Switch the active agent, shut one down (or start it back up), rename, or remove one you no longer need."
      >
        {loading ? (
          <p className="px-4 py-3 text-sm text-txt-muted">Loading agents…</p>
        ) : agents.length === 0 ? (
          <p className="px-4 py-3 text-sm text-txt-muted">
            No cloud agents yet — create your first one below.
          </p>
        ) : (
          agents.map((agent) => {
            const isActive = agent.agent_id === activeId;
            const busy = busyId === agent.agent_id;
            const status = (agent.status || "").toLowerCase();
            const canSuspend = status === "running";
            const canResume =
              status === "stopped" ||
              status === "sleeping" ||
              status === "suspended";
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
                    disabled={busy}
                    autoFocus
                  />
                  <Button
                    variant="default"
                    size="sm"
                    disabled={busy}
                    onClick={() => void saveRename(agent)}
                  >
                    {busy ? "Saving…" : "Save"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
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
                description={isActive ? "Active · this device" : agent.status}
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
                        onClick={() => switchTo(agent)}
                      >
                        {busy ? "Switching…" : "Use"}
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

      <SettingsGroup
        title="Create a new agent"
        description="Spin up a fresh cloud agent and switch to it."
      >
        <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Agent name (e.g. Milady)"
            className="flex-1"
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
