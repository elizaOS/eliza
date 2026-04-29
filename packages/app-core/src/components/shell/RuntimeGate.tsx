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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { shouldShowLocalOption } from "../../onboarding/probe-local-agent";
import { isAndroid, isDesktopPlatform, isIOS } from "../../platform/init";
import {
  addAgentProfile,
  clearPersistedActiveServer,
  savePersistedActiveServer,
  type UiTheme,
  useApp,
} from "../../state";
import { resolveAppAssetUrl } from "../../utils";
import { LanguageDropdown } from "../shared/LanguageDropdown";
import { ThemeToggle } from "../shared/ThemeToggle";

const MONO_FONT = "'Courier New', 'Courier', 'Monaco', monospace";

const DEFAULT_AUTO_AGENT_NAME = "My Agent";

const LOCAL_AGENT_API_BASE = "http://127.0.0.1:31337";

type SubView = "chooser" | "cloud" | "remote";
type RuntimeChoice = "cloud" | "local" | "remote";

type CloudStage =
  | "login"
  | "loading"
  | "auto-creating"
  | "agent-list"
  | "creating"
  | "provisioning"
  | "connecting";

const CHOICE_IMAGE_PATH: Record<RuntimeChoice, string> = {
  cloud: "app-heroes/agentDOD.png",
  local: "app-heroes/runtime-debugger.png",
  remote: "app-heroes/log-viewer.png",
};

function resolveRuntimeChoices(args: {
  isAndroid: boolean;
  isIOS: boolean;
  isDesktop: boolean;
  isDev: boolean;
  showLocalOption: boolean;
  localProbePending: boolean;
}): RuntimeChoice[] {
  if (args.isAndroid && args.localProbePending) return [];
  if (args.isAndroid && args.showLocalOption) return ["local"];
  if (args.isIOS || args.isAndroid) return ["cloud", "remote"];
  if (args.isDesktop || args.isDev) return ["cloud", "local", "remote"];
  return ["cloud", "remote"];
}

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

function runtimeChoiceDetails(
  choice: RuntimeChoice,
  t: (key: string, values?: Record<string, unknown>) => string,
  androidLocal: boolean,
): {
  label: string;
  eyebrow: string;
  title: string;
  description: string;
  imageSrc: string;
} {
  switch (choice) {
    case "cloud":
      return {
        label: t("runtimegate.cloudOptionLabel", { defaultValue: "CLOUD" }),
        eyebrow: t("runtimegate.cloudEyebrow", {
          defaultValue: "Eliza Cloud",
        }),
        title: t("runtimegate.cloudTitle", {
          defaultValue: "Run in Eliza Cloud",
        }),
        description: t("runtimegate.cloudDesc", {
          defaultValue:
            "Hosted agent with managed LLMs and connectors. Fastest start.",
        }),
        imageSrc: resolveAppAssetUrl(CHOICE_IMAGE_PATH.cloud),
      };
    case "local":
      return {
        label: t("runtimegate.localOptionLabel", { defaultValue: "LOCAL" }),
        eyebrow: androidLocal
          ? t("runtimegate.localEyebrowOnDevice", {
              defaultValue: "On device",
            })
          : t("runtimegate.localEyebrow", {
              defaultValue: "This device",
            }),
        title: androidLocal
          ? t("runtimegate.localTitleAndroid", {
              defaultValue: "Local Agent (Beta)",
            })
          : t("runtimegate.localTitle", {
              defaultValue: "Run a local agent",
            }),
        description: androidLocal
          ? t("runtimegate.localDescAndroid", {
              defaultValue:
                "Runs the full Eliza agent on this device. No cloud needed.",
            })
          : t("runtimegate.localDesc", {
              defaultValue:
                "Keep the agent on this machine. You'll pick a provider after start.",
            }),
        imageSrc: resolveAppAssetUrl(CHOICE_IMAGE_PATH.local),
      };
    case "remote":
      return {
        label: t("runtimegate.remoteOptionLabel", { defaultValue: "REMOTE" }),
        eyebrow: t("runtimegate.remoteEyebrow", {
          defaultValue: "Remote agent",
        }),
        title: t("runtimegate.remoteTitle", {
          defaultValue: "Connect to an existing agent",
        }),
        description: t("runtimegate.remoteDesc", {
          defaultValue:
            "Point at an agent you're already running (e.g. on your Mac).",
        }),
        imageSrc: resolveAppAssetUrl(CHOICE_IMAGE_PATH.remote),
      };
  }
}

function selectChoiceLabel(
  choice: RuntimeChoice,
  t: (key: string, values?: Record<string, unknown>) => string,
): string {
  switch (choice) {
    case "cloud":
      return t("runtimegate.selectCloud", { defaultValue: "Select Cloud" });
    case "local":
      return t("runtimegate.selectLocal", {
        defaultValue: "Start Local Agent",
      });
    case "remote":
      return t("runtimegate.selectRemote", { defaultValue: "Select Remote" });
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
    uiTheme,
    setUiTheme,
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

  // Local-tile visibility. On desktop/dev this is true synchronously; on
  // Android it depends on a live probe of the on-device agent's
  // `/api/health`, so the tile is hidden until the probe resolves. Other
  // platforms never see it. `null` means "still probing" — Android waits
  // briefly so AOSP builds can collapse to the local-only path.
  const isDesktop = isDesktopPlatform();
  const isDev = Boolean(import.meta.env.DEV);
  const synchronousLocal = isDesktop || isDev;
  const [localProbeResult, setLocalProbeResult] = useState<boolean | null>(
    synchronousLocal ? true : isAndroid ? null : false,
  );

  useEffect(() => {
    if (synchronousLocal) return;
    if (!isAndroid) return;
    let cancelled = false;
    shouldShowLocalOption({ isDesktop, isDev, isAndroid })
      .then((ok) => {
        if (!cancelled) setLocalProbeResult(ok);
      })
      .catch(() => {
        if (!cancelled) setLocalProbeResult(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isDesktop, isDev, synchronousLocal]);

  const showLocalOption = localProbeResult === true;
  const localProbePending = localProbeResult === null;
  const runtimeChoices = useMemo(
    () =>
      resolveRuntimeChoices({
        isAndroid,
        isIOS,
        isDesktop,
        isDev,
        showLocalOption,
        localProbePending,
      }),
    [isDesktop, isDev, showLocalOption, localProbePending],
  );
  const runtimeChoiceKey = runtimeChoices.join("|");
  const [selectedChoice, setSelectedChoice] =
    useState<RuntimeChoice>("cloud");

  useEffect(() => {
    if (runtimeChoices.length === 0) return;
    if (runtimeChoices.includes(selectedChoice)) return;
    setSelectedChoice(runtimeChoices[0]);
  }, [runtimeChoiceKey, runtimeChoices, selectedChoice]);

  // ── Gateway discovery (LAN autodetect) ────────────────────────────
  useEffect(() => {
    if (subView !== "chooser" && subView !== "remote") return;
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
    if (isAndroid) {
      // Android: the local agent runs as a foreground service inside the
      // app and always listens on loopback `127.0.0.1:31337`. The WebView
      // origin is `https://localhost` (Capacitor) or `file://`, so a null
      // base URL does not reach the agent — pin it explicitly. We persist
      // it as a `remote` active server pointing at loopback so the
      // existing startup-phase-restore branch hydrates the API base on
      // next launch; the `local` mobile runtime mode records the
      // distinction for any UI that needs it.
      client.setBaseUrl(LOCAL_AGENT_API_BASE);
      client.setToken(null);
      savePersistedActiveServer({
        id: "local:android",
        kind: "remote",
        label: "On-device agent",
        apiBase: LOCAL_AGENT_API_BASE,
      });
      addAgentProfile({
        kind: "remote",
        label: "On-device agent",
        apiBase: LOCAL_AGENT_API_BASE,
      });
    } else {
      client.setBaseUrl(null);
      client.setToken(null);
      clearPersistedActiveServer();
    }
    persistMobileRuntimeModeForServerTarget("local");
    setState("onboardingServerTarget", "local");
    startupCoordinator.dispatch({ type: "SPLASH_CONTINUE" });
    // Always land on chat. The composer lock + "Set up an LLM provider"
    // placeholder handles the missing-provider case.
    completeOnboarding();
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

  const handleSelectChoice = useCallback(() => {
    switch (selectedChoice) {
      case "cloud":
        setSubView("cloud");
        return;
      case "local":
        finishAsLocal();
        return;
      case "remote":
        setSubView("remote");
        return;
    }
  }, [finishAsLocal, selectedChoice]);

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
    const localOnly = runtimeChoiceKey === "local";

    return (
      <GateShell
        uiLanguage={uiLanguage}
        setUiLanguage={setUiLanguage}
        uiTheme={uiTheme}
        setUiTheme={setUiTheme}
        t={t}
      >
        <GateHeader t={t} />

        {runtimeChoices.length === 0 ? (
          <div className="mt-8 flex w-full items-center justify-center gap-3 border-2 border-[#f0b90b]/45 bg-black/70 px-5 py-5 text-[#ffe88a]">
            <Spinner className="h-4 w-4" />
            <span
              style={{ fontFamily: MONO_FONT }}
              className="text-3xs uppercase tracking-[0.16em]"
            >
              {t("runtimegate.localProbing", {
                defaultValue: "Checking for on-device agent...",
              })}
            </span>
          </div>
        ) : (
          <>
            <div
              className={`mt-5 grid w-full gap-2.5 text-left md:mt-7 md:gap-3 ${
                runtimeChoices.length === 3 ? "md:grid-cols-3" : ""
              }`}
              role="radiogroup"
              aria-label={t("runtimegate.subtitle", {
                defaultValue: "Where should your agent run?",
              })}
            >
              {runtimeChoices.map((choice) => {
                const details = runtimeChoiceDetails(choice, t, isAndroid);
                return (
                  <ChoiceCard
                    key={choice}
                    choice={choice}
                    selected={selectedChoice === choice}
                    disabled={localOnly}
                    statusLabel={
                      selectedChoice === choice
                        ? t("runtimegate.optionSelected", {
                            defaultValue: "Selected",
                          })
                        : t("runtimegate.optionAvailable", {
                            defaultValue: "Available",
                          })
                    }
                    {...details}
                    onClick={() => setSelectedChoice(choice)}
                  />
                );
              })}
            </div>

            <div className="mt-3 flex w-full flex-col gap-2 sm:mt-5 sm:flex-row sm:items-center sm:justify-between">
              <p
                style={{ fontFamily: MONO_FONT }}
                className="hidden min-w-0 text-3xs uppercase tracking-[0.16em] text-white/70 sm:block"
              >
                {localOnly
                  ? t("runtimegate.localOnlyHint", {
                      defaultValue:
                        "This build runs your agent on this device.",
                    })
                  : t("runtimegate.selectedHint", {
                      defaultValue: "{{target}} selected",
                      target: runtimeChoiceDetails(
                        selectedChoice,
                        t,
                        isAndroid,
                      ).label,
                    })}
              </p>
              <Button
                type="button"
                variant="default"
                className="min-h-12 w-full border-2 border-black bg-[#ffe600] px-8 py-3 text-sm font-black uppercase tracking-[0.18em] text-black shadow-[5px_5px_0_rgba(0,0,0,0.72)] transition-transform duration-150 hover:-translate-y-0.5 hover:bg-white active:translate-y-0 sm:w-auto"
                style={{
                  borderRadius: 0,
                  clipPath:
                    "polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px)",
                  fontFamily: MONO_FONT,
                }}
                onClick={handleSelectChoice}
              >
                {selectChoiceLabel(selectedChoice, t)}
              </Button>
            </div>
          </>
        )}
      </GateShell>
    );
  }

  // ── Render: cloud ──────────────────────────────────────────────────

  if (subView === "cloud") {
    return (
      <GateShell
        uiLanguage={uiLanguage}
        setUiLanguage={setUiLanguage}
        uiTheme={uiTheme}
        setUiTheme={setUiTheme}
        t={t}
      >
        <GateHeader t={t} />

        {cloudStage === "login" && (
          <div className="mt-4 flex w-full max-w-[34rem] flex-col gap-3 text-left">
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
          <div className="mt-6 flex w-full max-w-[34rem] flex-col items-center gap-3">
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
          <div className="mt-4 flex w-full max-w-[34rem] flex-col gap-3 text-left">
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
                          {t("common.connect", {
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
    <GateShell
      uiLanguage={uiLanguage}
      setUiLanguage={setUiLanguage}
      uiTheme={uiTheme}
      setUiTheme={setUiTheme}
      t={t}
    >
      <GateHeader t={t} />

      <div className="mt-4 flex w-full max-w-[34rem] flex-col gap-3 text-left">
        <p
          style={{ fontFamily: MONO_FONT }}
          className="text-3xs uppercase text-white/60"
        >
          {t("runtimegate.remoteConnectEyebrow", {
            defaultValue: "Connect to a remote agent",
          })}
        </p>

        {discoveredGateways.length > 0 && (
          <div className="flex flex-col gap-2">
            {discoveredGateways.map((gateway) => (
              <Card
                key={gateway.stableId}
                className="border-2 border-[#f0b90b]/40 bg-black/58 text-white shadow-[4px_4px_0_rgba(0,0,0,0.52)]"
                style={{ borderRadius: 0 }}
              >
                <CardContent className="flex items-center justify-between gap-3 px-3 py-3">
                  <div className="min-w-0">
                    <p
                      style={{ fontFamily: MONO_FONT }}
                      className="text-3xs uppercase text-[#ffe600]/80"
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
                    <p className="truncate text-xs-tight text-white/52">
                      {gateway.host}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0 rounded-none border-2 border-black bg-[#ffe600] text-xs font-black uppercase tracking-[0.12em] text-black hover:bg-white"
                    onClick={() => finishAsRemoteGateway(gateway)}
                  >
                    {t("common.connect", { defaultValue: "Connect" })}
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <Input
          placeholder={t("runtimegate.remoteUrlPlaceholder", {
            defaultValue: "https://your-agent.example.com",
          })}
          value={remoteUrl}
          onChange={(e) => setRemoteUrl(e.target.value)}
          className="h-11 rounded-none border-2 border-[#f0b90b]/35 bg-black/48 text-white text-sm placeholder:text-white/40"
        />

        <Input
          placeholder={t("runtimegate.remoteTokenPlaceholder", {
            defaultValue: "Access token (optional)",
          })}
          type="password"
          value={remoteToken}
          onChange={(e) => setRemoteToken(e.target.value)}
          className="h-11 rounded-none border-2 border-[#f0b90b]/35 bg-black/48 text-white text-sm placeholder:text-white/40"
        />

        <Button
          type="button"
          variant="default"
          className="justify-center rounded-none border-2 border-black bg-[#ffe600] px-3 py-4 text-sm font-black uppercase tracking-[0.14em] text-black shadow-[5px_5px_0_rgba(0,0,0,0.68)] hover:bg-white"
          onClick={finishAsRemote}
          disabled={!remoteUrl.trim()}
        >
          {t("common.connect", { defaultValue: "Connect" })}
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
  uiTheme: UiTheme;
  setUiTheme: (theme: UiTheme) => void;
  t: (key: string, values?: Record<string, unknown>) => string;
  children: React.ReactNode;
}

function GateShell({
  uiLanguage,
  setUiLanguage,
  uiTheme,
  setUiTheme,
  t,
  children,
}: GateShellProps) {
  const lightMode = uiTheme === "light";

  return (
    <div className="relative min-h-full w-full overflow-y-auto bg-black text-white">
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 overflow-hidden"
      >
        <img
          src={resolveAppAssetUrl("splash-bg.png")}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div
          className={`absolute inset-0 ${
            lightMode ? "bg-[#f6d969]/38" : "bg-black/58"
          }`}
        />
        <div
          className="absolute inset-0 opacity-35"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px)",
            backgroundSize: "24px 24px",
          }}
        />
      </div>

      <div
        className="flex items-center gap-2"
        style={{
          position: "absolute",
          top: "calc(var(--safe-area-top, 0px) + 0.75rem)",
          right: "calc(var(--safe-area-right, 0px) + 1rem)",
          zIndex: 50,
        }}
      >
        <LanguageDropdown
          uiLanguage={uiLanguage}
          setUiLanguage={setUiLanguage}
          t={t}
          variant="companion"
          triggerClassName="!h-9 !min-h-9 !min-w-0 !rounded-none !border-2 !border-black !bg-[#fff0a3] !px-2.5 !text-xs !text-black !shadow-[3px_3px_0_rgba(0,0,0,0.72)] leading-none"
        />
        <ThemeToggle
          uiTheme={uiTheme}
          setUiTheme={setUiTheme}
          t={t}
          variant="companion"
          className="!h-9 !w-9 !min-h-9 !min-w-9 !rounded-none !border-2 !border-black !bg-[#fff0a3] !text-black !shadow-[3px_3px_0_rgba(0,0,0,0.72)]"
        />
      </div>

      <div className="relative z-10 flex min-h-full items-center justify-center px-3 pb-[max(1rem,var(--safe-area-bottom,0px))] pt-[calc(var(--safe-area-top,0px)_+_4.25rem)] sm:px-6 md:px-8">
        <div
          className="flex w-full max-w-[72rem] flex-col items-center gap-3 border-2 border-black bg-[rgba(9,10,14,0.82)] px-3 py-4 shadow-[9px_9px_0_rgba(0,0,0,0.62)] backdrop-blur-md sm:gap-4 sm:px-6 sm:py-7 md:px-8 md:py-8"
          style={{
            borderRadius: 0,
            clipPath:
              "polygon(16px 0,100% 0,100% calc(100% - 16px),calc(100% - 16px) 100%,0 100%,0 16px)",
          }}
        >
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
        className="text-xl font-light text-white/95 sm:text-2xl"
      >
        {t("runtimegate.title", { defaultValue: "Choose your setup" })}
      </h1>
      <p
        style={{ fontFamily: MONO_FONT }}
        className="mt-2 text-3xs uppercase tracking-[0.16em] text-white/60 sm:tracking-[0.2em]"
      >
        {t("runtimegate.subtitle", {
          defaultValue: "Where should your agent run?",
        })}
      </p>
    </div>
  );
}

interface ChoiceCardProps {
  choice: RuntimeChoice;
  label: string;
  eyebrow: string;
  title: string;
  description: string;
  imageSrc: string;
  selected: boolean;
  statusLabel: string;
  disabled?: boolean;
  onClick: () => void;
}

function ChoiceCard({
  choice,
  label,
  eyebrow,
  title,
  description,
  imageSrc,
  selected,
  statusLabel,
  disabled,
  onClick,
}: ChoiceCardProps) {
  const className = [
    "group flex w-full min-w-0 border-2 p-2 text-left shadow-[5px_5px_0_rgba(0,0,0,0.62)] transition-[background-color,border-color,color,transform,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ffe600] focus-visible:ring-offset-2 focus-visible:ring-offset-black md:min-h-[21rem] md:flex-col md:p-3",
    selected
      ? "border-[#ffe600] bg-black/88 text-[#fff3a8]"
      : "border-black bg-[#fff1ac]/90 text-black hover:-translate-y-0.5 hover:bg-white",
    disabled ? "cursor-default" : "cursor-pointer",
  ].join(" ");
  const imageBorderClassName = selected
    ? "border-[#ffe600] bg-[#17100a]"
    : "border-black bg-black";
  const eyebrowClassName = selected ? "text-[#ffe600]/82" : "text-black/60";
  const titleClassName = selected ? "text-white/92" : "text-black/76";
  const descriptionClassName = selected ? "text-white/66" : "text-black/62";

  return (
    <button
      type="button"
      className={className}
      onClick={disabled ? undefined : onClick}
      role="radio"
      aria-checked={selected}
      aria-disabled={disabled}
      data-runtime-choice={choice}
      style={{
        borderRadius: 0,
        clipPath:
          "polygon(12px 0,100% 0,100% calc(100% - 12px),calc(100% - 12px) 100%,0 100%,0 12px)",
      }}
    >
      <span
        className={`relative h-24 w-28 shrink-0 overflow-hidden border-2 md:h-36 md:w-full ${imageBorderClassName}`}
        style={{
          clipPath:
            "polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px)",
        }}
      >
        <img
          src={imageSrc}
          alt=""
          aria-hidden="true"
          className="h-full w-full object-cover opacity-90 saturate-[1.05]"
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col px-3 py-1.5 md:px-1 md:pt-3">
        <span
          style={{ fontFamily: MONO_FONT }}
          className={`text-3xs uppercase tracking-[0.18em] ${eyebrowClassName}`}
        >
          {eyebrow}
        </span>
        <span
          style={{ fontFamily: MONO_FONT }}
          className="mt-1 text-lg font-black uppercase leading-none tracking-[0.08em] md:text-2xl"
        >
          {label}
        </span>
        <span className={`mt-2 text-xs font-bold leading-snug ${titleClassName}`}>
          {title}
        </span>
        <span className={`mt-1 text-xs-tight leading-snug ${descriptionClassName}`}>
          {description}
        </span>
      </span>
      <span
        style={{ fontFamily: MONO_FONT }}
        className={`ml-auto hidden self-start px-2 py-1 text-3xs font-bold uppercase sm:inline-block md:ml-0 md:mt-3 md:self-start ${
          selected ? "bg-[#ffe600] text-black" : "bg-black text-[#ffe600]"
        }`}
      >
        {statusLabel}
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
      {t("common.back", { defaultValue: "Back" })}
    </button>
  );
}
