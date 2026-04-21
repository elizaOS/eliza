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
  CalendarDays,
  ChevronDown,
  ListChecks,
  Mail,
  MessageCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LIFEOPS_GITHUB_CALLBACK_EVENT,
  type LifeOpsGithubCallbackDetail,
} from "../events/index.js";
import { useLifeOpsAppState } from "../hooks/useLifeOpsAppState.js";
import {
  consumeQueuedLifeOpsGithubCallback,
  dispatchLifeOpsGithubCallbackFromWindowMessage,
  drainLifeOpsGithubCallbacks,
} from "../platform/lifeops-github.js";
import type { ManagedAgentGithubEntry } from "./LifeOpsPageSections";
import { LifeOpsSettingsSection } from "./LifeOpsSettingsSection";
import { LifeOpsWorkspaceView } from "./LifeOpsWorkspaceView";
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

export function LifeOpsPageView() {
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
            ? t("lifeopspage.enabled", {
                defaultValue: "LifeOps enabled.",
              })
            : t("lifeopspage.disabled", {
                defaultValue: "LifeOps disabled.",
              }),
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
    () => ({
      identity: elizaCloudConnected
        ? readGithubIdentity(primaryOwnerGithubConnection, t)
        : t("lifeopspage.cloudRequired", {
            defaultValue: "Cloud required",
          }),
      status: elizaCloudConnected
        ? primaryOwnerGithubConnection
          ? "1 / 1"
          : githubLoading
            ? t("common.loading", {
                defaultValue: "Loading",
              })
            : "0 / 1"
        : t("lifeopspage.cloudRequired", {
            defaultValue: "Cloud required",
          }),
      connectLabel: primaryOwnerGithubConnection
        ? t("common.reconnect", {
            defaultValue: "Reconnect",
          })
        : t("common.connect", {
            defaultValue: "Connect",
          }),
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
      t,
    ],
  );
  const agentGithubSetup = useMemo(
    () => ({
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
            t("lifeopspage.noCloudAgent", {
              defaultValue: "No cloud agent",
            }))
        : t("lifeopspage.cloudRequired", {
            defaultValue: "Cloud required",
          }),
      status: elizaCloudConnected
        ? primaryAgentGithubEntry?.github?.connected
          ? "1 / 1"
          : primaryAgentGithubEntry
            ? "0 / 1"
            : githubLoading
              ? t("common.loading", {
                  defaultValue: "Loading",
                })
              : t("lifeopspage.noCloudAgent", {
                  defaultValue: "No cloud agent",
                })
        : t("lifeopspage.cloudRequired", {
            defaultValue: "Cloud required",
          }),
      connectLabel: primaryAgentGithubEntry?.github?.connected
        ? t("common.reconnect", {
            defaultValue: "Reconnect",
          })
        : t("common.connect", {
            defaultValue: "Connect",
          }),
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
      t,
    ],
  );

  const showEnablePrompt =
    !lifeOpsApp.loading && !lifeOpsApp.error && !appEnabled;

  return (
    <div
      className="space-y-6 px-4 py-4 sm:px-6 sm:py-5 lg:px-8 lg:py-6"
      data-testid="lifeops-shell"
    >
      <div className="space-y-4">
        <PagePanel.Header
          heading={t("nav.lifeops", {
            defaultValue: "LifeOps",
          })}
          className="px-0 py-0 sm:px-0"
        />

        {lifeOpsApp.error ? (
          <PagePanel.Notice tone="danger">{lifeOpsApp.error}</PagePanel.Notice>
        ) : null}

        {lifeOpsApp.loading ? (
          <PagePanel.Loading
            variant="surface"
            heading={t("lifeopspage.loadingState", {
              defaultValue: "Loading LifeOps app state",
            })}
          />
        ) : null}

        {appEnabled && !runtimeReady ? (
          <PagePanel.Loading
            variant="surface"
            heading={t("lifeopspage.waitingRuntime", {
              defaultValue: "Waiting for LifeOps runtime",
            })}
          />
        ) : null}
      </div>

      {showEnablePrompt ? (
        <section className="space-y-5 rounded-3xl border border-border/16 bg-card/18 px-4 py-6 sm:px-6 sm:py-7">
          <div className="space-y-2">
            <div className="text-base font-semibold text-txt">
              {t("lifeopspage.enableTitle", {
                defaultValue:
                  "Your personal assistant for calendar, email, and routines",
              })}
            </div>
            <div className="text-sm leading-relaxed text-muted">
              {t("lifeopspage.enableDescription", {
                defaultValue:
                  "Enable LifeOps to let the agent triage email, manage your calendar, and keep your goals and reminders on track. You pick which accounts and permissions to connect after turning it on.",
              })}
            </div>
          </div>

          <ul className="grid gap-3 sm:grid-cols-2">
            <li className="flex items-start gap-3 rounded-2xl bg-bg/36 px-3 py-3">
              <Mail className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
              <div>
                <div className="text-sm font-medium text-txt">
                  {t("lifeopspage.gmailTitle", {
                    defaultValue: "Gmail triage",
                  })}
                </div>
                <div className="text-xs text-muted">
                  {t("lifeopspage.gmailDescription", {
                    defaultValue:
                      "Spot replies that need you and draft responses for review.",
                  })}
                </div>
              </div>
            </li>
            <li className="flex items-start gap-3 rounded-2xl bg-bg/36 px-3 py-3">
              <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
              <div>
                <div className="text-sm font-medium text-txt">
                  {t("lifeopspage.calendarTitle", {
                    defaultValue: "Calendar",
                  })}
                </div>
                <div className="text-xs text-muted">
                  {t("lifeopspage.calendarDescription", {
                    defaultValue:
                      "See today and the week ahead. Create events without leaving the app.",
                  })}
                </div>
              </div>
            </li>
            <li className="flex items-start gap-3 rounded-2xl bg-bg/36 px-3 py-3">
              <ListChecks className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
              <div>
                <div className="text-sm font-medium text-txt">
                  {t("lifeopspage.goalsTitle", {
                    defaultValue: "Goals & reminders",
                  })}
                </div>
                <div className="text-xs text-muted">
                  {t("lifeopspage.goalsDescription", {
                    defaultValue:
                      "Track habits, goals, and routines with gentle follow-ups.",
                  })}
                </div>
              </div>
            </li>
            <li className="flex items-start gap-3 rounded-2xl bg-bg/36 px-3 py-3">
              <MessageCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
              <div>
                <div className="text-sm font-medium text-txt">
                  {t("lifeopspage.messagingTitle", {
                    defaultValue: "Messaging",
                  })}
                </div>
                <div className="text-xs text-muted">
                  {t("lifeopspage.messagingDescription", {
                    defaultValue:
                      "Connect Signal, Discord, Telegram, or iMessage so the agent can reach you.",
                  })}
                </div>
              </div>
            </li>
          </ul>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button
              size="sm"
              className="rounded-full px-5 py-2 text-xs-tight font-semibold"
              onClick={() => void handleSetLifeOpsEnabled(true)}
              disabled={lifeOpsApp.loading || lifeOpsApp.saving}
            >
              {lifeOpsApp.saving
                ? t("lifeopspage.enabling", {
                    defaultValue: "Enabling…",
                  })
                : t("lifeopspage.enable", {
                    defaultValue: "Enable LifeOps",
                  })}
            </Button>
            <span className="text-xs text-muted">
              {t("lifeopspage.disableHint", {
                defaultValue: "You can disable LifeOps at any time.",
              })}
            </span>
          </div>
        </section>
      ) : null}

      {appEnabled && runtimeReady ? (
        <>
          <section className="overflow-hidden rounded-3xl border border-border/16 bg-card/18">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 px-4 py-4 text-left"
              onClick={() => setSetupOpen((current) => !current)}
              aria-expanded={setupOpen}
            >
              <div>
                <div className="text-sm font-semibold text-txt">
                  {t("lifeopspage.setupTitle", {
                    defaultValue: "Setup",
                  })}
                </div>
                <div className="mt-0.5 text-xs text-muted">
                  {t("lifeopspage.setupDescription", {
                    defaultValue:
                      "Connect Google, GitHub, and messaging accounts.",
                  })}
                </div>
              </div>
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

      {appEnabled ? (
        <div className="flex justify-end border-t border-border/16 pt-2">
          <Button
            variant="surfaceDestructive"
            size="sm"
            className="rounded-full px-4 text-xs-tight font-semibold"
            onClick={() => void handleSetLifeOpsEnabled(false)}
            disabled={lifeOpsApp.loading || lifeOpsApp.saving}
          >
            {t("lifeopspage.disable", {
              defaultValue: "Disable LifeOps",
            })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
