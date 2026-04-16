import { Button, PagePanel } from "@elizaos/app-core";
import { client, type CloudOAuthConnection } from "@elizaos/app-core";
import {
  LIFEOPS_GITHUB_CALLBACK_EVENT,
  type LifeOpsGithubCallbackDetail,
} from "@elizaos/app-core";
import {
  consumeQueuedLifeOpsGithubCallback,
  dispatchLifeOpsGithubCallbackFromWindowMessage,
  drainLifeOpsGithubCallbacks,
  isWebPlatform,
} from "@elizaos/app-core";
import { useLifeOpsAppState } from "@elizaos/app-core";
import { useApp } from "@elizaos/app-core";
import { openExternalUrl } from "@elizaos/app-core";
import { Github } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ManagedAgentGithubEntry } from "./LifeOpsPageSections";
import { LifeOpsBrowserSetupPanel } from "./LifeOpsBrowserSetupPanel";
import { LifeOpsSettingsSection } from "./LifeOpsSettingsSection";
import { LifeOpsWorkspaceView } from "./LifeOpsWorkspaceView";

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

function CompactGithubRow({
  label,
  value,
  status,
  actions,
}: {
  label: string;
  value: string;
  status: string;
  actions?: ReactNode;
}) {
  return (
    <div className="grid gap-3 border-t border-border/12 px-4 py-4 first:border-t-0 xl:grid-cols-[72px_minmax(0,1fr)_auto] xl:items-center">
      <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">
        {label}
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-txt">{value}</div>
        <div className="mt-1 text-xs text-muted">{status}</div>
      </div>
      <div className="flex flex-wrap items-center justify-start gap-2 xl:justify-end">
        {actions}
      </div>
    </div>
  );
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

  const refreshAll = useCallback(async () => {
    await Promise.all([loadOverview(), loadGithub()]);
  }, [loadGithub, loadOverview]);

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

  const handleUseOwnerGithub = useCallback(
    async (agentId: string, connectionId: string) => {
      setBusyAgentGithubId(agentId);
      try {
        const response = await client.linkCloudCompatAgentManagedGithub(
          agentId,
          connectionId,
        );
        setAgentGithubEntries((current) =>
          current.map((entry) =>
            entry.agent.agent_id === agentId
              ? { ...entry, github: response.data }
              : entry,
          ),
        );
        setActionNotice(
          response.data.restarted
            ? "Agent is using the LifeOps GitHub account and the cloud runtime is restarting."
            : "Agent is using the LifeOps GitHub account.",
          "success",
          4200,
        );
        await loadGithub();
      } catch (cause) {
        setActionNotice(
          cause instanceof Error
            ? cause.message
            : "Failed to link the LifeOps GitHub account to this agent.",
          "error",
          4200,
        );
      } finally {
        setBusyAgentGithubId(null);
      }
    },
    [loadGithub, setActionNotice],
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
          <LifeOpsSettingsSection />

          <LifeOpsWorkspaceView />

          <div className="space-y-4">
            <section className="overflow-hidden rounded-3xl border border-border/16 bg-card/18">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/12 px-4 py-4">
                <div className="flex items-center gap-2 text-txt">
                  <Github className="h-4 w-4 text-muted" />
                  <div className="text-sm font-semibold">GitHub</div>
                </div>
                {!elizaCloudConnected ? (
                  <Button variant="outline" size="sm" onClick={openCloudAgents}>
                    Open Cloud
                  </Button>
                ) : null}
              </div>

              {githubError ? (
                <div className="border-b border-danger/20 bg-danger/8 px-4 py-2 text-xs text-danger">
                  {githubError}
                </div>
              ) : null}

              <CompactGithubRow
                label="User"
                value={
                  elizaCloudConnected
                    ? readGithubIdentity(primaryOwnerGithubConnection)
                    : "Cloud required"
                }
                status={
                  elizaCloudConnected
                    ? primaryOwnerGithubConnection
                      ? "1 / 1"
                      : githubLoading
                        ? "Loading"
                        : "0 / 1"
                    : "Cloud required"
                }
                actions={
                  elizaCloudConnected ? (
                    <>
                      <Button
                        variant="default"
                        size="sm"
                        className="rounded-xl px-3 text-xs font-semibold"
                        disabled={ownerGithubBusy}
                        onClick={() => void handleConnectOwnerGithub()}
                      >
                        {primaryOwnerGithubConnection ? "Reconnect" : "Connect"}
                      </Button>
                      {primaryOwnerGithubConnection ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="rounded-xl px-3 text-xs font-semibold"
                          disabled={
                            disconnectingOwnerConnectionId ===
                            primaryOwnerGithubConnection.id
                          }
                          onClick={() =>
                            void handleDisconnectOwnerGithub(
                              primaryOwnerGithubConnection.id,
                            )
                          }
                        >
                          Disconnect
                        </Button>
                      ) : null}
                    </>
                  ) : null
                }
              />

              <CompactGithubRow
                label="Agent"
                value={
                  elizaCloudConnected
                    ? primaryAgentGithubEntry?.github?.connected
                      ? readGithubIdentity({
                          displayName:
                            primaryAgentGithubEntry.github.githubDisplayName,
                          username:
                            primaryAgentGithubEntry.github.githubUsername,
                          email: primaryAgentGithubEntry.github.githubEmail,
                        })
                      : primaryAgentGithubEntry?.agent.agent_name ?? "No cloud agent"
                    : "Cloud required"
                }
                status={
                  elizaCloudConnected
                    ? primaryAgentGithubEntry?.github?.connected
                      ? "1 / 1"
                      : primaryAgentGithubEntry
                        ? "0 / 1"
                        : githubLoading
                          ? "Loading"
                          : "No cloud agent"
                    : "Cloud required"
                }
                actions={
                  elizaCloudConnected && primaryAgentGithubEntry ? (
                    <>
                      <Button
                        variant="default"
                        size="sm"
                        className="rounded-xl px-3 text-xs font-semibold"
                        disabled={
                          busyAgentGithubId === primaryAgentGithubEntry.agent.agent_id
                        }
                        onClick={() =>
                          void handleConnectAgentGithub(
                            primaryAgentGithubEntry.agent.agent_id,
                          )
                        }
                      >
                        {primaryAgentGithubEntry.github?.connected
                          ? "Reconnect"
                          : "Connect"}
                      </Button>
                      {primaryOwnerGithubConnection ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="rounded-xl px-3 text-xs font-semibold"
                          disabled={
                            busyAgentGithubId === primaryAgentGithubEntry.agent.agent_id
                          }
                          onClick={() =>
                            void handleUseOwnerGithub(
                              primaryAgentGithubEntry.agent.agent_id,
                              primaryOwnerGithubConnection.id,
                            )
                          }
                        >
                          Use user GitHub
                        </Button>
                      ) : null}
                      {primaryAgentGithubEntry.github?.connected ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="rounded-xl px-3 text-xs font-semibold"
                          disabled={
                            busyAgentGithubId === primaryAgentGithubEntry.agent.agent_id
                          }
                          onClick={() =>
                            void handleDisconnectAgentGithub(
                              primaryAgentGithubEntry.agent.agent_id,
                            )
                          }
                        >
                          Disconnect
                        </Button>
                      ) : null}
                    </>
                  ) : null
                }
              />
            </section>

            <LifeOpsBrowserSetupPanel />
          </div>
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
