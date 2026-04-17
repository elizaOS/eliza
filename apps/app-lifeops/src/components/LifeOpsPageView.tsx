import { Button, PagePanel } from "@elizaos/app-core";
import { client, type CloudOAuthConnection } from "@elizaos/app-core";
import { isWebPlatform } from "@elizaos/app-core";
import { useApp } from "@elizaos/app-core";
import { openExternalUrl } from "@elizaos/app-core";
import {
  LIFEOPS_GITHUB_CALLBACK_EVENT,
  type LifeOpsGithubCallbackDetail,
} from "../events/index.js";
import {
  consumeQueuedLifeOpsGithubCallback,
  dispatchLifeOpsGithubCallbackFromWindowMessage,
  drainLifeOpsGithubCallbacks,
} from "../platform/lifeops-github.js";
import { useLifeOpsAppState } from "../hooks/useLifeOpsAppState.js";
import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ManagedAgentGithubEntry } from "./LifeOpsPageSections";
import { LifeOpsBrowserSetupPanel } from "./LifeOpsBrowserSetupPanel";
import { LifeOpsSettingsSection } from "./LifeOpsSettingsSection";
import { LifeOpsWorkspaceView } from "./LifeOpsWorkspaceView";
import { MessagingConnectorGrid } from "./MessagingConnectorCards";
import { PermissionsPanel } from "./PermissionsPanel";

const LIFEOPS_GITHUB_COMPLETE_PATH = "/api/v1/milady/lifeops/github-complete";
const LIFEOPS_GITHUB_RETURN_URL = "elizaos://lifeops";

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

function describeGithubCallback(detail: LifeOpsGithubCallbackDetail): {
  message: string;
  tone: "success" | "error";
  durationMs: number;
} {
  if (detail.status === "error") {
    return {
      message: detail.message?.trim() || "GitHub setup did not complete.",
      tone: "error",
      durationMs: 5000,
    };
  }

  if (detail.target === "owner") {
    return {
      message: "LifeOps GitHub connected through Eliza Cloud.",
      tone: "success",
      durationMs: 3600,
    };
  }

  if (detail.bindingMode === "shared-owner") {
    return {
      message: detail.restarted
        ? "Agent is using the LifeOps GitHub account and the cloud runtime is restarting."
        : "Agent is using the LifeOps GitHub account.",
      tone: "success",
      durationMs: 4200,
    };
  }

  const githubHandle = detail.githubUsername?.trim()
    ? ` @${detail.githubUsername.trim()}`
    : "";
  return {
    message: detail.restarted
      ? `Agent GitHub${githubHandle} connected and the cloud runtime is restarting.`
      : `Agent GitHub${githubHandle} connected.`,
    tone: "success",
    durationMs: 4200,
  };
}

function readGithubIdentity(connection: {
  displayName?: string | null;
  username?: string | null;
  email?: string | null;
} | null): string {
  if (!connection) {
    return "Not linked";
  }
  const displayName =
    typeof connection.displayName === "string" &&
    connection.displayName.trim().length > 0
      ? connection.displayName.trim()
      : null;
  const username =
    typeof connection.username === "string" && connection.username.trim().length > 0
      ? `@${connection.username.trim()}`
      : null;
  const email =
    typeof connection.email === "string" && connection.email.trim().length > 0
      ? connection.email.trim()
      : null;
  return displayName ?? username ?? email ?? "Not linked";
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

export function LifeOpsPageView() {
  const lifeOpsApp = useLifeOpsAppState();
  const {
    agentStatus,
    backendConnection,
    elizaCloudConnected,
    setActionNotice,
    setState,
    setTab,
    startupCoordinator,
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
  const [setupOpen, setSetupOpen] = useState(true);
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
          "Some GitHub cloud details are still unavailable. You can still connect accounts.",
        );
      }
    } catch (cause) {
      setGithubError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : "GitHub connection details failed to load.",
      );
    } finally {
      setGithubLoading(false);
    }
  }, [appEnabled, elizaCloudConnected]);

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
                  : "Failed to link GitHub to this agent.",
            };
          }
        }

        const notice = describeGithubCallback(resolvedDetail);
        setActionNotice(notice.message, notice.tone, notice.durationMs);
        await loadGithub();
      })();
    },
    [loadGithub, setActionNotice],
  );

  const openCloudAgents = useCallback(() => {
    setState("cloudDashboardView", "agents");
    setTab("settings");
  }, [setState, setTab]);

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
          nextEnabled ? "LifeOps enabled." : "LifeOps disabled.",
          "success",
          3600,
        );
      } catch (cause) {
        setActionNotice(
          cause instanceof Error
            ? cause.message
            : "Failed to update the LifeOps app state.",
          "error",
          4200,
        );
      }
    },
    [lifeOpsApp, setActionNotice],
  );

  const handleConnectOwnerGithub = useCallback(async () => {
    const popup = openWebOauthPopup();
    if (isWebPlatform() && !popup) {
      setActionNotice(
        "Popup blocked. Please allow popups and try again.",
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
        "Finish GitHub authorization in your browser, then return here.",
        "info",
        5000,
      );
    } catch (cause) {
      popup?.close();
      setActionNotice(
        cause instanceof Error ? cause.message : "Failed to start GitHub setup.",
        "error",
        4200,
      );
    } finally {
      setOwnerGithubBusy(false);
    }
  }, [setActionNotice]);

  const handleDisconnectOwnerGithub = useCallback(
    async (connectionId: string) => {
      setDisconnectingOwnerConnectionId(connectionId);
      try {
        await client.disconnectCloudOauthConnection(connectionId);
        setOwnerGithubConnections((current) =>
          current.filter((connection) => connection.id !== connectionId),
        );
        setActionNotice("LifeOps GitHub disconnected.", "success", 3200);
        await loadGithub();
      } catch (cause) {
        setActionNotice(
          cause instanceof Error ? cause.message : "Failed to disconnect GitHub.",
          "error",
          4200,
        );
      } finally {
        setDisconnectingOwnerConnectionId(null);
      }
    },
    [loadGithub, setActionNotice],
  );

  const handleConnectAgentGithub = useCallback(
    async (agentId: string) => {
      const popup = openWebOauthPopup();
      if (isWebPlatform() && !popup) {
        setActionNotice(
          "Popup blocked. Please allow popups and try again.",
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
          "Finish GitHub authorization in your browser, then return here.",
          "info",
          5000,
        );
      } catch (cause) {
        popup?.close();
        setActionNotice(
          cause instanceof Error
            ? cause.message
            : "Failed to start agent GitHub setup.",
          "error",
          4200,
        );
      } finally {
        setBusyAgentGithubId(null);
      }
    },
    [setActionNotice],
  );

  useEffect(() => {
    drainLifeOpsGithubCallbacks().forEach(handleGithubCallback);

    const handleCallbackEvent = (event: Event) => {
      const detail = (event as CustomEvent<LifeOpsGithubCallbackDetail>).detail;
      if (!detail) {
        return;
      }
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
        setActionNotice("Agent GitHub disconnected.", "success", 3200);
        await loadGithub();
      } catch (cause) {
        setActionNotice(
          cause instanceof Error
            ? cause.message
            : "Failed to disconnect agent GitHub.",
          "error",
          4200,
        );
      } finally {
        setBusyAgentGithubId(null);
      }
    },
    [loadGithub, setActionNotice],
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
    () => ({
      identity: elizaCloudConnected
        ? readGithubIdentity(primaryOwnerGithubConnection)
        : "Cloud required",
      status: elizaCloudConnected
        ? primaryOwnerGithubConnection
          ? "1 / 1"
          : githubLoading
            ? "Loading"
            : "0 / 1"
        : "Cloud required",
      connectLabel: primaryOwnerGithubConnection ? "Reconnect" : "Connect",
      connectDisabled: ownerGithubBusy || !elizaCloudConnected,
      disconnectDisabled:
        disconnectingOwnerConnectionId === primaryOwnerGithubConnection?.id,
      onConnect: elizaCloudConnected
        ? () => {
            void handleConnectOwnerGithub();
          }
        : undefined,
      onDisconnect: primaryOwnerGithubConnection
        ? () => {
            void handleDisconnectOwnerGithub(primaryOwnerGithubConnection.id);
          }
        : undefined,
    }),
    [
      disconnectingOwnerConnectionId,
      elizaCloudConnected,
      githubLoading,
      handleConnectOwnerGithub,
      handleDisconnectOwnerGithub,
      ownerGithubBusy,
      primaryOwnerGithubConnection,
    ],
  );
  const agentGithubSetup = useMemo(
    () => ({
      identity: elizaCloudConnected
        ? primaryAgentGithubEntry?.github?.connected
          ? readGithubIdentity({
              displayName: primaryAgentGithubEntry.github.githubDisplayName,
              username: primaryAgentGithubEntry.github.githubUsername,
              email: primaryAgentGithubEntry.github.githubEmail,
            })
          : primaryAgentGithubEntry?.agent.agent_name ?? "No cloud agent"
        : "Cloud required",
      status: elizaCloudConnected
        ? primaryAgentGithubEntry?.github?.connected
          ? "1 / 1"
          : primaryAgentGithubEntry
            ? "0 / 1"
            : githubLoading
              ? "Loading"
              : "No cloud agent"
        : "Cloud required",
      connectLabel:
        primaryAgentGithubEntry?.github?.connected ? "Reconnect" : "Connect",
      connectDisabled:
        !primaryAgentGithubEntry ||
        busyAgentGithubId === primaryAgentGithubEntry.agent.agent_id,
      disconnectDisabled:
        !primaryAgentGithubEntry ||
        busyAgentGithubId === primaryAgentGithubEntry.agent.agent_id,
      onConnect:
        elizaCloudConnected && primaryAgentGithubEntry
          ? () => {
              void handleConnectAgentGithub(
                primaryAgentGithubEntry.agent.agent_id,
              );
            }
          : undefined,
      onDisconnect:
        elizaCloudConnected &&
        primaryAgentGithubEntry?.github?.connected &&
        primaryAgentGithubEntry
          ? () => {
              void handleDisconnectAgentGithub(
                primaryAgentGithubEntry.agent.agent_id,
              );
            }
          : undefined,
    }),
    [
      busyAgentGithubId,
      elizaCloudConnected,
      githubLoading,
      handleConnectAgentGithub,
      handleDisconnectAgentGithub,
      primaryAgentGithubEntry,
    ],
  );

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
          <section className="overflow-hidden rounded-3xl border border-border/16 bg-card/18">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 px-4 py-4 text-left"
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
              <div className="space-y-6 border-t border-border/12 px-4 pb-4 pt-4">
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
