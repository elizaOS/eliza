/**
 * Cloud agent management section for the cloud-only settings panel. Lists the
 * signed-in user's Eliza Cloud agents and drives their lifecycle — create,
 * rename, suspend/resume (with status polling), delete (with job polling), and
 * "wake then switch to" — through the typed cloud API client. The active cloud
 * server is tracked in persisted App state so the current agent is highlighted
 * at the top and in each row.
 */

import {
  Circle,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { cn } from "../../../../lib/utils";
import { loadPersistedActiveServer } from "../../../../state/persistence";
import { Button } from "../../../ui/button";
import { Input } from "../../../ui/input";
import { StatusBadge } from "../../../ui/status-badge";
import {
  agentLifecycleLabel,
  statusToneForState,
} from "../../../ui/status-badge.helpers";
import { useCloudAgentManagement } from "../cloud-agent-management-pattern";
import { currentCloudManagementToken } from "../cloud-management-auth";
import {
  CloudRow,
  SettingsGroup,
  SettingsStack,
} from "../cloud-settings-primitives";

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
  return currentCloudManagementToken();
}

/** Tailwind text color for a status dot: green/amber/red/muted by lifecycle. */
function statusDotClass(status: string): string {
  switch (status.toLowerCase()) {
    case "running":
    case "ready":
      return "text-status-success";
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
    editingId: detailsId,
    setEditingId: setDetailsId,
    editName,
    setEditName,
    wakingId,
    activeId,
    refresh,
    switchTo,
    createAgent,
    deleteAgent,
    startRename: openDetails,
    saveRename,
    suspendAgent,
    resumeAgent,
  } = useCloudAgentManagement(currentCloudToken);
  const [showCreate, setShowCreate] = useState(false);
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
            <CloudRow
              label={
                <span className="flex items-center gap-2">
                  <Circle
                    className={cn(
                      "size-2.5 shrink-0 fill-current",
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
              <CloudRow
                label={`${otherAgents.length} other ${otherAgents.length === 1 ? "agent" : "agents"} available`}
                control={
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={Boolean(busyId)}
                    onClick={() => void switchTo(otherAgents[0])}
                    title={`Switch to ${otherAgents[0].agent_name || otherAgents[0].agent_id}`}
                  >
                    Switch
                  </Button>
                }
              />
            ) : null}
          </>
        ) : (
          <CloudRow label="No active cloud agent on this device." />
        )}
      </SettingsGroup>

      {/* Cloud agents list with lifecycle actions */}
      <SettingsGroup
        title="Your Cloud Agents"
        footer="Create, rename, start, pause, or delete cloud agents."
      >
        <CloudRow
          label="Refresh"
          description="Reload the agent list from Eliza Cloud."
          control={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh agents"
              onClick={() => {
                void refresh();
              }}
            >
              <RefreshCw className="size-4" aria-hidden />
            </Button>
          }
        />
        {loading ? (
          <CloudRow
            label="Loading agents…"
            data-testid="cloud-agents-loading"
          />
        ) : loadError ? (
          <CloudRow
            label={loadError}
            data-testid="cloud-agents-error"
            control={
              <Button
                variant="outline"
                size="sm"
                data-testid="cloud-agents-error-retry"
                onClick={() => {
                  void refresh();
                }}
              >
                <RefreshCw className="mr-1  size-4" aria-hidden />
                Try again
              </Button>
            }
          />
        ) : agents.length === 0 ? (
          <CloudRow
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
              <CloudRow
                key={agent.agent_id}
                data-testid={`cloud-agent-row-${agent.agent_id}`}
                label={
                  <span className="flex items-center gap-2">
                    <Circle
                      className={cn(
                        "size-2.5 shrink-0",
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
                          errored ? "danger" : statusToneForState(agent.status)
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
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => void switchTo(agent)}
                      >
                        {waking ? "Waking…" : busy ? "Switching…" : "Use"}
                      </Button>
                    )}
                    {canSuspend ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy}
                        aria-label={`Suspend ${agent.agent_name || agent.agent_id}`}
                        title="Suspend"
                        onClick={() => void suspendAgent(agent)}
                      >
                        <Pause className="size-4" aria-hidden />
                      </Button>
                    ) : null}
                    {canResume ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy}
                        aria-label={`Wake ${agent.agent_name || agent.agent_id}`}
                        title="Wake"
                        onClick={() => void resumeAgent(agent)}
                      >
                        <Play className="size-4" aria-hidden />
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy}
                      aria-label={`Rename ${agent.agent_name || agent.agent_id}`}
                      title="Rename"
                      onClick={() => openDetails(agent)}
                    >
                      <Pencil className="size-4" aria-hidden />
                    </Button>
                    <Button
                      variant="surfaceDestructive"
                      size="icon-sm"
                      disabled={busy || isActive}
                      aria-label={`Delete ${agent.agent_name || agent.agent_id}`}
                      title="Delete"
                      onClick={() => deleteAgent(agent)}
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
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
                          onClick={() => setDetailsId(null)}
                        >
                          Cancel
                        </Button>
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
          <CloudRow
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
                <Button
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
                </Button>
              </span>
            }
          />
        ) : (
          <CloudRow
            label="New agent"
            description="Create a new cloud agent."
            control={
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowCreate(true)}
              >
                <Plus className="mr-1 size-4" aria-hidden />
                New Agent
              </Button>
            }
          />
        )}
        {createError ? (
          <CloudRow
            label={createError}
            data-testid="cloud-agent-create-error"
          />
        ) : null}
      </SettingsGroup>
    </SettingsStack>
  );
}
