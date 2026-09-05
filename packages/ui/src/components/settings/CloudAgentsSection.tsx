/**
 * Cloud-agents management panel for the Cloud settings group. Lists the
 * signed-in user's Eliza Cloud agents and drives their lifecycle — create,
 * rename, suspend/resume (with status polling), delete (with job polling), and
 * "wake then switch to" — through the typed cloud API client. The active cloud
 * server is tracked in persisted App state so the current agent is highlighted.
 */

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
import { getCloudAuthToken } from "../../api/client-cloud";
import { loadPersistedActiveServer } from "../../state/persistence";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { StatusBadge } from "../ui/status-badge";
import {
  agentLifecycleLabel,
  statusToneForState,
} from "../ui/status-badge.helpers";
import { useCloudAgentManagement } from "./cloud-agent-management";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";

/** Maximum length accepted for a (new or edited) cloud agent name. */
const AGENT_NAME_MAX_LENGTH = 60;
/** How long to poll a delete job before giving up and forcing a refresh. */
const _DELETE_POLL_TIMEOUT_MS = 60_000;
/** Delay between delete-job poll attempts. */
const _DELETE_POLL_INTERVAL_MS = 1_500;
/** Delay between status re-sync poll attempts after a suspend/resume. */
const _STATUS_POLL_INTERVAL_MS = 3_000;
/** How many times to poll an agent's status after a suspend/resume before
 * giving up (the daemon's job should have flipped the status by then). */
const _STATUS_POLL_ATTEMPTS = 5;
/** How long to poll a waking agent before entering anyway with a warning. */
const _WAKE_POLL_TIMEOUT_MS = 60_000;
/** Delay between waking-readiness poll attempts. */
const _WAKE_POLL_INTERVAL_MS = 2_000;

/** Statuses that mean an agent is not running and must be woken before use. */
const NON_RUNNING_STATES = new Set(["stopped", "sleeping", "suspended"]);

/** Statuses that indicate the agent failed / is in an error state. */
const ERROR_STATES = new Set(["error", "failed"]);

/** The agent id currently bound as the active cloud server, if any. */
function _activeCloudAgentId(): string | null {
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

/**
 * Eliza Cloud agent manager. Lists the signed-in user's cloud agents and lets
 * them switch the active agent, create + name a new one, rename one, or delete
 * one — the in-app counterpart to the cloud web dashboard.
 */
export function CloudAgentsSection() {
  const {
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
  } = useCloudAgentManagement(currentCloudToken);
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
            <RefreshCw className="size-4 animate-spin" aria-hidden />
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
              <RefreshCw className="mr-1  size-4" aria-hidden />
              Try again
            </Button>
          </div>
        ) : agents.length === 0 ? (
          <p
            className="px-4 py-3 text-sm text-txt-muted"
            data-testid="cloud-agents-empty"
          >
            No cloud agents yet. Create your first one below.
          </p>
        ) : (
          agents.map((agent) => {
            const isActive = agent.agent_id === activeId;
            const busy = busyId === agent.agent_id;
            // Show "Waking…" for a locally-driven resume (wakingId). The
            // first-run shared→dedicated handoff no longer surfaces here: it
            // re-points the live client SILENTLY (no row-level "waking" state),
            // and its in-flight progress is shown by the in-chat boot-recovery
            // card and the home-grid agent-provisioning tile, not this
            // Settings row.
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
                  <Bot className="size-5 shrink-0 text-txt-muted" aria-hidden />
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
                        <Check className="size-4" aria-hidden />
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
                        <Power className="size-4" aria-hidden />
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
                        <Play className="size-4" aria-hidden />
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
                      <Pencil className="size-4" aria-hidden />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || isActive}
                      aria-label={`Delete ${agent.agent_name || agent.agent_id}`}
                      onClick={() => deleteAgent(agent)}
                    >
                      <Trash2 className="size-4" aria-hidden />
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
            onChange={(e) => {
              setNewName(e.target.value);
              setCreateError(null);
            }}
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
            <Plus className="mr-1 size-4" aria-hidden />
            {creating ? "Creating…" : "Create"}
          </Button>
        </div>
        {createError && (
          <p
            role="alert"
            data-testid="cloud-agent-create-error"
            className="px-4 pb-3 text-sm text-destructive"
          >
            {createError}
          </p>
        )}
      </SettingsGroup>
    </SettingsStack>
  );
}
