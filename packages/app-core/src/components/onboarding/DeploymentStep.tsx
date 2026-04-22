import { Button, Card, CardContent, Input, Spinner } from "@elizaos/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../../api";
import type {
  CloudCompatAgent,
  CloudCompatJob,
} from "../../api/client-types-cloud";
import {
  discoverGatewayEndpoints,
  type GatewayDiscoveryEndpoint,
  gatewayEndpointToApiBase,
} from "../../bridge/gateway-discovery";
import { persistMobileRuntimeModeForServerTarget } from "../../onboarding/mobile-runtime-mode";
import type { OnboardingServerTarget } from "../../onboarding/server-target";
import { isDesktopPlatform } from "../../platform/init";
import {
  addAgentProfile,
  clearPersistedActiveServer,
  savePersistedActiveServer,
  useApp,
} from "../../state";
import {
  OnboardingSecondaryActionButton,
  onboardingBodyTextShadowStyle,
  onboardingTextShadowStyle,
} from "./onboarding-step-chrome";

const MONO_FONT = "'Courier New', 'Courier', 'Monaco', monospace";

export function shouldShowLocalDeploymentOption(args: {
  isDesktop: boolean;
  isDevelopment: boolean;
}): boolean {
  return args.isDesktop || args.isDevelopment;
}

type SubView = "chooser" | "cloud" | "remote";
type CloudDeploymentTarget = Extract<
  OnboardingServerTarget,
  "elizacloud" | "elizacloud-hybrid"
>;

type CloudStage =
  | "login"
  | "loading"
  | "agent-list"
  | "creating"
  | "provisioning"
  | "connecting";

function statusBadge(status: string): { label: string; className: string } {
  switch (status) {
    case "running":
      return { label: "LIVE", className: "bg-ok text-white" };
    case "provisioning":
    case "queued":
      return { label: "STARTING", className: "bg-warn text-black" };
    case "stopped":
    case "suspended":
      return { label: "STOPPED", className: "bg-black/20 text-black/70" };
    case "failed":
      return { label: "FAILED", className: "bg-danger text-white" };
    default:
      return {
        label: status.toUpperCase(),
        className: "bg-black/10 text-black/60",
      };
  }
}

export function DeploymentStep() {
  const {
    setState,
    handleOnboardingNext,
    elizaCloudConnected,
    elizaCloudLoginBusy,
    handleCloudLogin,
    startupCoordinator,
    t,
  } = useApp();

  const [subView, setSubView] = useState<SubView>("chooser");
  const [cloudTarget, setCloudTarget] =
    useState<CloudDeploymentTarget>("elizacloud");
  const [_discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveredGateways, setDiscoveredGateways] = useState<
    GatewayDiscoveryEndpoint[]
  >([]);

  // Cloud sub-view state
  const [cloudStage, setCloudStage] = useState<CloudStage>(
    elizaCloudConnected ? "loading" : "login",
  );
  const [agents, setAgents] = useState<CloudCompatAgent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newAgentName, setNewAgentName] = useState("");
  const [provisionStatus, setProvisionStatus] = useState("");
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Remote sub-view state
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteToken, setRemoteToken] = useState("");

  const showCreateLocal = shouldShowLocalDeploymentOption({
    isDesktop: isDesktopPlatform(),
    isDevelopment: Boolean(import.meta.env.DEV),
  });

  // ── Gateway discovery ──────────────────────────────────────────────
  useEffect(() => {
    if (subView !== "chooser") return;
    let cancelled = false;
    setDiscoveryLoading(true);

    discoverGatewayEndpoints()
      .then((endpoints) => {
        if (!cancelled) setDiscoveredGateways(endpoints);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setDiscoveryLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [subView]);

  // ── Cleanup poll on unmount ────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  // ── Cloud: auto-advance from login when connected ──────────────────
  useEffect(() => {
    if (elizaCloudConnected && cloudStage === "login") {
      setCloudStage("loading");
    }
  }, [elizaCloudConnected, cloudStage]);

  // ── Cloud: fetch agents ────────────────────────────────────────────
  useEffect(() => {
    if (subView !== "cloud" || cloudStage !== "loading") return;
    let cancelled = false;

    (async () => {
      try {
        const res = await client.getCloudCompatAgents();
        if (cancelled) return;
        if (res.success) {
          setAgents(res.data);
          setCloudStage("agent-list");
        } else {
          setError("Failed to load agents");
          setCloudStage("agent-list");
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load agents");
        setCloudStage("agent-list");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [subView, cloudStage]);

  // ── Handlers: chooser ──────────────────────────────────────────────

  const handleCreateLocal = useCallback(() => {
    client.setBaseUrl(null);
    client.setToken(null);
    clearPersistedActiveServer();
    persistMobileRuntimeModeForServerTarget("local");
    setState("onboardingServerTarget", "local");
    // Dispatch SPLASH_CONTINUE to start the local agent runtime
    startupCoordinator.dispatch({ type: "SPLASH_CONTINUE" });
    handleOnboardingNext();
  }, [setState, startupCoordinator, handleOnboardingNext]);

  const handleConnectGateway = useCallback(
    (gateway: GatewayDiscoveryEndpoint) => {
      const apiBase = gatewayEndpointToApiBase(gateway);
      client.setBaseUrl(apiBase);
      client.setToken(null);
      savePersistedActiveServer({
        id: `gateway:${gateway.stableId}`,
        kind: "remote",
        label: gateway.name,
        apiBase,
      });
      addAgentProfile({
        kind: "remote",
        label: gateway.name,
        apiBase,
      });
      persistMobileRuntimeModeForServerTarget("remote");
      setState("onboardingServerTarget", "remote");
      startupCoordinator.dispatch({ type: "SPLASH_CONTINUE" });
      handleOnboardingNext();
    },
    [setState, startupCoordinator, handleOnboardingNext],
  );

  // ── Handlers: cloud ────────────────────────────────────────────────

  const handleOpenCloud = useCallback((target: CloudDeploymentTarget) => {
    setCloudTarget(target);
    persistMobileRuntimeModeForServerTarget(target);
    setSubView("cloud");
  }, []);

  const handleOpenRemote = useCallback(() => {
    persistMobileRuntimeModeForServerTarget("remote");
    setSubView("remote");
  }, []);

  const handleLogin = useCallback(async () => {
    setError(null);
    await handleCloudLogin();
  }, [handleCloudLogin]);

  const connectToAgent = useCallback(
    (agent: CloudCompatAgent) => {
      setCloudStage("connecting");

      const apiBase = agent.web_ui_url ?? agent.webUiUrl ?? agent.bridge_url;
      savePersistedActiveServer({
        id: `cloud:${agent.agent_id}`,
        kind: "cloud",
        label: agent.agent_name,
        ...(apiBase ? { apiBase } : {}),
      });
      addAgentProfile({
        kind: "cloud",
        label: agent.agent_name,
        cloudAgentId: agent.agent_id,
        apiBase: apiBase ?? undefined,
      });

      if (apiBase) {
        client.setBaseUrl(apiBase);
      }
      persistMobileRuntimeModeForServerTarget(cloudTarget);
      setState("onboardingServerTarget", cloudTarget);
      startupCoordinator.dispatch({ type: "SPLASH_CLOUD_SKIP" });
      handleOnboardingNext();
    },
    [cloudTarget, setState, startupCoordinator, handleOnboardingNext],
  );

  const handleCreate = useCallback(async () => {
    const name = newAgentName.trim();
    if (!name) return;

    setError(null);
    setCloudStage("creating");

    try {
      const createRes = await client.createCloudCompatAgent({
        agentName: name,
      });
      if (!createRes.success || !createRes.data) {
        setError("Failed to create agent");
        setCloudStage("agent-list");
        return;
      }

      const agentId = createRes.data.agentId;
      if (!agentId) {
        setError("Agent created but no ID returned");
        setCloudStage("agent-list");
        return;
      }

      setCloudStage("provisioning");
      setProvisionStatus("Starting provisioning...");
      const provRes = await client.provisionCloudCompatAgent(agentId);
      const jobId = provRes.data?.jobId;

      if (!jobId) {
        setProvisionStatus("Connecting...");
        const agentRes = await client.getCloudCompatAgent(agentId);
        if (agentRes.success) {
          connectToAgent(agentRes.data);
        } else {
          setError("Provisioning completed but agent not found");
          setCloudStage("agent-list");
        }
        return;
      }

      pollTimerRef.current = setInterval(async () => {
        try {
          const jobRes = await client.getCloudCompatJobStatus(jobId);
          if (!jobRes.success) return;

          const job: CloudCompatJob = jobRes.data;
          if (job.status === "completed") {
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
            setProvisionStatus("Connecting...");
            const agentRes = await client.getCloudCompatAgent(agentId);
            if (agentRes.success) {
              connectToAgent(agentRes.data);
            } else {
              setError("Agent provisioned but not found");
              setCloudStage("agent-list");
            }
          } else if (job.status === "failed") {
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
            setError(job.error ?? "Provisioning failed");
            setCloudStage("agent-list");
          } else {
            setProvisionStatus(`Provisioning (${job.status})...`);
          }
        } catch {
          // Transient error — keep polling
        }
      }, 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
      setCloudStage("agent-list");
    }
  }, [newAgentName, connectToAgent]);

  const handleRefresh = useCallback(() => {
    setError(null);
    setCloudStage("loading");
  }, []);

  // ── Handlers: remote ───────────────────────────────────────────────

  const handleRemoteConnect = useCallback(() => {
    const url = remoteUrl.trim();
    if (!url) return;

    client.setBaseUrl(url);
    const token = remoteToken.trim() || undefined;
    client.setToken(token ?? null);
    savePersistedActiveServer({
      id: `remote:${url}`,
      kind: "remote",
      label: url,
      apiBase: url,
      ...(token ? { accessToken: token } : {}),
    });
    addAgentProfile({
      kind: "remote",
      label: url,
      apiBase: url,
    });
    persistMobileRuntimeModeForServerTarget("remote");
    setState("onboardingServerTarget", "remote");
    startupCoordinator.dispatch({ type: "SPLASH_CONTINUE" });
    handleOnboardingNext();
  }, [
    remoteUrl,
    remoteToken,
    setState,
    startupCoordinator,
    handleOnboardingNext,
  ]);

  // ── Render: chooser ────────────────────────────────────────────────
  if (subView === "chooser") {
    const cardBase =
      "flex w-full cursor-pointer flex-col items-start gap-1.5 rounded-xl border px-5 py-4 text-left backdrop-blur-xl transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--onboarding-secondary-focus-ring)]";
    const cardDefault = `${cardBase} border-white/20 bg-white/[0.07] shadow-lg hover:border-white/35 hover:bg-white/[0.12]`;
    const cardRecommended = `${cardBase} border-[#f0b90b]/40 bg-[#f0b90b]/[0.1] shadow-lg hover:border-[#f0b90b]/60 hover:bg-[#f0b90b]/[0.18]`;

    return (
      <StepContainer>
        <StepHeader t={t} />

        <div className="mt-6 flex w-full flex-col gap-3 text-left">
          {/* Discovered gateways */}
          {discoveredGateways.length > 0 && (
            <div className="flex flex-col gap-3">
              {discoveredGateways.map((gateway) => (
                <Card
                  key={gateway.stableId}
                  className="rounded-xl border-white/20 bg-white/[0.07] shadow-lg backdrop-blur-xl"
                >
                  <CardContent className="flex items-center justify-between gap-3 px-5 py-4">
                    <div className="min-w-0">
                      <p
                        style={{ fontFamily: MONO_FONT }}
                        className="text-3xs uppercase text-white/60"
                      >
                        {gateway.isLocal
                          ? t("startupshell.LocalNetworkAgent", {
                              defaultValue: "LAN agent",
                            })
                          : t("startupshell.NetworkAgent", {
                              defaultValue: "Network agent",
                            })}
                      </p>
                      <p className="truncate text-sm font-semibold text-white/95">
                        {gateway.name}
                      </p>
                      <p className="truncate text-xs-tight text-white/50">
                        {gateway.host}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0 rounded-lg border-[#f0b90b]/40 bg-[#f0b90b]/15 text-[#fffaee] font-semibold hover:bg-[#f0b90b]/25 hover:border-[#f0b90b]/60"
                      onClick={() => handleConnectGateway(gateway)}
                    >
                      {t("startupshell.Connect", { defaultValue: "Connect" })}
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Create Local Agent */}
          {showCreateLocal && (
            <button
              type="button"
              className={cardRecommended}
              onClick={handleCreateLocal}
            >
              <span
                style={{ fontFamily: MONO_FONT }}
                className="text-3xs uppercase text-[#f0b90b]/80"
              >
                {t("startupshell.CreateAgentLabel", {
                  defaultValue: "New local agent",
                })}
              </span>
              <span className="text-sm font-bold text-white/95">
                {t("startupshell.CreateLocalAgent", {
                  defaultValue: "Create Local Agent",
                })}
              </span>
              <span className="text-xs-tight leading-snug text-white/60">
                {t("startupshell.CreateLocalAgentDesc", {
                  defaultValue: "Run an agent locally on this device",
                })}
              </span>
            </button>
          )}

          {/* Manage Cloud Agents */}
          <button
            type="button"
            className={cardDefault}
            onClick={() => handleOpenCloud("elizacloud")}
          >
            <span
              style={{ fontFamily: MONO_FONT }}
              className="text-3xs uppercase text-white/60"
            >
              {t("startupshell.ElizaCloudAgent", {
                defaultValue: "Eliza Cloud",
              })}
            </span>
            <span className="text-sm font-bold text-white/95">
              {t("startupshell.ManageCloudAgents", {
                defaultValue: "Run in Eliza Cloud",
              })}
            </span>
            <span className="text-xs-tight leading-snug text-white/60">
              {t("startupshell.ManageCloudAgentsDesc", {
                defaultValue: "Host the agent on Eliza Cloud infrastructure",
              })}
            </span>
          </button>

          <button
            type="button"
            className={cardDefault}
            onClick={() => handleOpenCloud("elizacloud-hybrid")}
          >
            <span
              style={{ fontFamily: MONO_FONT }}
              className="text-3xs uppercase text-white/60"
            >
              {t("startupshell.ElizaCloudHybridAgent", {
                defaultValue: "Cloud + phone compute",
              })}
            </span>
            <span className="text-sm font-bold text-white/95">
              {t("startupshell.RunCloudHybridAgent", {
                defaultValue: "Run in Cloud + Use This Phone",
              })}
            </span>
            <span className="text-xs-tight leading-snug text-white/60">
              {t("startupshell.RunCloudHybridAgentDesc", {
                defaultValue:
                  "Run the agent in Eliza Cloud and allow eligible local model work to use this device",
              })}
            </span>
          </button>

          {/* Connect to Remote */}
          <button
            type="button"
            className={cardDefault}
            onClick={handleOpenRemote}
          >
            <span
              style={{ fontFamily: MONO_FONT }}
              className="text-3xs uppercase text-white/60"
            >
              {t("startupshell.RemoteMacAgentLabel", {
                defaultValue: "Remote Mac",
              })}
            </span>
            <span className="text-sm font-bold text-white/95">
              {t("startupshell.ConnectToRemote", {
                defaultValue: "Connect to Your Mac",
              })}
            </span>
            <span className="text-xs-tight leading-snug text-white/60">
              {t("startupshell.ConnectToRemoteDesc", {
                defaultValue:
                  "Build to this phone and use the agent running on your Mac",
              })}
            </span>
          </button>
        </div>
      </StepContainer>
    );
  }

  // ── Render: cloud ──────────────────────────────────────────────────
  if (subView === "cloud") {
    return (
      <StepContainer>
        <StepHeader t={t} />

        {/* Login */}
        {cloudStage === "login" && (
          <div className="mt-4 flex w-full flex-col gap-3 text-left">
            <p
              style={{ fontFamily: MONO_FONT }}
              className="text-3xs uppercase text-white/60"
            >
              {t("startupshell.CloudLogin", {
                defaultValue: "Sign in to Eliza Cloud",
              })}
            </p>
            <Button
              type="button"
              variant="default"
              className="justify-center rounded-xl border border-[#f0b90b]/40 bg-[#f0b90b]/15 px-3 py-5 text-[#f0b90b] font-semibold shadow-lg hover:bg-[#f0b90b]/25 hover:border-[#f0b90b]/60"
              onClick={handleLogin}
              disabled={elizaCloudLoginBusy}
            >
              {elizaCloudLoginBusy ? (
                <span className="flex items-center gap-2">
                  <Spinner className="h-4 w-4" />
                  {t("startupshell.WaitingForAuth", {
                    defaultValue: "Waiting for auth...",
                  })}
                </span>
              ) : (
                t("startupshell.SignInElizaCloud", {
                  defaultValue: "Sign in with Eliza Cloud",
                })
              )}
            </Button>
            {error && (
              <p
                style={{ fontFamily: MONO_FONT }}
                className="text-3xs text-red-400"
              >
                {error}
              </p>
            )}
            <BackButton t={t} onClick={() => setSubView("chooser")} />
          </div>
        )}

        {/* Loading */}
        {cloudStage === "loading" && (
          <div className="mt-4 flex w-full flex-col items-center gap-3">
            <Spinner className="h-6 w-6 text-white/60" />
            <p
              style={{ fontFamily: MONO_FONT }}
              className="text-3xs uppercase text-white/50"
            >
              {t("startupshell.LoadingAgents", {
                defaultValue: "Loading agents...",
              })}
            </p>
          </div>
        )}

        {/* Creating / Provisioning / Connecting */}
        {(cloudStage === "creating" ||
          cloudStage === "provisioning" ||
          cloudStage === "connecting") && (
          <div className="mt-4 flex w-full flex-col items-center gap-3">
            <Spinner className="h-6 w-6 text-white/60" />
            <p
              style={{ fontFamily: MONO_FONT }}
              className="text-3xs uppercase text-white/50"
            >
              {cloudStage === "creating"
                ? t("startupshell.CreatingAgent", {
                    defaultValue: "Creating agent...",
                  })
                : cloudStage === "provisioning"
                  ? provisionStatus ||
                    t("startupshell.Provisioning", {
                      defaultValue: "Provisioning...",
                    })
                  : t("startupshell.Connecting", {
                      defaultValue: "Connecting...",
                    })}
            </p>
          </div>
        )}

        {/* Agent list */}
        {cloudStage === "agent-list" && (
          <div className="mt-4 flex w-full flex-col gap-3 text-left">
            <div className="flex items-center justify-between">
              <p
                style={{ fontFamily: MONO_FONT }}
                className="text-3xs uppercase text-white/60"
              >
                {t("startupshell.YourCloudAgents", {
                  defaultValue: "Your cloud agents",
                })}
              </p>
              <button
                type="button"
                onClick={handleRefresh}
                style={{ fontFamily: MONO_FONT }}
                className="text-3xs uppercase text-white/50 hover:text-white underline"
              >
                {t("startupshell.Refresh", { defaultValue: "Refresh" })}
              </button>
            </div>

            {error && (
              <p
                style={{ fontFamily: MONO_FONT }}
                className="text-3xs text-red-400"
              >
                {error}
              </p>
            )}

            {agents.length > 0 && (
              <div className="flex flex-col gap-2 max-h-48 overflow-y-auto">
                {agents.map((agent) => {
                  const badge = statusBadge(agent.status);
                  return (
                    <Card
                      key={agent.agent_id}
                      className="border border-white/20 bg-white/[0.07] shadow-lg backdrop-blur-xl"
                    >
                      <CardContent className="flex items-center justify-between gap-3 px-3 py-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-sm font-semibold text-white/95">
                              {agent.agent_name}
                            </p>
                            <span
                              className={`shrink-0 rounded px-1.5 py-0.5 text-2xs font-bold ${badge.className}`}
                            >
                              {badge.label}
                            </span>
                          </div>
                          {agent.web_ui_url && (
                            <p
                              style={{ fontFamily: MONO_FONT }}
                              className="truncate text-3xs text-white/50"
                            >
                              {agent.web_ui_url}
                            </p>
                          )}
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="shrink-0 rounded-lg border-[#f0b90b]/40 bg-[#f0b90b]/15 text-[#f0b90b] font-semibold hover:bg-[#f0b90b]/25 hover:border-[#f0b90b]/60"
                          onClick={() => connectToAgent(agent)}
                          disabled={agent.status === "failed"}
                        >
                          {t("startupshell.Connect", {
                            defaultValue: "Connect",
                          })}
                        </Button>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}

            {agents.length === 0 && !error && (
              <p
                style={{ fontFamily: MONO_FONT }}
                className="text-3xs text-white/50 text-center py-2"
              >
                {t("startupshell.NoCloudAgents", {
                  defaultValue: "No cloud agents yet",
                })}
              </p>
            )}

            {/* Inline create form */}
            <Card className="border border-dashed border-white/20 bg-white/[0.05]">
              <CardContent className="flex items-center gap-2 px-3 py-2.5">
                <Input
                  placeholder={t("startupshell.AgentName", {
                    defaultValue: "Agent name",
                  })}
                  value={newAgentName}
                  onChange={(e) => setNewAgentName(e.target.value)}
                  className="h-8 flex-1 border-white/20 bg-transparent text-white text-sm placeholder:text-white/40"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreate();
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0 rounded-lg border-[#f0b90b]/40 bg-[#f0b90b]/15 text-[#f0b90b] font-semibold hover:bg-[#f0b90b]/25 hover:border-[#f0b90b]/60"
                  onClick={handleCreate}
                  disabled={!newAgentName.trim()}
                >
                  {t("startupshell.CreateAgent", { defaultValue: "Create" })}
                </Button>
              </CardContent>
            </Card>

            <BackButton t={t} onClick={() => setSubView("chooser")} />
          </div>
        )}
      </StepContainer>
    );
  }

  // ── Render: remote ─────────────────────────────────────────────────
  return (
    <StepContainer>
      <StepHeader t={t} />

      <div className="mt-4 flex w-full flex-col gap-3 text-left">
        <p
          style={{ fontFamily: MONO_FONT }}
          className="text-3xs uppercase text-white/60"
        >
          {t("onboarding.deployment.remoteLabel", {
            defaultValue: "Connect to a remote agent",
          })}
        </p>

        <Input
          placeholder={t("onboarding.deployment.remoteUrlPlaceholder", {
            defaultValue: "https://your-agent.example.com",
          })}
          value={remoteUrl}
          onChange={(e) => setRemoteUrl(e.target.value)}
          className="h-10 border border-white/20 bg-transparent text-white text-sm placeholder:text-white/40"
        />

        <Input
          placeholder={t("onboarding.deployment.remoteTokenPlaceholder", {
            defaultValue: "Access token (optional)",
          })}
          type="password"
          value={remoteToken}
          onChange={(e) => setRemoteToken(e.target.value)}
          className="h-10 border border-white/20 bg-transparent text-white text-sm placeholder:text-white/40"
        />

        <Button
          type="button"
          variant="default"
          className="justify-center rounded-xl border border-[#f0b90b]/40 bg-[#f0b90b]/15 px-3 py-4 text-[#f0b90b] font-semibold shadow-lg hover:bg-[#f0b90b]/25 hover:border-[#f0b90b]/60"
          onClick={handleRemoteConnect}
          disabled={!remoteUrl.trim()}
        >
          {t("startupshell.Connect", { defaultValue: "Connect" })}
        </Button>

        <BackButton t={t} onClick={() => setSubView("chooser")} />
      </div>
    </StepContainer>
  );
}

// ── Shared layout primitives ───────────────────────────────────────────

function StepContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="w-full max-w-sm px-4 text-center">{children}</div>
    </div>
  );
}

function StepHeader({
  t,
}: {
  t: (key: string, values?: Record<string, unknown>) => string;
}) {
  return (
    <div>
      <h2
        style={{ fontFamily: MONO_FONT, ...onboardingTextShadowStyle }}
        className="text-xl font-light text-white/95"
      >
        {t("onboarding.deployment.title", {
          defaultValue: "Choose your setup",
        })}
      </h2>
      <p
        style={{ fontFamily: MONO_FONT, ...onboardingBodyTextShadowStyle }}
        className="text-3xs uppercase tracking-[0.2em] text-white/60 mt-2"
      >
        {t("onboarding.deployment.subtitle", {
          defaultValue: "Where should your agent run?",
        })}
      </p>
    </div>
  );
}

function BackButton({
  t,
  onClick,
}: {
  t: (key: string, values?: Record<string, unknown>) => string;
  onClick: () => void;
}) {
  return (
    <OnboardingSecondaryActionButton
      onClick={onClick}
      className="mt-2 self-center"
    >
      {t("startupshell.Back", { defaultValue: "Back" })}
    </OnboardingSecondaryActionButton>
  );
}
