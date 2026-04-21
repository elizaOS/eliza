/**
 * LifeOpsPageView — left-nav + main + right-chat workspace layout.
 *
 * Layout:
 *   [NavRail] | [Main section content] | [Chat (AppWorkspaceChrome)]
 *
 * Section routing via useLifeOpsSection; selection propagated via
 * LifeOpsSelectionProvider.
 *
 * TODO: replace AppWorkspaceChromeFallback with AppWorkspaceChrome
 * from @elizaos/app-core when Stream B lands.
 */
import {
  Button,
  type CloudOAuthConnection,
  client,
  isWebPlatform,
  openExternalUrl,
  PagePanel,
  useApp,
} from "@elizaos/app-core";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
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
import { LifeOpsCalendarSection } from "./LifeOpsCalendarSection.js";
import { LifeOpsChatAdapter } from "./LifeOpsChatAdapter.js";
import { LifeOpsDashboardSection } from "./LifeOpsDashboardSection.js";
import { LifeOpsInboxSection } from "./LifeOpsInboxSection.js";
import { LifeOpsNavRail } from "./LifeOpsNavRail.js";
import {
  LifeOpsCapabilitiesPanel,
  LifeOpsProfilePanel,
  LifeOpsSchedulePanel,
  LifeOpsStretchPanel,
  LifeOpsXPanel,
} from "./LifeOpsOperationalPanels";
import type { ManagedAgentGithubEntry } from "./LifeOpsPageSections";
import { LifeOpsRemindersSection } from "./LifeOpsRemindersSection.js";
import { LifeOpsSelectionProvider } from "./LifeOpsSelectionContext.js";
import { LifeOpsSettingsSection } from "./LifeOpsSettingsSection";
import { clearLifeOpsSetupGateDismissed } from "./LifeOpsSetupGate.js";
import { MessagingConnectorGrid } from "./MessagingConnectorCards";
import { PermissionsPanel } from "./PermissionsPanel";

const LIFEOPS_GITHUB_COMPLETE_PATH = "/api/v1/milady/lifeops/github-complete";
const LIFEOPS_GITHUB_RETURN_URL = "elizaos://lifeops";

type TranslateFn = (
  key: string,
  options?: Record<string, unknown> & { defaultValue?: string },
) => string;

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

/* ── Local fallback for AppWorkspaceChrome ─────────────────────────── */
// TODO: replace with AppWorkspaceChrome from @elizaos/app-core when Stream B lands.
interface AppWorkspaceChromeFallbackProps {
  nav: ReactNode;
  main: ReactNode;
  chat?: ReactNode;
  chatCollapsed?: boolean;
  onToggleChat?: () => void;
  chatDefaultCollapsed?: boolean;
  testId?: string;
}

function AppWorkspaceChromeFallback({
  nav,
  main,
  chat,
  testId,
}: AppWorkspaceChromeFallbackProps) {
  return (
    <div
      className="flex h-full min-h-0 w-full overflow-hidden"
      data-testid={testId}
    >
      {nav}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-4 py-4 sm:px-6 sm:py-5 lg:px-8 lg:py-6">
        {main}
      </main>
      {chat ? (
        <aside className="flex w-72 shrink-0 flex-col border-l border-border/12">
          {chat}
        </aside>
      ) : null}
    </div>
  );
}

/* ── Settings section ─────────────────────────────────────────────── */

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
            : t("lifeopspage.noCloudAgent", { defaultValue: "No cloud agent" })
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
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-txt">
          {t("lifeopspage.setupTitle", { defaultValue: "Settings" })}
        </h2>
        <Button
          size="sm"
          variant="outline"
          className="h-8 rounded-xl px-3 text-xs font-semibold"
          onClick={onRunSetupAgain}
        >
          {t("lifeopspage.runSetupAgain", {
            defaultValue: "Run setup again",
          })}
        </Button>
      </div>

      <LifeOpsSettingsSection
        ownerGithub={ownerGithub}
        agentGithub={agentGithub}
        githubError={githubError}
      />
      <MessagingConnectorGrid />

      <div className="grid gap-4 xl:grid-cols-2">
        <LifeOpsSchedulePanel />
        <LifeOpsCapabilitiesPanel />
        <LifeOpsXPanel />
        <LifeOpsProfilePanel />
        <LifeOpsStretchPanel />
      </div>

      <PermissionsPanel />

      <div className="flex justify-end border-t border-border/16 pt-2">
        <Button
          variant="surfaceDestructive"
          size="sm"
          className="rounded-full px-4 text-xs-tight font-semibold"
          onClick={onDisableLifeOps}
          disabled={disableLifeOpsDisabled}
        >
          {t("lifeopspage.disable", { defaultValue: "Disable LifeOps" })}
        </Button>
      </div>
    </div>
  );
}

/* ── Inner view — rendered inside SelectionProvider ────────────────── */
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

  const { section, navigate } = useLifeOpsSection();
  const appEnabled = lifeOpsApp.enabled;

  const runtimeReady =
    startupCoordinator.phase === "ready" &&
    agentStatus?.state === "running" &&
    backendConnection?.state === "connected";

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
        agents.map(async (agent) => ({
          agent,
          github: await client
            .getCloudCompatAgentManagedGithub(agent.agent_id)
            .then((response) => response.data)
            .catch(() => null),
        })),
      );
      setOwnerGithubConnections(connections);
      setAgentGithubEntries(entries);
      if (
        connectionsResult.status === "rejected" ||
        agentsResult.status === "rejected"
      ) {
        setGithubError(
          t("lifeopspage.githubDetailsPartial", {
            defaultValue:
              "Some GitHub cloud details are still unavailable. You can still connect accounts.",
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

    switch (section) {
      case "dashboard":
        return <LifeOpsDashboardSection onNavigate={navigate} />;
      case "calendar":
        return <LifeOpsCalendarSection />;
      case "inbox":
        return <LifeOpsInboxSection />;
      case "reminders":
        return <LifeOpsRemindersSection />;
      case "settings":
        return (
          <LifeOpsSettingsSectionView
            ownerGithub={ownerGithubSetup}
            agentGithub={agentGithubSetup}
            githubError={githubError}
            onRunSetupAgain={() => {
              clearLifeOpsSetupGateDismissed();
              navigate("dashboard");
            }}
            onDisableLifeOps={() => void handleSetLifeOpsEnabled(false)}
            disableLifeOpsDisabled={lifeOpsApp.loading || lifeOpsApp.saving}
            t={t}
          />
        );
      default:
        return null;
    }
  })();

  return (
    <div
      className="space-y-6 px-4 py-4 sm:px-6 sm:py-5 lg:px-8 lg:py-6"
      data-testid="lifeops-shell"
    >
      <div className="space-y-4">
        <PagePanel.Header heading="LifeOps" className="px-0 py-0 sm:px-0" />

        {lifeOpsApp.error ? (
          <PagePanel.Notice tone="danger">
            {lifeOpsApp.error}
          </PagePanel.Notice>
        ) : null}

        {lifeOpsApp.loading ? (
          <PagePanel.Loading
            variant="surface"
            heading="Loading LifeOps app state"
          />
        ) : null}

        {appEnabled && !runtimeReady ? (
          <PagePanel.Loading
            variant="surface"
            heading="Waiting for LifeOps runtime"
          />
        ) : null}
      </div>

      {appEnabled && runtimeReady ? (
        <>
          <section>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 py-3 text-left"
              onClick={() => setSetupOpen((current) => !current)}
              aria-expanded={setupOpen}
            >
              <div className="text-sm font-semibold text-txt">Setup</div>
              <ChevronDown
                className={`h-4 w-4 text-muted transition-transform ${
                  setupOpen ? "rotate-180" : ""
                }`}
              />
            </button>

            {setupOpen ? (
              <div className="space-y-6 pt-2">
                <LifeOpsSettingsSection
                  ownerGithub={ownerGithubSetup}
                  agentGithub={agentGithubSetup}
                  githubError={githubError}
                />
                <MessagingConnectorGrid />
              </div>
            ) : null}
          </section>

          <LifeOpsWorkspaceView />

          <PermissionsPanel />
        </>
      ) : null}

      <div className="flex justify-end border-t border-border/16 pt-2">
        <Button
          variant={appEnabled ? "surfaceDestructive" : "default"}
          size="sm"
          className="rounded-full px-4 text-xs-tight font-semibold"
          onClick={() => void handleSetLifeOpsEnabled(!appEnabled)}
          disabled={lifeOpsApp.loading || lifeOpsApp.saving}
        >
          {appEnabled ? "Disable LifeOps" : "Enable LifeOps"}
        </Button>
      </div>
    </div>
  );
}
