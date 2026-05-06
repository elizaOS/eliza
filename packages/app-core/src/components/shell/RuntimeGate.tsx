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

import { Capacitor } from "@capacitor/core";
import {
  Button,
  Card,
  CardContent,
  Checkbox,
  Input,
  Spinner,
  TooltipHint,
} from "@elizaos/ui";
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
import {
  ANDROID_LOCAL_AGENT_LABEL,
  ANDROID_LOCAL_AGENT_SERVER_ID,
  MOBILE_LOCAL_AGENT_API_BASE,
  MOBILE_LOCAL_AGENT_LABEL,
  MOBILE_LOCAL_AGENT_SERVER_ID,
  persistMobileRuntimeModeForServerTarget,
} from "../../onboarding/mobile-runtime-mode";
import { shouldShowLocalOption } from "../../onboarding/probe-local-agent";
import {
  isAndroid,
  isDesktopPlatform,
  isElizaOS,
  isIOS,
} from "../../platform/init";
import {
  ONBOARDING_PROVIDER_CATALOG,
  type OnboardingProviderOption,
} from "../../providers";
import {
  addAgentProfile,
  clearPersistedActiveServer,
  savePersistedActiveServer,
  type UiTheme,
  useApp,
} from "../../state";
import { preOpenWindow, resolveAppAssetUrl } from "../../utils";
import { LanguageDropdown } from "../shared/LanguageDropdown";
import { ThemeToggle } from "../shared/ThemeToggle";

const MONO_FONT = "'Courier New', 'Courier', 'Monaco', monospace";

const DEFAULT_AUTO_AGENT_NAME = "My Agent";

const LOCAL_AGENT_API_BASE = MOBILE_LOCAL_AGENT_API_BASE;
const PROVISION_START_STILL_WAITING_MS = 5_000;
const PROVISION_START_TIMEOUT_MS = 20_000;
const PROVISION_JOB_WAIT_DEADLINE_MS = 600_000;
const AGENT_URL_WAIT_DEADLINE_MS = 300_000;

type NativeAgentPlugin = {
  start?: () => Promise<unknown>;
};

async function startMobileLocalAgent(): Promise<void> {
  if (!isAndroid && !isIOS) return;
  try {
    const capacitorWithPlugins = Capacitor as typeof Capacitor & {
      Plugins?: Record<string, NativeAgentPlugin | undefined>;
    };
    const registeredAgent =
      capacitorWithPlugins.Plugins?.Agent ??
      Capacitor.registerPlugin<NativeAgentPlugin>("Agent");
    await registeredAgent.start?.();
  } catch (err) {
    console.warn(
      "[RuntimeGate] Failed to start mobile local agent",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * URL query flag that deliberately re-opens the RuntimeGate picker on
 * ElizaOS, which is otherwise bypassed in favour of the pre-seeded
 * on-device agent.
 *
 * Settings ▸ Runtime navigates to a URL with `?runtime=picker` after clearing
 * the persisted mode + active server when the user wants to switch runtimes.
 * Without this exact query value the ElizaOS branch falls through to the
 * "Starting your local agent…" splash and auto-completes as local.
 *
 * Has no effect on the vanilla Android APK (installed on a stock phone) —
 * that build always renders the picker tiles, since the user actively
 * chooses Cloud / Remote / Local.
 */
export const RUNTIME_GATE_PICKER_OVERRIDE_PARAM = "runtime";
export const RUNTIME_GATE_PICKER_OVERRIDE_VALUE = "picker";

export function hasPickerOverride(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const search = window.location?.search ?? "";
    const hashSearch = window.location?.hash?.split("?")[1] ?? "";
    const params = new URLSearchParams(search || hashSearch);
    return (
      params.get(RUNTIME_GATE_PICKER_OVERRIDE_PARAM) ===
      RUNTIME_GATE_PICKER_OVERRIDE_VALUE
    );
  } catch {
    return false;
  }
}

function normalizeRemoteTarget(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (!parsed.hostname) return null;
    return trimmed;
  } catch {
    return null;
  }
}

type SubView = "chooser" | "cloud" | "remote" | "local";
type RuntimeChoice = "cloud" | "local" | "remote";

type CloudStage =
  | "login"
  | "loading"
  | "auto-creating"
  | "agent-list"
  | "creating"
  | "provisioning"
  | "connecting";

type LocalStage = "provider" | "config";

function normalizeRuntimeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  let end = trimmed.length;
  while (end > 0 && trimmed.charCodeAt(end - 1) === 47) end--;
  return trimmed.slice(0, end);
}

function isCloudControlPlaneUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return (
      host === "api.elizacloud.ai" ||
      host === "elizacloud.ai" ||
      host === "www.elizacloud.ai" ||
      host === "dev.elizacloud.ai"
    );
  } catch {
    return false;
  }
}

function resolveCloudAgentApiBase(agent: CloudCompatAgent): string | undefined {
  const directAgent = agent as CloudCompatAgent & {
    apiBase?: string | null;
    api_base?: string | null;
    bridgeUrl?: string | null;
    container_url?: string | null;
    runtimeUrl?: string | null;
    runtime_url?: string | null;
  };
  const candidates = [
    directAgent.apiBase,
    directAgent.api_base,
    agent.bridge_url,
    directAgent.bridgeUrl,
    agent.containerUrl,
    directAgent.container_url,
    directAgent.runtimeUrl,
    directAgent.runtime_url,
    agent.web_ui_url,
    agent.webUiUrl,
  ]
    .map(normalizeRuntimeUrl)
    .filter((value): value is string => Boolean(value));

  return candidates.find((value) => !isCloudControlPlaneUrl(value));
}

function resolveCloudJobRuntimeUrl(
  job: Pick<CloudCompatJob, "result" | "data">,
): string | undefined {
  const payloads = [job.result, job.data].filter(
    (value): value is Record<string, unknown> =>
      Boolean(value) && typeof value === "object",
  );
  const keys = [
    "apiBase",
    "api_base",
    "bridgeUrl",
    "bridge_url",
    "runtimeUrl",
    "runtime_url",
    "containerUrl",
    "container_url",
    "webUiUrl",
    "web_ui_url",
  ];

  for (const payload of payloads) {
    for (const key of keys) {
      const url = normalizeRuntimeUrl(payload[key]);
      if (url && !isCloudControlPlaneUrl(url)) return url;
    }
  }
}

function mergeCloudRuntimeUrl(
  agent: CloudCompatAgent,
  runtimeUrl: string | undefined,
): CloudCompatAgent {
  if (!runtimeUrl || resolveCloudAgentApiBase(agent)) return agent;
  return {
    ...agent,
    bridge_url: runtimeUrl,
    containerUrl: runtimeUrl,
  };
}

async function withProvisionStartTimeout<T>(
  request: Promise<T>,
  message: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(message));
    }, PROVISION_START_TIMEOUT_MS);
  });

  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function displayErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

// TODO: replace with real onboarding artwork per runtime choice
// const CHOICE_IMAGE_PATH: Record<RuntimeChoice, string> = {
//   cloud: "app-heroes/agentDOD.png",
//   local: "app-heroes/runtime-debugger.png",
//   remote: "app-heroes/log-viewer.png",
// };

export function resolveRuntimeChoices(args: {
  isAndroid: boolean;
  isIOS: boolean;
  isDesktop: boolean;
  isDev: boolean;
  showLocalOption: boolean;
  localProbePending: boolean;
}): RuntimeChoice[] {
  if (args.isAndroid) {
    return ["cloud", "local", "remote"];
  }
  if (args.isIOS) return ["cloud", "local", "remote"];
  if (args.isDesktop || args.isDev) return ["cloud", "local", "remote"];
  if (args.showLocalOption || args.localProbePending) {
    return ["cloud", "local", "remote"];
  }
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
  imageSrc?: string;
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
    elizaCloudLoginError,
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

  // Local embeddings toggle (elizacloud only, default unchecked)
  const [useLocalEmbeddings, setUseLocalEmbeddings] = useState(false);

  // Local-runtime setup wizard. When the user picks "Local" in the
  // chooser we render an in-place wizard (provider list → API key entry)
  // before completing onboarding. Without this, finishAsLocal() drops
  // the user straight into chat with no model provider configured —
  // their first send hits the no_provider gate (commit 28e19c8023) and
  // they have to backtrack to Settings. The wizard saves the round-trip.
  const [localStage, setLocalStage] = useState<LocalStage>("provider");
  const [localProviderId, setLocalProviderId] = useState<string | null>(null);
  const [localApiKey, setLocalApiKey] = useState("");
  const [localSaving, setLocalSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // Filter catalog to direct API-key providers (group:"local" excludes
  // managed cloud + subscription paths — those have their own flows).
  const localProviderCatalog = useMemo<readonly OnboardingProviderOption[]>(
    () =>
      ONBOARDING_PROVIDER_CATALOG.filter(
        (provider) =>
          provider.group === "local" && provider.authMode === "api-key",
      ),
    [],
  );

  // Local-tile readiness. Desktop/dev are local-capable synchronously.
  // Android probes the on-device agent's `/api/health` so ElizaOS can
  // auto-complete once the bundled runtime is ready. iOS uses the in-process
  // ITTP route kernel, so native iOS can expose Local without a TCP probe.
  // Plain web can include it when a caller reports local availability or an
  // in-progress probe through `resolveRuntimeChoices`.
  const isDesktop = isDesktopPlatform();
  const isDev = Boolean(import.meta.env.DEV);
  const synchronousLocal = isDesktop || isDev;
  const [localProbeResult, setLocalProbeResult] = useState<boolean | null>(
    synchronousLocal ? true : isAndroid || isIOS ? null : false,
  );

  // ElizaOS: the picker is bypassed entirely unless the user explicitly asks
  // for it via `?runtime=picker` (Settings ▸ Runtime is the only legitimate
  // caller). Without the override the gate renders an "INITIALIZING AGENT…"
  // splash with the same probe-poll loop as the chooser tile, then calls
  // `finishAsLocal()` the moment the probe succeeds.
  //
  // The same APK installed on a stock Android phone (no `ElizaOS/<tag>`
  // user-agent suffix) falls through to the regular picker — those users
  // pick Cloud / Remote / Local themselves.
  const pickerOverride = hasPickerOverride();
  const elizaOSAutoLocal = isElizaOS() && !pickerOverride;

  useEffect(() => {
    if (synchronousLocal) return;
    if (!isAndroid && !isIOS) return;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    // Re-poll every 4 s while the gate is mounted and the agent is not yet
    // reachable. The on-device agent can take 30+ s to come up after a cold
    // boot (PGlite migration + GGUF model warmup). A one-shot probe at
    // mount time would otherwise leave the user stuck on Cloud/Remote even
    // though the agent is racing toward live. Stops polling once a positive
    // result is in — `probe-local-agent`'s positive cache then keeps it
    // stable for the rest of the session.
    const poll = () => {
      shouldShowLocalOption({ isDesktop, isDev, isAndroid, isIOS })
        .then((ok) => {
          if (cancelled) return;
          setLocalProbeResult(ok);
          if (!ok) {
            pollTimer = setTimeout(poll, 4_000);
          }
        })
        .catch(() => {
          if (cancelled) return;
          setLocalProbeResult(false);
          pollTimer = setTimeout(poll, 4_000);
        });
    };
    poll();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
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
  const [selectedChoice, setSelectedChoice] = useState<RuntimeChoice>("cloud");

  useEffect(() => {
    if (runtimeChoices.length === 0) return;
    if (runtimeChoices.includes(selectedChoice)) return;
    setSelectedChoice(runtimeChoices[0]);
  }, [runtimeChoices, selectedChoice]);

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
      // Refuse to complete cloud onboarding without a usable agent URL —
      // persisting an active server with no apiBase puts the next boot
      // into an infinite loopback poll (`https://localhost/api/auth/status`)
      // because client.getBaseUrl() falls back to window.location.origin
      // when nothing is set. Surface the failure so the user can retry
      // instead of silently writing a broken active-server record.
      const apiBase = resolveCloudAgentApiBase(agent);
      if (!apiBase) {
        setError(
          t("runtimegate.cloudAgentMissingUrl", {
            defaultValue:
              "Cloud agent is not reachable yet. Retry after it finishes starting.",
          }),
        );
        setCloudStage("agent-list");
        return;
      }
      setCloudStage("connecting");

      const accessToken = client.getRestAuthToken() ?? undefined;

      savePersistedActiveServer({
        id: `cloud:${agent.agent_id}`,
        kind: "cloud",
        label: agent.agent_name,
        apiBase,
        ...(accessToken ? { accessToken } : {}),
      });
      addAgentProfile({
        kind: "cloud",
        label: agent.agent_name,
        cloudAgentId: agent.agent_id,
        apiBase,
        ...(accessToken ? { accessToken } : {}),
      });

      client.setBaseUrl(apiBase);
      persistMobileRuntimeModeForServerTarget("elizacloud");
      setState("onboardingServerTarget", "elizacloud");
      // Apply embedding preference before handing off. Non-blocking: if this
      // fails the user can adjust it from Settings → Provider.
      if (useLocalEmbeddings) {
        void client
          .switchProvider("elizacloud", undefined, undefined, {
            useLocalEmbeddings: true,
          })
          .catch((err) => {
            console.warn(
              "[RuntimeGate] Failed to apply local embeddings preference",
              err,
            );
          });
      }
      completeOnboarding();
    },
    [completeOnboarding, setState, t, useLocalEmbeddings],
  );

  const finishAsLocal = useCallback(() => {
    setError(null);
    if (isAndroid || isIOS) {
      // Mobile local mode always pins the loopback-shaped base URL. Android
      // serves it from the foreground service; iOS intercepts the same URL
      // through the in-process ITTP transport before any TCP request is made.
      // Persisting it as a `remote` active server keeps the existing startup
      // restore branch working while `local` mobile runtime mode records the
      // user-visible distinction.
      client.setBaseUrl(LOCAL_AGENT_API_BASE);
      client.setToken(null);
      savePersistedActiveServer({
        id: isAndroid
          ? ANDROID_LOCAL_AGENT_SERVER_ID
          : MOBILE_LOCAL_AGENT_SERVER_ID,
        kind: "remote",
        label: isAndroid ? ANDROID_LOCAL_AGENT_LABEL : MOBILE_LOCAL_AGENT_LABEL,
        apiBase: LOCAL_AGENT_API_BASE,
      });
      addAgentProfile({
        kind: "remote",
        label: isAndroid ? ANDROID_LOCAL_AGENT_LABEL : MOBILE_LOCAL_AGENT_LABEL,
        apiBase: LOCAL_AGENT_API_BASE,
      });
      void startMobileLocalAgent();
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

  // Auto-pick the on-device agent on ElizaOS. The picker is bypassed by
  // default — the only legitimate way to see it is `?runtime=picker`, set
  // by Settings ▸ Runtime when the user explicitly wants to switch
  // runtimes. As soon as the on-device agent's `/api/health` responds we
  // finish onboarding as local and the user lands in chat.
  //
  // Pre-seed (in `apps/app/src/main.tsx` via `preSeedAndroidLocalRuntimeIfFresh`)
  // already ensures the persisted mode + active server look like "local" by
  // first render, so `finishAsLocal()` here is mostly idempotent. The
  // important effect of this call is the `completeOnboarding()` /
  // `ONBOARDING_COMPLETE` dispatch that flips the startup coordinator out
  // of `onboarding-required`.
  //
  // The vanilla Android APK (no ElizaOS user-agent suffix) does not enter
  // this branch — it renders the chooser tiles like iOS / web and waits for
  // a user choice.
  useEffect(() => {
    if (!elizaOSAutoLocal) return;
    if (!showLocalOption) return;
    finishAsLocal();
  }, [elizaOSAutoLocal, finishAsLocal, showLocalOption]);

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
    const url = normalizeRemoteTarget(remoteUrl);
    if (!url) {
      setError(
        t("runtimegate.invalidRemoteUrl", {
          defaultValue: "Enter a valid HTTP or HTTPS remote agent URL.",
        }),
      );
      return;
    }
    setError(null);

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
    t,
  ]);

  const handleSelectChoice = useCallback(() => {
    switch (selectedChoice) {
      case "cloud":
        setSubView("cloud");
        return;
      case "local":
        // ElizaOS / Android pre-seed paths still want the immediate
        // finishAsLocal() — the on-device runtime is the only legitimate
        // option there and the chooser is bypassed entirely on stock
        // builds. Desktop/iOS/web users actively pick Local and need a
        // provider before the runtime can answer chat.
        if (elizaOSAutoLocal || isAndroid) {
          finishAsLocal();
          return;
        }
        setLocalStage("provider");
        setLocalProviderId(null);
        setLocalApiKey("");
        setLocalError(null);
        setSubView("local");
        return;
      case "remote":
        setSubView("remote");
        return;
    }
  }, [elizaOSAutoLocal, finishAsLocal, selectedChoice]);

  const handleLocalSelectProvider = useCallback((providerId: string) => {
    setLocalProviderId(providerId);
    setLocalApiKey("");
    setLocalError(null);
    setLocalStage("config");
  }, []);

  const handleLocalConfigBack = useCallback(() => {
    setLocalStage("provider");
    setLocalError(null);
  }, []);

  const handleLocalSave = useCallback(async () => {
    if (!localProviderId) {
      setLocalError(
        t("runtimegate.localPickProvider", {
          defaultValue: "Pick a provider first.",
        }),
      );
      return;
    }
    const trimmedKey = localApiKey.trim();
    if (!trimmedKey) {
      setLocalError(
        t("runtimegate.localApiKeyRequired", {
          defaultValue: "Enter an API key for the selected provider.",
        }),
      );
      return;
    }

    setLocalSaving(true);
    setLocalError(null);
    try {
      // switchProvider writes the canonical config (cloud.* off,
      // serviceRouting.llmText.{backend,transport:"direct"}, env key).
      // Routing-mode "local-only" + the provider's API key = the runtime
      // boots with a registered provider and chat works immediately.
      await client.switchProvider(localProviderId, trimmedKey);
      finishAsLocal();
    } catch (err) {
      setLocalSaving(false);
      setLocalError(
        err instanceof Error
          ? err.message
          : t("runtimegate.localSaveFailed", {
              defaultValue: "Failed to save provider — please try again.",
            }),
      );
    }
  }, [finishAsLocal, localApiKey, localProviderId, t]);

  // ── Cloud: provision + connect ─────────────────────────────────────

  const provisionAndConnect = useCallback(
    async (agentId: string) => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      setCloudStage("provisioning");
      setProvisionStatus(
        t("runtimegate.startingProvisioning", {
          defaultValue: "Starting provisioning...",
        }),
      );
      let provRes: Awaited<ReturnType<typeof client.provisionCloudCompatAgent>>;
      let startStatusTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        startStatusTimer = setTimeout(() => {
          setProvisionStatus(
            t("runtimegate.waitingForProvisioningJob", {
              defaultValue: "Waiting for Cloud to accept provisioning...",
            }),
          );
        }, PROVISION_START_STILL_WAITING_MS);
        provRes = await withProvisionStartTimeout(
          client.provisionCloudCompatAgent(agentId),
          t("runtimegate.provisioningStartTimeout", {
            defaultValue:
              "Cloud did not return a provisioning job. Please retry.",
          }),
        );
      } catch (err) {
        setError(
          displayErrorMessage(
            err,
            t("runtimegate.provisioningFailed", {
              defaultValue: "Provisioning failed",
            }),
          ),
        );
        setCloudStage("agent-list");
        return;
      } finally {
        if (startStatusTimer) clearTimeout(startStatusTimer);
      }
      if (!provRes.success) {
        setError(
          provRes.error ||
            t("runtimegate.provisioningFailed", {
              defaultValue: "Provisioning failed",
            }),
        );
        setCloudStage("agent-list");
        return;
      }
      const jobId = provRes.data?.jobId;

      // Poll the agent until it has a connectable URL. The provision job
      // can report "completed" before the cloud attaches a bridgeUrl —
      // that URL only exists once the container reaches "running" and
      // reports its bridge endpoint, which can take several minutes on
      // cold-start. Calling finishAsCloud with no URL persists a broken
      // active-server record and dead-ends the next boot in a
      // https://localhost/api/auth/status loop, so wait long enough for
      // a genuine cold-start and surface the live status to the user.
      //
      // We poll BOTH endpoints because they hydrate at different points:
      //   - getCloudCompatAgentStatus → exposes `bridgeUrl` directly off
      //     the agent's runtime status (typically the first to populate).
      //   - getCloudCompatAgent → returns a `DirectCloudAgent` whose
      //     `bridge_url` is filled from the same DB column. Eliza Cloud's
      //     non-admin route does NOT return webUiUrl, so we must accept
      //     bridgeUrl here.
      const fetchAgentWithUrl = async (
        deadlineMs: number,
      ): Promise<CloudCompatAgent | null> => {
        while (Date.now() < deadlineMs) {
          const statusRes = await client
            .getCloudCompatAgentStatus(agentId)
            .catch(() => null);
          if (statusRes?.success && statusRes.data) {
            const s = statusRes.data;
            if (s.status === "failed" || s.status === "suspended") {
              setError(
                t("runtimegate.agentFailed", {
                  defaultValue: "Cloud agent failed to start ({status}).",
                  status: s.suspendedReason ?? s.status,
                }),
              );
              return null;
            }
            if (s.status) {
              setProvisionStatus(
                t("runtimegate.cloudAgentStatus", {
                  defaultValue: "Agent {status}…",
                  status: s.status,
                }),
              );
            }
            if (s.bridgeUrl || s.webUiUrl) {
              const agentRes = await client
                .getCloudCompatAgent(agentId)
                .catch(() => null);
              if (agentRes?.success) {
                return {
                  ...agentRes.data,
                  bridge_url: s.bridgeUrl ?? agentRes.data.bridge_url ?? null,
                  web_ui_url: s.webUiUrl ?? agentRes.data.web_ui_url ?? null,
                  webUiUrl: s.webUiUrl ?? agentRes.data.webUiUrl ?? null,
                };
              }
            }
          }
          const agentRes = await client
            .getCloudCompatAgent(agentId)
            .catch(() => null);
          if (agentRes?.success) {
            const agent = agentRes.data;
            if (agent.bridge_url || agent.webUiUrl || agent.web_ui_url) {
              return agent;
            }
          }
          await new Promise<void>((r) => setTimeout(r, 2500));
        }
        return null;
      };

      if (!jobId) {
        setProvisionStatus(
          t("runtimegate.connecting", { defaultValue: "Connecting..." }),
        );
        const provisionRuntimeUrl = resolveCloudJobRuntimeUrl({
          result: null,
          data: provRes.data ?? {},
        });
        if (provisionRuntimeUrl) {
          const readyFromProvisionUrl = await client
            .getCloudCompatAgent(agentId)
            .then((agentRes) =>
              agentRes.success
                ? mergeCloudRuntimeUrl(agentRes.data, provisionRuntimeUrl)
                : null,
            )
            .catch(() => null);
          if (readyFromProvisionUrl) {
            finishAsCloud(readyFromProvisionUrl);
            return;
          }
        }
        const ready = await fetchAgentWithUrl(
          Date.now() + AGENT_URL_WAIT_DEADLINE_MS,
        );
        if (ready) {
          finishAsCloud(ready);
        } else {
          setError(
            t("runtimegate.agentNotReady", {
              defaultValue:
                "Agent created but isn't ready yet (no connectable URL). Try again in a moment.",
            }),
          );
          setCloudStage("agent-list");
        }
        return;
      }

      let consecutivePollFailures = 0;
      const stopPollingWithError = (message: string) => {
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
        setError(message);
        setCloudStage("agent-list");
      };
      const provisionJobDeadlineMs =
        Date.now() +
        Math.max(
          PROVISION_JOB_WAIT_DEADLINE_MS,
          provRes.polling?.expectedDurationMs ?? 0,
        );
      const pollProvisionJob = async () => {
        if (Date.now() >= provisionJobDeadlineMs) {
          stopPollingWithError(
            t("runtimegate.provisioningStillRunning", {
              defaultValue:
                "Cloud provisioning is still running after several minutes. Retry to resume status checks.",
            }),
          );
          return;
        }

        let jobRes: Awaited<ReturnType<typeof client.getCloudCompatJobStatus>>;
        try {
          jobRes = await client.getCloudCompatJobStatus(jobId);
        } catch (err) {
          consecutivePollFailures += 1;
          if (consecutivePollFailures >= 3) {
            stopPollingWithError(
              err instanceof Error
                ? err.message
                : t("runtimegate.provisioningStatusFailed", {
                    defaultValue: "Provisioning status check failed",
                  }),
            );
          }
          return;
        }

        if (!jobRes.success) {
          consecutivePollFailures += 1;
          if (consecutivePollFailures >= 3) {
            stopPollingWithError(
              t("runtimegate.provisioningStatusUnavailable", {
                defaultValue: "Provisioning status unavailable",
              }),
            );
          }
          return;
        }

        consecutivePollFailures = 0;

        const job: CloudCompatJob = jobRes.data;
        if (job.status === "completed") {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
          setProvisionStatus(
            t("runtimegate.connecting", { defaultValue: "Connecting..." }),
          );
          const jobRuntimeUrl = resolveCloudJobRuntimeUrl(job);
          const readyFromJob =
            jobRuntimeUrl && !isCloudControlPlaneUrl(jobRuntimeUrl)
              ? await client
                  .getCloudCompatAgent(agentId)
                  .then((agentRes) =>
                    agentRes.success
                      ? mergeCloudRuntimeUrl(agentRes.data, jobRuntimeUrl)
                      : null,
                  )
                  .catch(() => null)
              : null;
          const ready =
            readyFromJob ??
            (await fetchAgentWithUrl(Date.now() + AGENT_URL_WAIT_DEADLINE_MS));
          if (ready) {
            finishAsCloud(ready);
          } else {
            setError(
              t("runtimegate.agentNotReady", {
                defaultValue:
                  "Agent created but isn't ready yet (no connectable URL). Try again in a moment.",
              }),
            );
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
      };

      void pollProvisionJob();
      pollTimerRef.current = setInterval(() => {
        void pollProvisionJob();
      }, provRes.polling?.intervalMs ?? 2500);
    },
    [finishAsCloud, t],
  );

  const handleConnectCloudAgent = useCallback(
    (agent: CloudCompatAgent) => {
      if (agent.status === "failed") {
        return;
      }
      if (agent.status !== "running" || !resolveCloudAgentApiBase(agent)) {
        void provisionAndConnect(agent.agent_id).catch((err) => {
          setError(
            err instanceof Error
              ? err.message
              : t("runtimegate.unknownError", {
                  defaultValue: "Unknown error",
                }),
          );
          setCloudStage("agent-list");
        });
        return;
      }
      finishAsCloud(agent);
    },
    [finishAsCloud, provisionAndConnect, t],
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
          (res as { error?: string }).error ||
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
          if (primary.status === "failed") {
            setError(
              primary.error_message ||
                t("runtimegate.cloudAgentFailed", {
                  defaultValue: "Cloud agent failed to start.",
                }),
            );
            setCloudStage("agent-list");
            return;
          }
          if (
            primary.status !== "running" ||
            !resolveCloudAgentApiBase(primary)
          ) {
            await provisionAndConnect(primary.agent_id);
            return;
          }
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
          createRes.data?.message ||
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
    const win = preOpenWindow();
    setError(null);
    await handleCloudLogin(win);
  }, [handleCloudLogin]);

  const handleRefreshAgents = useCallback(() => {
    setError(null);
    setCloudStage("loading");
  }, []);

  // ── Render: ElizaOS local-only splash ────────────────────────────
  // ElizaOS never shows the picker tiles — the device IS the agent. Render
  // the same yellow "INITIALIZING AGENT…" bar that surrounds the rest of the
  // startup flow and let the probe-poll + auto-pick effect upstream call
  // `finishAsLocal()` once the on-device agent answers `/api/health`.
  // Settings ▸ Runtime opens this component with `?runtime=picker` to
  // bypass this branch and render the chooser. The vanilla Android APK
  // never enters this branch and falls through to the chooser below.
  if (elizaOSAutoLocal) {
    return (
      <ElizaOSLocalSplash
        message={t("runtimegate.startingLocalAgent", {
          defaultValue: "INITIALIZING AGENT...",
        })}
      />
    );
  }

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
            <fieldset
              className={`mt-5 grid w-full gap-2.5 text-left md:mt-7 md:gap-3 ${
                runtimeChoices.length === 3 ? "md:grid-cols-3" : ""
              }`}
            >
              <legend className="sr-only">
                {t("runtimegate.subtitle", {
                  defaultValue: "Where should your agent run?",
                })}
              </legend>
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
            </fieldset>

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
                      target: runtimeChoiceDetails(selectedChoice, t, isAndroid)
                        .label,
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
            {error && (
              <p
                style={{ fontFamily: MONO_FONT }}
                className="mt-3 text-3xs text-red-400"
              >
                {error}
              </p>
            )}
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

        {/* Local embeddings preference — visible whenever the cloud path is
            active and the user can still interact (not yet connecting). */}
        {cloudStage !== "connecting" && (
          <LocalEmbeddingsCheckbox
            checked={useLocalEmbeddings}
            onCheckedChange={setUseLocalEmbeddings}
          />
        )}

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
            {(error || elizaCloudLoginError) && (
              <p
                style={{ fontFamily: MONO_FONT }}
                className="text-3xs text-red-400"
              >
                {error || elizaCloudLoginError}
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
                          onClick={() => handleConnectCloudAgent(agent)}
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

  // ── Render: local setup wizard ─────────────────────────────────────
  if (subView === "local") {
    const selectedProvider = localProviderId
      ? localProviderCatalog.find((p) => p.id === localProviderId)
      : null;
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
            {localStage === "provider"
              ? t("runtimegate.localPickEyebrow", {
                  defaultValue: "Pick a model provider",
                })
              : t("runtimegate.localConfigEyebrow", {
                  defaultValue: "Add your API key",
                })}
          </p>

          {localStage === "provider" && (
            <div className="flex flex-col gap-2">
              {localProviderCatalog.map((provider) => (
                <Card
                  key={provider.id}
                  className="border-2 border-[#f0b90b]/40 bg-black/58 text-white shadow-[4px_4px_0_rgba(0,0,0,0.52)]"
                  style={{ borderRadius: 0 }}
                >
                  <CardContent className="flex items-center justify-between gap-3 px-3 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-white/95">
                        {provider.name}
                      </p>
                      <p className="truncate text-xs-tight text-white/52">
                        {provider.description}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0 rounded-none border-2 border-black bg-[#ffe600] text-xs font-black uppercase tracking-[0.12em] text-black hover:bg-white"
                      onClick={() => handleLocalSelectProvider(provider.id)}
                    >
                      {t("common.choose", { defaultValue: "Choose" })}
                    </Button>
                  </CardContent>
                </Card>
              ))}
              <BackButton t={t} onClick={() => setSubView("chooser")} />
            </div>
          )}

          {localStage === "config" && selectedProvider && (
            <div className="flex flex-col gap-3">
              <Card
                className="border-2 border-[#f0b90b]/40 bg-black/58 text-white shadow-[4px_4px_0_rgba(0,0,0,0.52)]"
                style={{ borderRadius: 0 }}
              >
                <CardContent className="flex flex-col gap-1 px-3 py-3">
                  <p className="text-sm font-semibold text-white/95">
                    {selectedProvider.name}
                  </p>
                  <p className="text-xs-tight text-white/52">
                    {selectedProvider.description}
                  </p>
                </CardContent>
              </Card>

              <Input
                type="password"
                autoComplete="off"
                placeholder={
                  selectedProvider.keyPrefix
                    ? t("runtimegate.localApiKeyPlaceholderPrefixed", {
                        defaultValue: "{{prefix}}…",
                        prefix: selectedProvider.keyPrefix,
                      })
                    : t("runtimegate.localApiKeyPlaceholder", {
                        defaultValue: "API key",
                      })
                }
                value={localApiKey}
                onChange={(e) => setLocalApiKey(e.target.value)}
                disabled={localSaving}
                className="!h-11 !rounded-none !border-2 !border-black !bg-white !px-3 !text-sm !text-black"
              />

              {localError ? (
                <p className="text-xs text-danger">{localError}</p>
              ) : null}

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  className="rounded-none border-2 border-black bg-[#ffe600] text-xs font-black uppercase tracking-[0.12em] text-black hover:bg-white"
                  onClick={() => void handleLocalSave()}
                  disabled={localSaving || !localApiKey.trim()}
                >
                  {localSaving ? (
                    <span className="inline-flex items-center gap-2">
                      <Spinner className="h-3 w-3" />
                      {t("common.saving", { defaultValue: "Saving…" })}
                    </span>
                  ) : (
                    t("runtimegate.localSaveContinue", {
                      defaultValue: "Continue to chat",
                    })
                  )}
                </Button>
                <BackButton
                  t={t}
                  onClick={handleLocalConfigBack}
                  disabled={localSaving}
                />
              </div>
            </div>
          )}
        </div>
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
          onInput={(e) => setRemoteUrl((e.target as HTMLInputElement).value)}
          onBlur={(e) => setRemoteUrl(e.target.value)}
          className="h-11 rounded-none border-2 border-[#f0b90b]/35 bg-black/48 text-white text-sm placeholder:text-white/40"
        />

        <Input
          placeholder={t("runtimegate.remoteTokenPlaceholder", {
            defaultValue: "Access token (optional)",
          })}
          type="password"
          value={remoteToken}
          onChange={(e) => setRemoteToken(e.target.value)}
          onInput={(e) => setRemoteToken((e.target as HTMLInputElement).value)}
          onBlur={(e) => setRemoteToken(e.target.value)}
          className="h-11 rounded-none border-2 border-[#f0b90b]/35 bg-black/48 text-white text-sm placeholder:text-white/40"
        />

        {error && (
          <p
            style={{ fontFamily: MONO_FONT }}
            className="text-3xs text-red-400"
          >
            {error}
          </p>
        )}

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
    <div className="relative h-full min-h-0 w-full overflow-hidden bg-black text-white overscroll-none">
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

      <div className="relative z-10 flex h-full min-h-0 items-center justify-center px-3 pb-[max(0.75rem,var(--safe-area-bottom,0px))] pt-[calc(var(--safe-area-top,0px)_+_3.75rem)] sm:px-6 md:px-8">
        <div
          className="flex max-h-full min-h-0 w-full max-w-[72rem] flex-col items-center gap-3 overflow-hidden border-2 border-black bg-[rgba(9,10,14,0.82)] px-3 py-4 shadow-[9px_9px_0_rgba(0,0,0,0.62)] backdrop-blur-md sm:gap-4 sm:px-6 sm:py-7 md:px-8 md:py-8"
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
  imageSrc?: string;
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
    "group flex w-full min-w-0 border-2 p-1.5 text-left shadow-[5px_5px_0_rgba(0,0,0,0.62)] transition-[background-color,border-color,color,transform,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ffe600] focus-visible:ring-offset-2 focus-visible:ring-offset-black md:min-h-[21rem] md:flex-col md:p-3",
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
      aria-pressed={selected}
      aria-disabled={disabled}
      data-runtime-choice={choice}
      style={{
        borderRadius: 0,
        clipPath:
          "polygon(12px 0,100% 0,100% calc(100% - 12px),calc(100% - 12px) 100%,0 100%,0 12px)",
      }}
    >
      {imageSrc && (
        <span
          className={`relative h-20 w-24 shrink-0 overflow-hidden border-2 sm:h-24 sm:w-28 md:h-36 md:w-full ${imageBorderClassName}`}
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
      )}
      <span className="flex min-w-0 flex-1 flex-col px-2 py-0.5 sm:px-3 sm:py-1.5 md:px-1 md:pt-3">
        <span
          style={{ fontFamily: MONO_FONT }}
          className={`text-3xs uppercase tracking-[0.18em] ${eyebrowClassName}`}
        >
          {eyebrow}
        </span>
        <span
          style={{ fontFamily: MONO_FONT }}
          className="mt-1 text-base font-black uppercase leading-none tracking-[0.08em] sm:text-lg md:text-2xl"
        >
          {label}
        </span>
        <span
          className={`mt-1.5 text-[11px] font-bold leading-snug sm:mt-2 sm:text-xs ${titleClassName}`}
        >
          {title}
        </span>
        <span
          className={`mt-1 text-[12px] leading-[1.25] sm:text-xs-tight sm:leading-snug ${descriptionClassName}`}
        >
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

/**
 * ElizaOS-only "starting your local agent" splash. Matches the yellow
 * segmented-bar style of `StartupShell`'s loading screens so the transition
 * from auth/agent handshake → onboarding → chat reads as one continuous
 * boot. The auto-pick effect in `RuntimeGate` calls `finishAsLocal()` as
 * soon as the probe succeeds, at which point this component unmounts.
 */
function ElizaOSLocalSplash({ message }: { message: string }) {
  return (
    <div
      data-testid="runtime-gate-elizaos-local-splash"
      className="relative flex h-full w-full items-center justify-center overflow-hidden bg-[#ffe600] text-black"
    >
      <img
        src={resolveAppAssetUrl("splash-bg.png")}
        alt=""
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full object-cover"
      />
      <div
        className="relative z-10 flex w-full flex-col items-center gap-5 px-6 text-center"
        style={{ maxWidth: 360 }}
      >
        <div className="w-full mt-2">
          <div className="h-5 w-full overflow-hidden border-2 border-black/70 bg-black/5">
            <div
              className="h-full w-full bg-black/70 transition-all duration-700 ease-out"
              style={{
                backgroundImage:
                  "repeating-linear-gradient(90deg, transparent, transparent 6px, rgba(255,230,0,0.5) 6px, rgba(255,230,0,0.5) 8px)",
              }}
            />
          </div>
          <p
            style={{ fontFamily: MONO_FONT }}
            className="mt-2 animate-pulse text-3xs uppercase text-black/70"
          >
            {message}
          </p>
        </div>
      </div>
    </div>
  );
}

function BackButton({
  t,
  onClick,
  disabled = false,
}: {
  t: (key: string, values?: Record<string, unknown>) => string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{ fontFamily: MONO_FONT }}
      className="mt-2 self-center text-3xs uppercase text-white/60 underline hover:text-white disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-white/60"
    >
      {t("common.back", { defaultValue: "Back" })}
    </button>
  );
}

const LOCAL_EMBEDDINGS_TOOLTIP =
  "Embeddings are vector representations of your messages, used for memory and search. Keeping them local means your message text isn't sent to the cloud just to compute vectors. Chat still goes through the cloud.";

function LocalEmbeddingsCheckbox({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-2.5 py-1">
      <Checkbox
        id="runtime-gate-local-embeddings"
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        className="mt-0.5 shrink-0 border-white/30 bg-white/10 data-[state=checked]:border-[#f0b90b]/60 data-[state=checked]:bg-[#f0b90b]/20"
        aria-label="Use local embeddings"
      />
      <div className="flex min-w-0 items-center gap-1.5">
        <label
          htmlFor="runtime-gate-local-embeddings"
          className="cursor-pointer text-xs-tight text-white/80 select-none"
        >
          Use local embeddings
        </label>
        <TooltipHint content={LOCAL_EMBEDDINGS_TOOLTIP} side="top">
          <span
            className="inline-flex h-4 w-4 shrink-0 cursor-help items-center justify-center rounded-full border border-white/20 text-2xs text-white/50 hover:text-white/70"
            aria-hidden="true"
          >
            ?
          </span>
        </TooltipHint>
      </div>
    </div>
  );
}
