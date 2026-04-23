/**
 * RuntimeGate — the single pre-chat setup screen.
 *
 * The only decision a user must make before they reach chat is:
 *   where does the agent run?
 *
 *   - Cloud: log into Eliza Cloud and pick (or auto-create) an agent
 *   - Local: start the bundled local agent runtime
 *   - Remote: point at an existing agent URL
 *
 * Everything else (LLM provider, subscriptions, connectors, capabilities)
 * happens inside the chat or from Settings. This replaces the old 3-step
 * wizard (deployment → providers → features) which layered a step nav,
 * language dropdown, and provider grid on top of what is really a single
 * binary-ish decision.
 *
 * On success this calls `completeOnboarding()` from `useApp`, which
 * dispatches `ONBOARDING_COMPLETE` to the startup coordinator and hands
 * control to the main app shell.
 */

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
import { normalizeLanguage } from "../../i18n";
import type { UiLanguage } from "../../i18n/messages";
import { persistMobileRuntimeModeForServerTarget } from "../../onboarding/mobile-runtime-mode";
import { isDesktopPlatform } from "../../platform/init";
import {
  addAgentProfile,
  clearPersistedActiveServer,
  savePersistedActiveServer,
  useApp,
} from "../../state";
import { LanguageDropdown } from "../shared/LanguageDropdown";

const MONO_FONT = "'Courier New', 'Courier', 'Monaco', monospace";

const DEFAULT_AUTO_AGENT_NAME = "My Agent";

function shouldShowLocalOption(isDesktop: boolean, isDev: boolean): boolean {
  return isDesktop || isDev;
}

type SubView = "chooser" | "cloud" | "remote";

type CloudStage =
  | "login"
  | "loading"
  | "auto-creating"
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

export function RuntimeGate() {
  const {
    setState,
    completeOnboarding,
    elizaCloudConnected,
    elizaCloudLoginBusy,
    handleCloudLogin,
    startupCoordinator,
    uiLanguage,
    t,
  } = useApp();

  const setUiLanguage = useCallback(
    (lang: UiLanguage) => setState("uiLanguage", normalizeLanguage(lang)),
    [setState],
  );

  const [subView, setSubView] = useState<SubView>("chooser");
  const [discoveredGateways, setDiscoveredGateways] = useState<
    GatewayDiscoveryEndpoint[]
  >([]);

  // Cloud sub-view
  const [cloudStage, setCloudStage] = useState<CloudStage>(
    elizaCloudConnected ? "loading" : "login",
  );
  const [agents, setAgents] = useState<CloudCompatAgent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [provisionStatus, setProvisionStatus] = useState("");
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Remote sub-view
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteToken, setRemoteToken] = useState("");

  const showLocalOption = shouldShowLocalOption(
    isDesktopPlatform(),
    Boolean(import.meta.env.DEV),
  );

  // ── Gateway discovery (LAN autodetect) ────────────────────────────
  useEffect(() => {
    if (subView !== "chooser") return;
    let cancelled = false;
    discoverGatewayEndpoints()
      .then((endpoints) => {
        if (!cancelled) setDiscoveredGateways(endpoints);
      })
      .catch(() => {
        // Discovery is best-effort; absence of LAN agents is not an error.
      });
    return () => {
      cancelled = true;
    };
  }, [subView]);

  // ── Cleanup poll on unmount ───────────────────────────────────────
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  // ── Cloud: auto-advance from login when connected ─────────────────
  useEffect(() => {
    if (elizaCloudConnected && cloudStage === "login") {
      setCloudStage("loading");
    }
  }, [elizaCloudConnected, cloudStage]);

  // ── Completion helpers ─────────────────────────────────────────────

  const finishAsCloud = useCallback(
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
      persistMobileRuntimeModeForServerTarget("elizacloud");
      setState("onboardingServerTarget", "elizacloud");
      startupCoordinator.dispatch({ type: "SPLASH_CLOUD_SKIP" });
      completeOnboarding();
    },
    [completeOnboarding, setState, startupCoordinator],
  );

  const finishAsLocal = useCallback(() => {
    client.setBaseUrl(null);
    client.setToken(null);
    clearPersistedActiveServer();
    persistMobileRuntimeModeForServerTarget("local");
    setState("onboardingServerTarget", "local");
    startupCoordinator.dispatch({ type: "SPLASH_CONTINUE" });
    completeOnboarding("settings");
  }, [completeOnboarding, setState, startupCoordinator]);

  const finishAsRemoteGateway = useCallback(
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
      addAgentProfile({ kind: "remote", label: gateway.name, apiBase });
      persistMobileRuntimeModeForServerTarget("remote");
      setState("onboardingServerTarget", "remote");
      startupCoordinator.dispatch({ type: "SPLASH_CONTINUE" });
      completeOnboarding();
    },
    [completeOnboarding, setState, startupCoordinator],
  );

  const finishAsRemote = useCallback(() => {
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
    addAgentProfile({ kind: "remote", label: url, apiBase: url });
    persistMobileRuntimeModeForServerTarget("remote");
    setState("onboardingServerTarget", "remote");
    startupCoordinator.dispatch({ type: "SPLASH_CONTINUE" });
    completeOnboarding();
  }, [
    remoteToken,
    remoteUrl,
    completeOnboarding,
    setState,
    startupCoordinator,
  ]);

  // ── Cloud: provision + connect ─────────────────────────────────────

  const provisionAndConnect = useCallback(
    async (agentId: string) => {
      setCloudStage("provisioning");
      setProvisionStatus(
        t("runtimegate.startingProvisioning", {
          defaultValue: "Starting provisioning...",
        }),
      );
      const provRes = await client.provisionCloudCompatAgent(agentId);
      const jobId = provRes.data?.jobId;

      if (!jobId) {
        setProvisionStatus(
          t("runtimegate.connecting", { defaultValue: "Connecting..." }),
        );
        const agentRes = await client.getCloudCompatAgent(agentId);
        if (agentRes.success) {
          finishAsCloud(agentRes.data);
        } else {
          setError("Provisioning completed but agent not found");
          setCloudStage("agent-list");
        }
        return;
      }

      pollTimerRef.current = setInterval(async () => {
        const jobRes = await client.getCloudCompatJobStatus(jobId);
        if (!jobRes.success) return;

        const job: CloudCompatJob = jobRes.data;
        if (job.status === "completed") {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
          setProvisionStatus(
            t("runtimegate.connecting", { defaultValue: "Connecting..." }),
          );
          const agentRes = await client.getCloudCompatAgent(agentId);
          if (agentRes.success) {
            finishAsCloud(agentRes.data);
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
      }, 2500);
    },
    [finishAsCloud, t],
  );

  // ── Cloud: auto-pick first agent, or auto-create one ─────────────
  // The user asked for a single-agent assumption during onboarding: if
  // they already have agents, pick the first one; if not, create one
  // named "My Agent" and connect. No list-selection UX during first run.
  useEffect(() => {
    if (subView !== "cloud" || cloudStage !== "loading") return;
    let cancelled = false;

    (async () => {
      const res = await client.getCloudCompatAgents();
      if (cancelled) return;

      if (!res.success) {
        setError(
          t("runtimegate.failedLoadAgents", {
            defaultValue: "Failed to load agents",
          }),
        );
        setCloudStage("agent-list");
        return;
      }

      const agentList = res.data;
      setAgents(agentList);

      if (agentList.length > 0) {
        const primary = agentList[0];
        if (primary) {
          finishAsCloud(primary);
          return;
        }
      }

      // No agents yet — auto-create "My Agent" and provision.
      setCloudStage("auto-creating");
      setError(null);
      const createRes = await client.createCloudCompatAgent({
        agentName: DEFAULT_AUTO_AGENT_NAME,
      });
      if (cancelled) return;
      if (!createRes.success || !createRes.data?.agentId) {
        setError(
          t("runtimegate.failedCreate", {
            defaultValue: "Failed to create agent. Try again.",
          }),
        );
        setCloudStage("agent-list");
        return;
      }

      await provisionAndConnect(createRes.data.agentId);
    })().catch((err) => {
      if (cancelled) return;
      setError(
        err instanceof Error
          ? err.message
          : t("runtimegate.unknownError", { defaultValue: "Unknown error" }),
      );
      setCloudStage("agent-list");
    });

    return () => {
      cancelled = true;
    };
  }, [subView, cloudStage, finishAsCloud, provisionAndConnect, t]);

  const handleLogin = useCallback(async () => {
    setError(null);
    await handleCloudLogin();
  }, [handleCloudLogin]);

  const handleRefreshAgents = useCallback(() => {
    setError(null);
    setCloudStage("loading");
  }, []);

  // ── Render: chooser ────────────────────────────────────────────────

  if (subView === "chooser") {
    return (
      <GateShell uiLanguage={uiLanguage} setUiLanguage={setUiLanguage} t={t}>
        <GateHeader t={t} />

        <div className="mt-6 flex w-full flex-col gap-3 text-left">
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
                      onClick={() => finishAsRemoteGateway(gateway)}
                    >
                      {t("startupshell.Connect", { defaultValue: "Connect" })}
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          <ChoiceCard
            recommended
            eyebrow={t("runtimegate.cloudEyebrow", {
              defaultValue: "Eliza Cloud",
            })}
            title={t("runtimegate.cloudTitle", {
              defaultValue: "Run in Eliza Cloud",
            })}
            description={t("runtimegate.cloudDesc", {
              defaultValue:
                "Hosted agent with managed LLMs and connectors. Fastest start.",
            })}
            onClick={() => setSubView("cloud")}
          />

          {showLocalOption && (
            <ChoiceCard
              eyebrow={t("runtimegate.localEyebrow", {
                defaultValue: "This device",
              })}
              title={t("runtimegate.localTitle", {
                defaultValue: "Run a local agent",
              })}
              description={t("runtimegate.localDesc", {
                defaultValue:
                  "Keep the agent on this machine. You'll pick a provider after start.",
              })}
              onClick={finishAsLocal}
            />
          )}

          <ChoiceCard
            eyebrow={t("runtimegate.remoteEyebrow", {
              defaultValue: "Remote agent",
            })}
            title={t("runtimegate.remoteTitle", {
              defaultValue: "Connect to an existing agent",
            })}
            description={t("runtimegate.remoteDesc", {
              defaultValue:
                "Point at an agent you're already running (e.g. on your Mac).",
            })}
            onClick={() => setSubView("remote")}
          />
        </div>
      </GateShell>
    );
  }

  // ── Render: cloud ──────────────────────────────────────────────────

  if (subView === "cloud") {
    return (
      <GateShell uiLanguage={uiLanguage} setUiLanguage={setUiLanguage} t={t}>
        <GateHeader t={t} />

        {cloudStage === "login" && (
          <div className="mt-4 flex w-full flex-col gap-3 text-left">
            <p
              style={{ fontFamily: MONO_FONT }}
              className="text-3xs uppercase text-white/60"
            >
              {t("runtimegate.cloudLoginEyebrow", {
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
                  {t("runtimegate.waitingForAuth", {
                    defaultValue: "Waiting for auth...",
                  })}
                </span>
              ) : (
                t("runtimegate.signIn", {
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

        {(cloudStage === "loading" ||
          cloudStage === "auto-creating" ||
          cloudStage === "creating" ||
          cloudStage === "provisioning" ||
          cloudStage === "connecting") && (
          <div className="mt-6 flex w-full flex-col items-center gap-3">
            <Spinner className="h-6 w-6 text-white/60" />
            <p
              style={{ fontFamily: MONO_FONT }}
              className="text-3xs uppercase text-white/50"
            >
              {cloudStage === "loading" &&
                t("runtimegate.loadingAgents", {
                  defaultValue: "Loading your agent...",
                })}
              {cloudStage === "auto-creating" &&
                t("runtimegate.autoCreating", {
                  defaultValue: "Setting up your first agent...",
                })}
              {cloudStage === "creating" &&
                t("runtimegate.creating", {
                  defaultValue: "Creating agent...",
                })}
              {cloudStage === "provisioning" &&
                (provisionStatus ||
                  t("runtimegate.provisioning", {
                    defaultValue: "Provisioning...",
                  }))}
              {cloudStage === "connecting" &&
                t("runtimegate.connecting", {
                  defaultValue: "Connecting...",
                })}
            </p>
          </div>
        )}

        {cloudStage === "agent-list" && (
          <div className="mt-4 flex w-full flex-col gap-3 text-left">
            <div className="flex items-center justify-between">
              <p
                style={{ fontFamily: MONO_FONT }}
                className="text-3xs uppercase text-white/60"
              >
                {t("runtimegate.yourAgents", {
                  defaultValue: "Your cloud agents",
                })}
              </p>
              <button
                type="button"
                onClick={handleRefreshAgents}
                style={{ fontFamily: MONO_FONT }}
                className="text-3xs uppercase text-white/50 hover:text-white underline"
              >
                {t("runtimegate.retry", { defaultValue: "Retry" })}
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
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="shrink-0 rounded-lg border-[#f0b90b]/40 bg-[#f0b90b]/15 text-[#f0b90b] font-semibold hover:bg-[#f0b90b]/25 hover:border-[#f0b90b]/60"
                          onClick={() => finishAsCloud(agent)}
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

            <BackButton t={t} onClick={() => setSubView("chooser")} />
          </div>
        )}
      </GateShell>
    );
  }

  // ── Render: remote ─────────────────────────────────────────────────

  return (
    <GateShell uiLanguage={uiLanguage} setUiLanguage={setUiLanguage} t={t}>
      <GateHeader t={t} />

      <div className="mt-4 flex w-full flex-col gap-3 text-left">
        <p
          style={{ fontFamily: MONO_FONT }}
          className="text-3xs uppercase text-white/60"
        >
          {t("runtimegate.remoteConnectEyebrow", {
            defaultValue: "Connect to a remote agent",
          })}
        </p>

        <Input
          placeholder={t("runtimegate.remoteUrlPlaceholder", {
            defaultValue: "https://your-agent.example.com",
          })}
          value={remoteUrl}
          onChange={(e) => setRemoteUrl(e.target.value)}
          className="h-10 border border-white/20 bg-transparent text-white text-sm placeholder:text-white/40"
        />

        <Input
          placeholder={t("runtimegate.remoteTokenPlaceholder", {
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
          onClick={finishAsRemote}
          disabled={!remoteUrl.trim()}
        >
          {t("startupshell.Connect", { defaultValue: "Connect" })}
        </Button>

        <BackButton t={t} onClick={() => setSubView("chooser")} />
      </div>
    </GateShell>
  );
}

// ── Primitives ───────────────────────────────────────────────────────

interface GateShellProps {
  uiLanguage: UiLanguage;
  setUiLanguage: (lang: UiLanguage) => void;
  t: (key: string, values?: Record<string, unknown>) => string;
  children: React.ReactNode;
}

function GateShell({ uiLanguage, setUiLanguage, t, children }: GateShellProps) {
  return (
    <div className="relative flex min-h-full w-full flex-col bg-black text-white">
      <div
        aria-hidden="true"
        className="absolute inset-0 overflow-hidden pointer-events-none"
      >
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.14),transparent_36%),linear-gradient(180deg,rgba(11,14,20,0.18),rgba(6,7,8,0.56))]" />
        <div className="absolute left-[-10%] top-[8%] h-[24rem] w-[24rem] rounded-full bg-[rgba(240,185,11,0.1)] blur-[110px]" />
        <div className="absolute bottom-[-12%] right-[-8%] h-[20rem] w-[20rem] rounded-full bg-[rgba(255,255,255,0.08)] blur-[120px]" />
      </div>

      <div
        style={{
          position: "absolute",
          top: "calc(var(--safe-area-top, 0px) + 0.5rem)",
          right: "calc(var(--safe-area-right, 0px) + 1rem)",
          zIndex: 50,
        }}
      >
        <LanguageDropdown
          uiLanguage={uiLanguage}
          setUiLanguage={setUiLanguage}
          t={t}
          variant="companion"
          triggerClassName="!h-8 !min-h-0 !min-w-0 !rounded-lg !px-2.5 !text-xs leading-none"
        />
      </div>

      <div className="relative z-10 flex flex-1 items-center justify-center px-4 pb-[max(1.5rem,var(--safe-area-bottom,0px))] pt-[calc(var(--safe-area-top,0px)+3.75rem)] sm:px-6 md:px-8">
        <div className="flex w-full max-w-[32rem] flex-col items-center gap-4">
          {children}
        </div>
      </div>
    </div>
  );
}

function GateHeader({
  t,
}: {
  t: (key: string, values?: Record<string, unknown>) => string;
}) {
  return (
    <div className="text-center">
      <h1
        style={{ fontFamily: MONO_FONT }}
        className="text-2xl font-light text-white/95"
      >
        {t("runtimegate.title", { defaultValue: "Choose your setup" })}
      </h1>
      <p
        style={{ fontFamily: MONO_FONT }}
        className="mt-2 text-3xs uppercase tracking-[0.2em] text-white/60"
      >
        {t("runtimegate.subtitle", {
          defaultValue: "Where should your agent run?",
        })}
      </p>
    </div>
  );
}

interface ChoiceCardProps {
  eyebrow: string;
  title: string;
  description: string;
  onClick: () => void;
  recommended?: boolean;
}

function ChoiceCard({
  eyebrow,
  title,
  description,
  onClick,
  recommended,
}: ChoiceCardProps) {
  const base =
    "flex w-full cursor-pointer flex-col items-start gap-1.5 rounded-xl border px-5 py-4 text-left backdrop-blur-xl transition-all duration-200 focus-visible:outline-none focus-visible:ring-2";
  const className = recommended
    ? `${base} border-[#f0b90b]/40 bg-[#f0b90b]/[0.1] shadow-lg hover:border-[#f0b90b]/60 hover:bg-[#f0b90b]/[0.18]`
    : `${base} border-white/20 bg-white/[0.07] shadow-lg hover:border-white/35 hover:bg-white/[0.12]`;

  return (
    <button type="button" className={className} onClick={onClick}>
      <span
        style={{ fontFamily: MONO_FONT }}
        className={`text-3xs uppercase ${recommended ? "text-[#f0b90b]/80" : "text-white/60"}`}
      >
        {eyebrow}
      </span>
      <span className="text-sm font-bold text-white/95">{title}</span>
      <span className="text-xs-tight leading-snug text-white/60">
        {description}
      </span>
    </button>
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
    <button
      type="button"
      onClick={onClick}
      style={{ fontFamily: MONO_FONT }}
      className="mt-2 self-center text-3xs uppercase text-white/60 underline hover:text-white"
    >
      {t("startupshell.Back", { defaultValue: "Back" })}
    </button>
  );
}
