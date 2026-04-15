import type { LifeOpsOverview } from "@elizaos/shared/contracts/lifeops";
import { Button, PagePanel } from "@elizaos/app-core";
import {
  BellRing,
  Bot,
  ExternalLink,
  Github,
  ListTodo,
  Shield,
  Target,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import {
  AgentGithubCard,
  GoalList,
  OccurrenceList,
  occurrenceSortValue,
  OwnerGithubConnectionCard,
  ReminderList,
  SectionSurface,
} from "./LifeOpsPageSections";
import type { ManagedAgentGithubEntry } from "./LifeOpsPageSections";
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
  const [overview, setOverview] = useState<LifeOpsOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
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

  const loadOverview = useCallback(async () => {
    if (!appEnabled) {
      setOverview(null);
      setOverviewError(null);
      setOverviewLoading(false);
      return;
    }
    if (!runtimeReady) {
      return;
    }
    setOverviewLoading(true);
    setOverviewError(null);
    try {
      const nextOverview = await client.getLifeOpsOverview();
      setOverview(nextOverview);
    } catch (cause) {
      setOverviewError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : "LifeOps overview failed to load.",
      );
    } finally {
      setOverviewLoading(false);
    }
  }, [appEnabled, runtimeReady]);

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
    void loadOverview();
  }, [loadOverview]);

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
          setOverview(null);
          setOverviewError(null);
          setOwnerGithubConnections([]);
          setAgentGithubEntries([]);
          setGithubError(null);
        }
        setActionNotice(
          nextEnabled
            ? "LifeOps enabled for this agent. The chat widgets will appear in Chat."
            : "LifeOps disabled for this agent.",
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
        cause instanceof Error
          ? cause.message
          : "Failed to start GitHub setup.",
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
          cause instanceof Error
            ? cause.message
            : "Failed to disconnect GitHub.",
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

  const ownerOccurrences = useMemo(
    () =>
      [...(overview?.owner.occurrences ?? [])]
        .sort(
          (left, right) =>
            occurrenceSortValue(left) - occurrenceSortValue(right),
        )
        .slice(0, 5),
    [overview?.owner.occurrences],
  );
  const agentOccurrences = useMemo(
    () =>
      [...(overview?.agentOps.occurrences ?? [])]
        .sort(
          (left, right) =>
            occurrenceSortValue(left) - occurrenceSortValue(right),
        )
        .slice(0, 4),
    [overview?.agentOps.occurrences],
  );
  const ownerGoals = useMemo(
    () => (overview?.owner.goals ?? []).slice(0, 4),
    [overview?.owner.goals],
  );
  const ownerReminders = useMemo(
    () => (overview?.owner.reminders ?? []).slice(0, 4),
    [overview?.owner.reminders],
  );

  return (
    <div
      className="space-y-6 px-4 py-4 sm:px-6 sm:py-5 lg:px-8 lg:py-6"
      data-testid="lifeops-shell"
    >
      <div className="space-y-4">
        <PagePanel.Header
          eyebrow="LifeOps"
          heading="Personal Operations"
          className="px-0 py-0 sm:px-0"
        />

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

        {!lifeOpsApp.loading && !appEnabled ? (
          <div className="py-4 text-center text-sm text-muted/60">
            LifeOps is disabled.
          </div>
        ) : null}

        {appEnabled && !runtimeReady && !overview ? (
          <PagePanel.Loading
            variant="surface"
            heading="Waiting for LifeOps runtime"
          />
        ) : null}

        {appEnabled && overviewError ? (
          <PagePanel.Notice tone="danger">
            {overviewError}
          </PagePanel.Notice>
        ) : null}

        {appEnabled && overview ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <SectionSurface
              title="Current queue"
              icon={<ListTodo className="h-4 w-4" />}
            >
              <OccurrenceList occurrences={ownerOccurrences} />
            </SectionSurface>
            <SectionSurface
              title="Goals"
              icon={<Target className="h-4 w-4" />}
            >
              <GoalList goals={ownerGoals} />
            </SectionSurface>
            <SectionSurface
              title="Reminders"
              icon={<BellRing className="h-4 w-4" />}
            >
              <ReminderList reminders={ownerReminders} />
            </SectionSurface>
            <SectionSurface
              title="Agent operations"
              icon={<Bot className="h-4 w-4" />}
            >
              <OccurrenceList occurrences={agentOccurrences} />
            </SectionSurface>
          </div>
        ) : null}
      </div>

      {appEnabled ? <LifeOpsSettingsSection /> : null}

      {appEnabled ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-muted">
              <Github className="h-4 w-4" />
              <div className="text-xs font-semibold uppercase tracking-wide">GitHub</div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={openCloudAgents}
            >
              Open Cloud
            </Button>
          </div>

          {!elizaCloudConnected ? (
            <div className="py-3 text-xs text-muted/60">Connect Eliza Cloud to manage GitHub identities.</div>
          ) : (
            <>
              {githubError ? (
                <div className="rounded-lg border border-danger/50 bg-danger/10 px-3 py-1.5 text-xs text-danger">
                  {githubError}
                </div>
              ) : null}
              {githubLoading &&
              ownerGithubConnections.length === 0 &&
              agentGithubEntries.length === 0 ? (
                <div className="py-3 text-xs text-muted/60">Loading GitHub identities…</div>
              ) : null}

              <div className="grid gap-4 xl:grid-cols-2">
                <SectionSurface
                  title="LifeOps GitHub"
                  icon={<Github className="h-4 w-4" />}
                >
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="default"
                      size="sm"
                      disabled={ownerGithubBusy}
                      onClick={() => void handleConnectOwnerGithub()}
                    >
                      <ExternalLink className="mr-1.5 h-3 w-3" />
                      {ownerGithubConnections.length > 0
                        ? "Reconnect"
                        : "Connect"}
                    </Button>
                  </div>
                  {ownerGithubConnections.length === 0 ? (
                    <div className="py-1 text-xs text-muted/60">
                      Not linked yet.
                    </div>
                  ) : (
                    ownerGithubConnections.map((connection) => (
                      <OwnerGithubConnectionCard
                        key={connection.id}
                        connection={connection}
                        busy={disconnectingOwnerConnectionId === connection.id}
                        onDisconnect={handleDisconnectOwnerGithub}
                      />
                    ))
                  )}
                </SectionSurface>

                <SectionSurface
                  title="Agent GitHub"
                  icon={<Shield className="h-4 w-4" />}
                >
                  {agentGithubEntries.length === 0 ? (
                    <div className="py-1 text-xs text-muted/60">
                      No cloud agents yet.
                    </div>
                  ) : (
                    agentGithubEntries.map((entry) => (
                      <AgentGithubCard
                        key={entry.agent.agent_id}
                        entry={entry}
                        ownerConnections={ownerGithubConnections}
                        busyAgentId={busyAgentGithubId}
                        onConnect={handleConnectAgentGithub}
                        onDisconnect={handleDisconnectAgentGithub}
                        onUseOwnerConnection={handleUseOwnerGithub}
                      />
                    ))
                  )}
                </SectionSurface>
              </div>
            </>
          )}
        </div>
      ) : null}

      {appEnabled ? <LifeOpsWorkspaceView /> : null}

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
