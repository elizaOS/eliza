import {
  AppWorkspaceChrome,
  Button,
  type CloudOAuthConnection,
  client,
  isAppWindowRoute,
  isWebPlatform,
  openExternalUrl,
  PagePanel,
  useApp,
  useMediaQuery,
} from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { Power, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LIFEOPS_GITHUB_CALLBACK_EVENT,
  type LifeOpsGithubCallbackDetail,
} from "../events/index.js";
import { useLifeOpsAppState } from "../hooks/useLifeOpsAppState.js";
import { useLifeOpsSection } from "../hooks/useLifeOpsSection.js";
import {
  consumeQueuedLifeOpsGithubCallback,
  dispatchLifeOpsGithubCallbackFromWindowMessage,
  drainLifeOpsGithubCallbacks,
} from "../platform/lifeops-github.js";
import { LifeOpsXPanel } from "./LifeOpsOperationalPanels";
import type { ManagedAgentGithubEntry } from "./LifeOpsPageSections";
import {
  lifeOpsClient,
  loadLifeOpsTuiState,
} from "./LifeOpsPageView.interact.js";
import { LifeOpsSectionContent } from "./LifeOpsSectionContent.js";
import { useLifeOpsSelection } from "./LifeOpsSelectionContext.helpers.js";
import { LifeOpsSelectionProvider } from "./LifeOpsSelectionContext.js";
import { LifeOpsSettingsSection } from "./LifeOpsSettingsSection";
import { clearLifeOpsSetupGateDismissed } from "./LifeOpsSetupGate.helpers.js";
import { LifeOpsWorkspaceShell } from "./LifeOpsWorkspaceShell.js";
import { MessagingConnectorGrid } from "./MessagingConnectorCards";

type EnablePromptProps = {
  loading: boolean;
  onEnable: () => void;
  t: (key: string, opts?: { defaultValue?: string }) => string;
};

function EnablePrompt({ loading, onEnable, t }: EnablePromptProps) {
  const enableLabel = t("lifeopspage.enable", {
    defaultValue: "Enable LifeOps",
  });
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "action-enable",
    role: "button",
    label: enableLabel,
    group: "lifeops-app",
    description: "Enable LifeOps for the agent",
  });
  return (
    <PagePanel variant="surface">
      <div className="flex flex-col gap-3 p-4">
        <div className="text-sm font-semibold text-txt">
          {t("lifeopspage.enableTitle", {
            defaultValue: "Enable LifeOps",
          })}
        </div>
        <div className="text-xs text-muted">
          {t("lifeopspage.enableBody", {
            defaultValue:
              "Turn on LifeOps to let the agent manage your schedule, inbox, and calendar.",
          })}
        </div>
        <Button
          ref={ref}
          onClick={onEnable}
          disabled={loading}
          className="self-start"
          aria-label={enableLabel}
          {...agentProps}
        >
          {loading
            ? t("lifeopspage.enabling", { defaultValue: "Enabling" })
            : enableLabel}
        </Button>
      </div>
    </PagePanel>
  );
}

const LIFEOPS_GITHUB_COMPLETE_PATH = "/api/v1/eliza/lifeops/github-complete";
const LIFEOPS_GITHUB_RETURN_URL = "elizaos://lifeops";

type TranslateFn = (
  key: string,
  options?: Record<string, unknown> & { defaultValue?: string },
) => string;

const LIFEOPS_COMPACT_LAYOUT_MEDIA_QUERY = "(max-width: 1023px)";

function buildOwnerGithubRedirectUrl(): string {
  const params = new URLSearchParams();
  if (isWebPlatform()) {
    params.set("post_message", "1");
  } else {
    params.set("return_url", LIFEOPS_GITHUB_RETURN_URL);
  }
  return `${LIFEOPS_GITHUB_COMPLETE_PATH}?${params.toString()}`;
}

function openWebOauthPopup(): Window | null {
  if (
    !isWebPlatform() ||
    typeof window === "undefined" ||
    typeof window.open !== "function"
  ) {
    return null;
  }
  return window.open("", "elizaos-lifeops-github");
}

function describeGithubCallback(
  detail: LifeOpsGithubCallbackDetail,
  t: TranslateFn,
): {
  message: string;
  tone: "success" | "error";
  durationMs: number;
} {
  if (detail.status === "error") {
    return {
      message:
        detail.message?.trim() ||
        t("lifeopspage.githubSetupIncomplete", {
          defaultValue: "GitHub setup did not complete.",
        }),
      tone: "error",
      durationMs: 5000,
    };
  }

  if (detail.target === "owner") {
    return {
      message: t("lifeopspage.githubConnectedCloud", {
        defaultValue: "LifeOps GitHub connected through Eliza Cloud.",
      }),
      tone: "success",
      durationMs: 3600,
    };
  }

  if (detail.bindingMode === "shared-owner") {
    return {
      message: detail.restarted
        ? t("lifeopspage.agentUsingOwnerGithubRestarting", {
            defaultValue:
              "Agent is using the LifeOps GitHub account and the cloud runtime is restarting.",
          })
        : t("lifeopspage.agentUsingOwnerGithub", {
            defaultValue: "Agent is using the LifeOps GitHub account.",
          }),
      tone: "success",
      durationMs: 4200,
    };
  }

  const githubHandle = detail.githubUsername?.trim()
    ? ` @${detail.githubUsername.trim()}`
    : "";
  return {
    message: detail.restarted
      ? t("lifeopspage.agentGithubConnectedRestarting", {
          defaultValue:
            "Agent GitHub{{githubHandle}} connected and the cloud runtime is restarting.",
          githubHandle,
        })
      : t("lifeopspage.agentGithubConnected", {
          defaultValue: "Agent GitHub{{githubHandle}} connected.",
          githubHandle,
        }),
    tone: "success",
    durationMs: 4200,
  };
}

function readGithubIdentity(
  connection: {
    displayName?: string | null;
    username?: string | null;
    email?: string | null;
  } | null,
  t: TranslateFn,
): string {
  if (!connection) {
    return t("lifeopspage.notLinked", {
      defaultValue: "Not linked",
    });
  }
  const displayName =
    typeof connection.displayName === "string" &&
    connection.displayName.trim().length > 0
      ? connection.displayName.trim()
      : null;
  const username =
    typeof connection.username === "string" &&
    connection.username.trim().length > 0
      ? `@${connection.username.trim()}`
      : null;
  const email =
    typeof connection.email === "string" && connection.email.trim().length > 0
      ? connection.email.trim()
      : null;
  return (
    displayName ??
    username ??
    email ??
    t("lifeopspage.notLinked", {
      defaultValue: "Not linked",
    })
  );
}

function selectPrimaryOwnerGithubConnection(
  connections: CloudOAuthConnection[],
): CloudOAuthConnection | null {
  return (
    connections.find((connection) => connection.status === "active") ??
    connections[0] ??
    null
  );
}

function selectPrimaryAgentGithubEntry(
  entries: ManagedAgentGithubEntry[],
): ManagedAgentGithubEntry | null {
  return entries.find((entry) => entry.github?.connected) ?? entries[0] ?? null;
}

// Mirrors GithubSetupState from LifeOpsSettingsSection.
type GithubSetup = {
  identity: string;
  status: string;
  connectLabel?: string;
  connectDisabled?: boolean;
  disconnectDisabled?: boolean;
  onConnect?: () => void;
  onDisconnect?: () => void;
};

interface LifeOpsSettingsSectionViewProps {
  ownerGithub: GithubSetup;
  agentGithub: GithubSetup;
  githubError: string | null;
  onRunSetupAgain: () => void;
  onDisableLifeOps: () => void;
  disableLifeOpsDisabled: boolean;
  t: TranslateFn;
}

function buildOwnerGithubSetup(params: {
  elizaCloudConnected: boolean;
  primaryOwnerGithubConnection: CloudOAuthConnection | null;
  githubLoading: boolean;
  ownerGithubBusy: boolean;
  disconnectingOwnerConnectionId: string | null;
  handleConnectOwnerGithub: () => void;
  handleDisconnectOwnerGithub: (id: string) => void;
  t: TranslateFn;
}): GithubSetup {
  const {
    elizaCloudConnected,
    primaryOwnerGithubConnection,
    githubLoading,
    ownerGithubBusy,
    disconnectingOwnerConnectionId,
    handleConnectOwnerGithub,
    handleDisconnectOwnerGithub,
    t,
  } = params;
  return {
    identity: elizaCloudConnected
      ? readGithubIdentity(primaryOwnerGithubConnection, t)
      : t("lifeopspage.cloudRequired", { defaultValue: "Cloud required" }),
    status: elizaCloudConnected
      ? primaryOwnerGithubConnection
        ? "1 / 1"
        : githubLoading
          ? t("common.loading", { defaultValue: "Loading" })
          : "0 / 1"
      : t("lifeopspage.cloudRequired", { defaultValue: "Cloud required" }),
    connectLabel: primaryOwnerGithubConnection
      ? t("common.reconnect", { defaultValue: "Reconnect" })
      : t("common.connect", { defaultValue: "Connect" }),
    connectDisabled: ownerGithubBusy || !elizaCloudConnected,
    disconnectDisabled:
      disconnectingOwnerConnectionId === primaryOwnerGithubConnection?.id,
    onConnect: elizaCloudConnected ? handleConnectOwnerGithub : undefined,
    onDisconnect: primaryOwnerGithubConnection
      ? () => handleDisconnectOwnerGithub(primaryOwnerGithubConnection.id)
      : undefined,
  };
}

function buildAgentGithubSetup(params: {
  elizaCloudConnected: boolean;
  primaryAgentGithubEntry: ManagedAgentGithubEntry | null;
  githubLoading: boolean;
  busyAgentGithubId: string | null;
  handleConnectAgentGithub: (id: string) => void;
  handleDisconnectAgentGithub: (id: string) => void;
  t: TranslateFn;
}): GithubSetup {
  const {
    elizaCloudConnected,
    primaryAgentGithubEntry,
    githubLoading,
    busyAgentGithubId,
    handleConnectAgentGithub,
    handleDisconnectAgentGithub,
    t,
  } = params;
  return {
    identity: elizaCloudConnected
      ? primaryAgentGithubEntry?.github?.connected
        ? readGithubIdentity(
            {
              displayName: primaryAgentGithubEntry.github.githubDisplayName,
              username: primaryAgentGithubEntry.github.githubUsername,
              email: primaryAgentGithubEntry.github.githubEmail,
            },
            t,
          )
        : (primaryAgentGithubEntry?.agent.agent_name ??
          t("lifeopspage.noCloudAgent", { defaultValue: "No cloud agent" }))
      : t("lifeopspage.cloudRequired", { defaultValue: "Cloud required" }),
    status: elizaCloudConnected
      ? primaryAgentGithubEntry?.github?.connected
        ? "1 / 1"
        : primaryAgentGithubEntry
          ? "0 / 1"
          : githubLoading
            ? t("common.loading", { defaultValue: "Loading" })
            : ""
      : t("lifeopspage.cloudRequired", { defaultValue: "Cloud required" }),
    connectLabel: primaryAgentGithubEntry?.github?.connected
      ? t("common.reconnect", { defaultValue: "Reconnect" })
      : t("common.connect", { defaultValue: "Connect" }),
    connectDisabled:
      !primaryAgentGithubEntry ||
      busyAgentGithubId === primaryAgentGithubEntry.agent.agent_id,
    disconnectDisabled:
      !primaryAgentGithubEntry ||
      busyAgentGithubId === primaryAgentGithubEntry.agent.agent_id,
    onConnect:
      elizaCloudConnected && primaryAgentGithubEntry
        ? () => handleConnectAgentGithub(primaryAgentGithubEntry.agent.agent_id)
        : undefined,
    onDisconnect:
      elizaCloudConnected &&
      primaryAgentGithubEntry?.github?.connected &&
      primaryAgentGithubEntry
        ? () =>
            handleDisconnectAgentGithub(primaryAgentGithubEntry.agent.agent_id)
        : undefined,
  };
}

function RunSetupAgainButton({
  onClick,
  label,
}: {
  onClick: () => void;
  label: string;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "action-run-setup-again",
    role: "button",
    label,
    group: "lifeops-settings",
    description: "Restart the LifeOps setup flow",
  });
  return (
    <Button
      ref={ref}
      size="sm"
      variant="outline"
      className="h-8 w-8 rounded-xl p-0"
      onClick={onClick}
      title={label}
      aria-label={label}
      {...agentProps}
    >
      <RefreshCw className="h-3.5 w-3.5" aria-hidden />
    </Button>
  );
}

function DisableLifeOpsButton({
  onClick,
  disabled,
  label,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "action-disable",
    role: "button",
    label,
    group: "lifeops-settings",
    description: "Disable LifeOps for the agent",
  });
  return (
    <Button
      ref={ref}
      variant="surfaceDestructive"
      size="sm"
      className="h-8 w-8 rounded-xl p-0"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      {...agentProps}
    >
      <Power className="h-3.5 w-3.5" aria-hidden />
    </Button>
  );
}

function LifeOpsSettingsSectionView({
  ownerGithub,
  agentGithub,
  githubError,
  onRunSetupAgain,
  onDisableLifeOps,
  disableLifeOpsDisabled,
  t,
}: LifeOpsSettingsSectionViewProps) {
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold tracking-tight text-txt">
          {t("lifeopspage.accessTitle", { defaultValue: "Access" })}
        </h2>
        <div className="flex items-center gap-2">
          <RunSetupAgainButton
            onClick={onRunSetupAgain}
            label={t("lifeopspage.runSetupAgain", {
              defaultValue: "Run setup again",
            })}
          />
          <DisableLifeOpsButton
            onClick={onDisableLifeOps}
            disabled={disableLifeOpsDisabled}
            label={t("lifeopspage.disable", {
              defaultValue: "Disable LifeOps",
            })}
          />
        </div>
      </div>

      <LifeOpsSettingsSection
        ownerGithub={ownerGithub}
        agentGithub={agentGithub}
        githubError={githubError}
      />
      <MessagingConnectorGrid />

      <LifeOpsXPanel />
    </div>
  );
}

/* ── Inner view — rendered inside SelectionProvider ────────────────── */
export function LifeOpsPageView() {
  return (
    <LifeOpsSelectionProvider>
      <LifeOpsWorkspaceInner />
    </LifeOpsSelectionProvider>
  );
}

export function LifeOpsTuiView() {
  const [lifeOpsState, setLifeOpsState] = useState<Awaited<
    ReturnType<typeof loadLifeOpsTuiState>
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [lastAction, setLastAction] = useState("boot");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadLifeOpsTuiState();
      setLifeOpsState(next);
      setLastAction("refresh");
    } catch (cause) {
      setLifeOpsState(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const updateEnabled = useCallback(
    async (enabled: boolean) => {
      if (!lifeOpsClient.updateLifeOpsAppState) return;
      setSaving(true);
      setError(null);
      try {
        await lifeOpsClient.updateLifeOpsAppState({ enabled });
        setLastAction(enabled ? "enabled" : "paused");
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSaving(false);
      }
    },
    [refresh],
  );

  const completeOccurrence = useCallback(
    async (occurrenceId: string) => {
      if (!lifeOpsClient.completeLifeOpsOccurrence) return;
      setSaving(true);
      setError(null);
      try {
        await lifeOpsClient.completeLifeOpsOccurrence(occurrenceId, {});
        setLastAction(`completed ${occurrenceId}`);
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSaving(false);
      }
    },
    [refresh],
  );

  const overview = lifeOpsState?.overview ?? null;
  const occurrences =
    overview?.occurrences ?? overview?.owner?.occurrences ?? [];
  const definitions = lifeOpsState?.definitions ?? [];
  const state = {
    viewType: "tui",
    viewId: "lifeops",
    enabled: lifeOpsState?.appState?.enabled ?? false,
    occurrenceCount: occurrences.length,
    activeOccurrenceCount: overview?.summary?.activeOccurrenceCount ?? 0,
    overdueOccurrenceCount: overview?.summary?.overdueOccurrenceCount ?? 0,
    activeReminderCount: overview?.summary?.activeReminderCount ?? 0,
    activeGoalCount: overview?.summary?.activeGoalCount ?? 0,
    definitionCount: definitions.length,
    loading,
    saving,
    lastAction,
    error,
  };

  return (
    <div
      data-view-state={JSON.stringify(state)}
      style={{
        minHeight: "100vh",
        background: "#020617",
        color: "#cbd5e1",
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        padding: 20,
      }}
    >
      <div style={{ color: "#7dd3fc", marginBottom: 4 }}>
        elizaos://lifeops --type=tui
      </div>
      <div style={{ color: "#475569", marginBottom: 16 }}>
        {loading ? "loading" : state.enabled ? "enabled" : "paused"} |{" "}
        {state.activeOccurrenceCount} active | {state.overdueOccurrenceCount}{" "}
        overdue | {lastAction}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr",
          gap: 16,
        }}
      >
        <section
          aria-label="LifeOps scheduled tasks"
          style={{
            border: "1px solid rgba(125,211,252,0.3)",
            borderRadius: 6,
            padding: 16,
            minHeight: 420,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              marginBottom: 10,
            }}
          >
            <strong style={{ color: "#e2e8f0" }}>scheduled tasks</strong>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => void updateEnabled(!state.enabled)}
                disabled={saving}
                style={{
                  background: "transparent",
                  color: state.enabled ? "#fca5a5" : "#a7f3d0",
                  border: "1px solid rgba(125,211,252,0.35)",
                  borderRadius: 4,
                  padding: "4px 8px",
                  cursor: saving ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                }}
              >
                {state.enabled ? "pause" : "enable"}
              </button>
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={loading}
                style={{
                  background: "transparent",
                  color: "#a7f3d0",
                  border: "1px solid rgba(167,243,208,0.45)",
                  borderRadius: 4,
                  padding: "4px 8px",
                  cursor: loading ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                }}
              >
                refresh
              </button>
            </div>
          </div>
          {error && <div style={{ color: "#fca5a5" }}>{error}</div>}
          {!loading && !error && occurrences.length === 0 && (
            <div style={{ color: "#64748b" }}>no active occurrences</div>
          )}
          {occurrences.slice(0, 8).map((occurrence, index) => (
            <div
              key={occurrence.id}
              style={{
                display: "grid",
                gridTemplateColumns: "4ch minmax(8ch, 1fr) 9ch",
                gap: 10,
                borderTop:
                  index === 0 ? "none" : "1px solid rgba(125,211,252,0.18)",
                padding: "8px 0",
              }}
            >
              <span style={{ color: "#64748b" }}>
                {String(index + 1).padStart(2, "0")}
              </span>
              <span style={{ color: "#e2e8f0" }}>
                {occurrence.title ?? occurrence.id}
              </span>
              <span
                style={{
                  color: occurrence.state === "overdue" ? "#fca5a5" : "#94a3b8",
                }}
              >
                {occurrence.state ?? "active"}
              </span>
              <span style={{ gridColumn: "2 / 3", color: "#94a3b8" }}>
                {occurrence.definitionKind ?? "task"} | due{" "}
                {occurrence.dueAt ?? occurrence.scheduledAt ?? "unscheduled"}
              </span>
              <button
                type="button"
                onClick={() => void completeOccurrence(occurrence.id)}
                disabled={saving}
                style={{
                  gridColumn: "3",
                  background: "transparent",
                  color: "#7dd3fc",
                  border: "1px solid rgba(125,211,252,0.45)",
                  borderRadius: 4,
                  padding: "4px 8px",
                  cursor: saving ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                }}
              >
                complete
              </button>
            </div>
          ))}
        </section>

        <section
          aria-label="LifeOps definitions and goals"
          style={{
            border: "1px solid rgba(125,211,252,0.3)",
            borderRadius: 6,
            padding: 16,
            minHeight: 420,
          }}
        >
          <strong style={{ color: "#e2e8f0" }}>definitions</strong>
          <div style={{ color: "#64748b", margin: "6px 0 14px" }}>
            {definitions.length} definitions / {state.activeGoalCount} goals
          </div>
          {definitions.slice(0, 6).map((record, index) => (
            <div
              key={record.definition?.id ?? String(index)}
              style={{
                borderTop:
                  index === 0 ? "none" : "1px solid rgba(125,211,252,0.18)",
                padding: "8px 0",
              }}
            >
              <span style={{ color: "#a7f3d0" }}>
                {record.definition?.title ??
                  record.definition?.id ??
                  "definition"}
              </span>{" "}
              <span style={{ color: "#94a3b8" }}>
                {record.definition?.kind ?? "task"} /{" "}
                {record.definition?.status ?? "unknown"}
              </span>
            </div>
          ))}

          <div style={{ color: "#a7f3d0", margin: "18px 0 8px" }}>goals</div>
          {(overview?.owner?.goals ?? overview?.goals ?? [])
            .slice(0, 4)
            .map((goal) => (
              <div key={goal.id} style={{ padding: "4px 0" }}>
                {goal.title ?? goal.id}{" "}
                <span style={{ color: "#94a3b8" }}>{goal.status ?? ""}</span>
              </div>
            ))}
        </section>
      </div>
    </div>
  );
}

function LifeOpsWorkspaceInner() {
  const lifeOpsApp = useLifeOpsAppState();
  const {
    agentStatus,
    backendConnection,
    elizaCloudConnected,
    setActionNotice,
    startupCoordinator,
    t,
  } = useApp();
  const [ownerGithubConnections, setOwnerGithubConnections] = useState<
    CloudOAuthConnection[]
  >([]);
  const [agentGithubEntries, setAgentGithubEntries] = useState<
    ManagedAgentGithubEntry[]
  >([]);
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [ownerGithubBusy, setOwnerGithubBusy] = useState(false);
  const [disconnectingOwnerConnectionId, setDisconnectingOwnerConnectionId] =
    useState<string | null>(null);
  const [busyAgentGithubId, setBusyAgentGithubId] = useState<string | null>(
    null,
  );
  const compactLayout = useMediaQuery(LIFEOPS_COMPACT_LAYOUT_MEDIA_QUERY);

  const { section, navigate, eventId, messageId } = useLifeOpsSection();
  const { select } = useLifeOpsSelection();
  // Bridge URL hash → selection context. When the widget row writes the hash
  // and the app navigates to /lifeops, the section-scoped UIs
  // (EventEditorDrawer, InboxReaderPane, …) react off `selection.eventId` /
  // `selection.messageId`, not off the hash directly. Push the hook's hash
  // state into the selection context whenever it changes.
  useEffect(() => {
    select({ eventId, messageId });
  }, [eventId, messageId, select]);
  const appEnabled = lifeOpsApp.enabled;
  const appWindowRoute =
    typeof window !== "undefined" ? isAppWindowRoute(window.location) : false;

  const runtimeReady =
    appWindowRoute ||
    (startupCoordinator.phase === "ready" &&
      agentStatus?.state === "running" &&
      backendConnection.state === "connected");

  const loadGithub = useCallback(async () => {
    if (!appEnabled || !elizaCloudConnected) {
      setGithubError(null);
      setOwnerGithubConnections([]);
      setAgentGithubEntries([]);
      setGithubLoading(false);
      return;
    }
    setGithubLoading(true);
    setGithubError(null);
    try {
      const [connectionsResult, agentsResult] = await Promise.allSettled([
        client.listCloudOauthConnections({
          platform: "github",
          connectionRole: "owner",
        }),
        client.getCloudCompatAgents(),
      ]);
      if (
        connectionsResult.status === "rejected" &&
        agentsResult.status === "rejected"
      ) {
        throw connectionsResult.reason;
      }
      const connections =
        connectionsResult.status === "fulfilled" &&
        Array.isArray(connectionsResult.value.connections)
          ? connectionsResult.value.connections
          : [];
      const agents =
        agentsResult.status === "fulfilled" &&
        Array.isArray(agentsResult.value.data)
          ? agentsResult.value.data
          : [];
      const entries = await Promise.all(
        agents.map(async (agent) => {
          const github = await client.getCloudCompatAgentManagedGithub(
            agent.agent_id,
          );
          return {
            agent,
            github: github.data,
          };
        }),
      );
      setOwnerGithubConnections(connections);
      setAgentGithubEntries(entries);
      if (
        connectionsResult.status === "rejected" ||
        agentsResult.status === "rejected"
      ) {
        setGithubError(
          t("lifeopspage.githubDetailsPartial", {
            defaultValue: "GitHub cloud details unavailable.",
          }),
        );
      }
    } catch (cause) {
      setGithubError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : t("lifeopspage.githubDetailsLoadFailed", {
              defaultValue: "GitHub connection details failed to load.",
            }),
      );
    } finally {
      setGithubLoading(false);
    }
  }, [appEnabled, elizaCloudConnected, t]);

  useEffect(() => {
    void loadGithub();
  }, [loadGithub]);

  const handleGithubCallback = useCallback(
    (detail: LifeOpsGithubCallbackDetail) => {
      consumeQueuedLifeOpsGithubCallback(detail);
      setOwnerGithubBusy(false);
      setBusyAgentGithubId(null);

      void (async () => {
        let resolvedDetail = detail;

        if (
          detail.target === "agent" &&
          detail.status === "connected" &&
          detail.agentId &&
          detail.connectionId &&
          !detail.bindingMode
        ) {
          try {
            const response = await client.linkCloudCompatAgentManagedGithub(
              detail.agentId,
              detail.connectionId,
            );
            resolvedDetail = {
              ...detail,
              bindingMode: response.data.mode ?? "cloud-managed",
              githubUsername:
                response.data.githubUsername ?? detail.githubUsername ?? null,
              restarted: response.data.restarted,
            };
          } catch (cause) {
            resolvedDetail = {
              ...detail,
              status: "error",
              message:
                cause instanceof Error
                  ? cause.message
                  : t("lifeopspage.githubLinkFailed", {
                      defaultValue: "Failed to link GitHub to this agent.",
                    }),
            };
          }
        }

        const notice = describeGithubCallback(resolvedDetail, t);
        setActionNotice(notice.message, notice.tone, notice.durationMs);
        await loadGithub();
      })();
    },
    [loadGithub, setActionNotice, t],
  );

  const handleSetLifeOpsEnabled = useCallback(
    async (nextEnabled: boolean) => {
      try {
        await lifeOpsApp.updateEnabled(nextEnabled);
        if (!nextEnabled) {
          setOwnerGithubConnections([]);
          setAgentGithubEntries([]);
          setGithubError(null);
        }
        setActionNotice(
          nextEnabled
            ? t("lifeopspage.enabled", { defaultValue: "LifeOps enabled." })
            : t("lifeopspage.disabled", { defaultValue: "LifeOps disabled." }),
          "success",
          3600,
        );
      } catch (cause) {
        setActionNotice(
          cause instanceof Error
            ? cause.message
            : t("lifeopspage.updateStateFailed", {
                defaultValue: "Failed to update the LifeOps app state.",
              }),
          "error",
          4200,
        );
      }
    },
    [lifeOpsApp, setActionNotice, t],
  );

  const handleConnectOwnerGithub = useCallback(async () => {
    const popup = openWebOauthPopup();
    if (isWebPlatform() && !popup) {
      setActionNotice(
        t("lifeopspage.popupBlocked", {
          defaultValue: "Popup blocked. Please allow popups and try again.",
        }),
        "error",
        4200,
      );
      return;
    }
    setOwnerGithubBusy(true);
    try {
      const response = await client.initiateCloudOauth("github", {
        redirectUrl: buildOwnerGithubRedirectUrl(),
        connectionRole: "owner",
      });
      if (popup && !popup.closed) {
        popup.location.href = response.authUrl;
      } else {
        await openExternalUrl(response.authUrl);
      }
      setActionNotice(
        t("lifeopspage.finishGithubAuth", {
          defaultValue:
            "Finish GitHub authorization in your browser, then return here.",
        }),
        "info",
        5000,
      );
    } catch (cause) {
      popup?.close();
      setActionNotice(
        cause instanceof Error
          ? cause.message
          : t("lifeopspage.startGithubSetupFailed", {
              defaultValue: "Failed to start GitHub setup.",
            }),
        "error",
        4200,
      );
    } finally {
      setOwnerGithubBusy(false);
    }
  }, [setActionNotice, t]);

  const handleDisconnectOwnerGithub = useCallback(
    async (connectionId: string) => {
      setDisconnectingOwnerConnectionId(connectionId);
      try {
        await client.disconnectCloudOauthConnection(connectionId);
        setOwnerGithubConnections((current) =>
          current.filter((connection) => connection.id !== connectionId),
        );
        setActionNotice(
          t("lifeopspage.githubDisconnected", {
            defaultValue: "LifeOps GitHub disconnected.",
          }),
          "success",
          3200,
        );
        await loadGithub();
      } catch (cause) {
        setActionNotice(
          cause instanceof Error
            ? cause.message
            : t("lifeopspage.disconnectGithubFailed", {
                defaultValue: "Failed to disconnect GitHub.",
              }),
          "error",
          4200,
        );
      } finally {
        setDisconnectingOwnerConnectionId(null);
      }
    },
    [loadGithub, setActionNotice, t],
  );

  const handleConnectAgentGithub = useCallback(
    async (agentId: string) => {
      const popup = openWebOauthPopup();
      if (isWebPlatform() && !popup) {
        setActionNotice(
          t("lifeopspage.popupBlocked", {
            defaultValue: "Popup blocked. Please allow popups and try again.",
          }),
          "error",
          4200,
        );
        return;
      }
      setBusyAgentGithubId(agentId);
      try {
        const response = await client.createCloudCompatAgentManagedGithubOauth(
          agentId,
          isWebPlatform()
            ? { postMessage: true }
            : { returnUrl: LIFEOPS_GITHUB_RETURN_URL },
        );
        if (popup && !popup.closed) {
          popup.location.href = response.data.authorizeUrl;
        } else {
          await openExternalUrl(response.data.authorizeUrl);
        }
        setActionNotice(
          t("lifeopspage.finishGithubAuth", {
            defaultValue:
              "Finish GitHub authorization in your browser, then return here.",
          }),
          "info",
          5000,
        );
      } catch (cause) {
        popup?.close();
        setActionNotice(
          cause instanceof Error
            ? cause.message
            : t("lifeopspage.startAgentGithubSetupFailed", {
                defaultValue: "Failed to start agent GitHub setup.",
              }),
          "error",
          4200,
        );
      } finally {
        setBusyAgentGithubId(null);
      }
    },
    [setActionNotice, t],
  );

  useEffect(() => {
    drainLifeOpsGithubCallbacks().forEach(handleGithubCallback);

    const handleCallbackEvent = (event: Event) => {
      const detail = (event as CustomEvent<LifeOpsGithubCallbackDetail>).detail;
      if (!detail) return;
      handleGithubCallback(detail);
    };

    window.addEventListener(
      LIFEOPS_GITHUB_CALLBACK_EVENT,
      handleCallbackEvent as EventListener,
    );
    return () => {
      window.removeEventListener(
        LIFEOPS_GITHUB_CALLBACK_EVENT,
        handleCallbackEvent as EventListener,
      );
    };
  }, [handleGithubCallback]);

  useEffect(() => {
    const handleWindowMessage = (event: MessageEvent) => {
      dispatchLifeOpsGithubCallbackFromWindowMessage(event.data);
    };
    window.addEventListener("message", handleWindowMessage);
    return () => {
      window.removeEventListener("message", handleWindowMessage);
    };
  }, []);

  const handleDisconnectAgentGithub = useCallback(
    async (agentId: string) => {
      setBusyAgentGithubId(agentId);
      try {
        const response =
          await client.disconnectCloudCompatAgentManagedGithub(agentId);
        setAgentGithubEntries((current) =>
          current.map((entry) =>
            entry.agent.agent_id === agentId
              ? { ...entry, github: response.data }
              : entry,
          ),
        );
        setActionNotice(
          t("lifeopspage.agentGithubDisconnected", {
            defaultValue: "Agent GitHub disconnected.",
          }),
          "success",
          3200,
        );
        await loadGithub();
      } catch (cause) {
        setActionNotice(
          cause instanceof Error
            ? cause.message
            : t("lifeopspage.disconnectAgentGithubFailed", {
                defaultValue: "Failed to disconnect agent GitHub.",
              }),
          "error",
          4200,
        );
      } finally {
        setBusyAgentGithubId(null);
      }
    },
    [loadGithub, setActionNotice, t],
  );

  const primaryOwnerGithubConnection = useMemo(
    () => selectPrimaryOwnerGithubConnection(ownerGithubConnections),
    [ownerGithubConnections],
  );
  const primaryAgentGithubEntry = useMemo(
    () => selectPrimaryAgentGithubEntry(agentGithubEntries),
    [agentGithubEntries],
  );

  const ownerGithubSetup = useMemo(
    () =>
      buildOwnerGithubSetup({
        elizaCloudConnected,
        primaryOwnerGithubConnection,
        githubLoading,
        ownerGithubBusy,
        disconnectingOwnerConnectionId,
        handleConnectOwnerGithub: () => void handleConnectOwnerGithub(),
        handleDisconnectOwnerGithub: (id) =>
          void handleDisconnectOwnerGithub(id),
        t,
      }),
    [
      disconnectingOwnerConnectionId,
      elizaCloudConnected,
      githubLoading,
      handleConnectOwnerGithub,
      handleDisconnectOwnerGithub,
      ownerGithubBusy,
      primaryOwnerGithubConnection,
      t,
    ],
  );

  const agentGithubSetup = useMemo(
    () =>
      buildAgentGithubSetup({
        elizaCloudConnected,
        primaryAgentGithubEntry,
        githubLoading,
        busyAgentGithubId,
        handleConnectAgentGithub: (id) => void handleConnectAgentGithub(id),
        handleDisconnectAgentGithub: (id) =>
          void handleDisconnectAgentGithub(id),
        t,
      }),
    [
      busyAgentGithubId,
      elizaCloudConnected,
      githubLoading,
      handleConnectAgentGithub,
      handleDisconnectAgentGithub,
      primaryAgentGithubEntry,
      t,
    ],
  );

  const showEnablePrompt =
    !lifeOpsApp.loading && !lifeOpsApp.error && !appEnabled;

  /* ── Enable prompt ──────────────────────────────────────────────── */
  if (lifeOpsApp.loading) {
    return (
      <div className="px-4 py-6">
        <PagePanel.Loading
          variant="surface"
          heading={t("lifeopspage.loadingState", {
            defaultValue: "Loading LifeOps app state",
          })}
        />
      </div>
    );
  }

  if (lifeOpsApp.error) {
    return (
      <div className="px-4 py-4">
        <PagePanel.Notice tone="danger">{lifeOpsApp.error}</PagePanel.Notice>
      </div>
    );
  }

  if (showEnablePrompt) {
    return (
      <div className="px-4 py-4 sm:px-6 sm:py-5 lg:px-8 lg:py-6">
        <EnablePrompt
          loading={lifeOpsApp.saving}
          onEnable={() => void handleSetLifeOpsEnabled(true)}
          t={t}
        />
      </div>
    );
  }

  /* ── Workspace ──────────────────────────────────────────────────── */
  const mainContent = (() => {
    if (appEnabled && !runtimeReady) {
      return (
        <PagePanel.Loading
          variant="surface"
          heading={t("lifeopspage.waitingRuntime", {
            defaultValue: "Waiting for LifeOps runtime",
          })}
        />
      );
    }

    return (
      <LifeOpsSectionContent
        section={section}
        navigate={navigate}
        setupContent={
          <LifeOpsSettingsSectionView
            ownerGithub={ownerGithubSetup}
            agentGithub={agentGithubSetup}
            githubError={githubError}
            onRunSetupAgain={() => {
              clearLifeOpsSetupGateDismissed();
              navigate("overview");
            }}
            onDisableLifeOps={() => void handleSetLifeOpsEnabled(false)}
            disableLifeOpsDisabled={lifeOpsApp.loading || lifeOpsApp.saving}
            t={t}
          />
        }
      />
    );
  })();

  // Single-pane layout: the workspace shell renders one vertical column (top
  // section-tab bar over the scrollable content). The right chat rail is
  // disabled — the global floating chat pill owns LifeOps chat via the
  // `page-lifeops` scope, and the shell's top bar keeps quick chat/voice access.
  return (
    <AppWorkspaceChrome
      testId="lifeops-shell"
      chatDisabled
      main={
        <LifeOpsWorkspaceShell
          compactLayout={compactLayout}
          section={section}
          navigate={navigate}
        >
          {mainContent}
        </LifeOpsWorkspaceShell>
      }
    />
  );
}
