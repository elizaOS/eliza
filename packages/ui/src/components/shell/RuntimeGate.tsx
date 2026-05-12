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
import { ChevronLeft } from "lucide-react";
import * as React from "react";
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
import { APP_RESUME_EVENT } from "../../events";
import { useRenderGuard } from "../../hooks/useRenderGuard";
import { normalizeLanguage } from "../../i18n";
import type { UiLanguage } from "../../i18n/messages";
import { autoDownloadRecommendedLocalModelInBackground } from "../../onboarding/auto-download-recommended";
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
  RUNTIME_PICKER_TARGET_QUERY_NAME,
  type RuntimePickerTarget,
} from "../../onboarding/reload-into-runtime-picker";
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
  savePersistedActiveServer,
  type UiTheme,
  useApp,
} from "../../state";
import {
  getElizaApiBase,
  preOpenWindow,
  resolveAppAssetUrl,
} from "../../utils";
import { LanguageDropdown } from "../shared/LanguageDropdown";
import { ThemeToggle } from "../shared/ThemeToggle";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { TooltipHint } from "../ui/tooltip";
import { ProvisioningChatView } from "./ProvisioningChatView";

const MONO_FONT = "'Courier New', 'Courier', 'Monaco', monospace";

const DEFAULT_AUTO_AGENT_NAME = "My Agent";

const CLOUD_AGENT_PROBE_TIMEOUT_MS = 4_000;
const PROVISION_START_STILL_WAITING_MS = 5_000;
const PROVISION_START_TIMEOUT_MS = 20_000;
const PROVISION_JOB_WAIT_DEADLINE_MS = 600_000;
const AGENT_URL_WAIT_DEADLINE_MS = 300_000;

type NativeAgentPlugin = {
  start?: (options?: {
    apiBase?: string;
    mode?: "local" | "cloud" | "cloud-hybrid" | "remote-mac" | string;
  }) => Promise<unknown>;
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
    await registeredAgent.start?.({
      apiBase: MOBILE_LOCAL_AGENT_API_BASE,
      mode: "local",
    });
  } catch (err) {
    console.warn(
      "[RuntimeGate] Failed to start mobile local agent",
      err instanceof Error ? err.message : err,
    );
  }
}

const DEFAULT_LOCAL_AGENT_API_BASE = "http://127.0.0.1:31337";

// Resolve the local-agent base at call time. The dev orchestrator may
// port-shift the API away from 31337 when that port is taken; Electrobun
// pushes the resolved base into `window.__ELIZA_API_BASE__` either via
// HTML injection (production static-server) or via the `apiBaseUpdate`
// RPC (Vite dev). A frozen constant misses both, leaving the renderer
// stuck on the wrong port.
function resolveLocalAgentApiBase(): string {
  return getElizaApiBase() ?? DEFAULT_LOCAL_AGENT_API_BASE;
}

/**
 * Branded native shells (AOSP/ElizaOS, where the device IS the on-device
 * agent) expose the agent's per-boot bearer through a synchronous
 * `window.ElizaNative.getLocalAgentToken()` JavascriptInterface. Reading
 * it during the local-mode wire-up means `/api/auth/status` can
 * authenticate on the very first poll, skipping the legacy "type the
 * pair code from the agent log" prompt on devices that own the bearer
 * locally.
 *
 * Stock Capacitor builds never register the bridge (the global is
 * undefined), so this returns null and the existing pair-code path
 * continues to run unchanged.
 */
function readSyncOnDeviceAgentBearer(): string | null {
  try {
    const bridge = (
      globalThis as typeof globalThis & {
        ElizaNative?: { getLocalAgentToken?: () => string | null };
      }
    ).ElizaNative;
    const token = bridge?.getLocalAgentToken?.();
    if (typeof token !== "string") return null;
    const trimmed = token.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
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

export function readPickerTargetOverride(): RuntimePickerTarget | null {
  if (typeof window === "undefined") return null;
  try {
    const search = window.location?.search ?? "";
    const hashSearch = window.location?.hash?.split("?")[1] ?? "";
    const params = new URLSearchParams(search || hashSearch);
    const target = params.get(RUNTIME_PICKER_TARGET_QUERY_NAME);
    return target === "cloud" || target === "local" || target === "remote"
      ? target
      : null;
  } catch {
    return null;
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
  | "retry"
  | "creating"
  | "provisioning"
  | "chat"
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
      host === "api-staging.elizacloud.ai" ||
      host === "elizacloud.ai" ||
      host === "www.elizacloud.ai" ||
      host === "dev.elizacloud.ai" ||
      host === "staging.elizacloud.ai"
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

async function probeCloudAgentReachable(
  apiBase: string,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiBase.replace(/\/$/, "")}/api/health`, {
      method: "GET",
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
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

export function RuntimeGate() {
  useRenderGuard("RuntimeGate");
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

  const setUiLanguage = React.useCallback(
    (lang: UiLanguage) => setState("uiLanguage", normalizeLanguage(lang)),
    [setState],
  );

  const [subView, setSubView] = React.useState<SubView>("chooser");
  const [discoveredGateways, setDiscoveredGateways] = React.useState<
    GatewayDiscoveryEndpoint[]
  >([]);

  // Cloud sub-view
  const [cloudStage, setCloudStage] = React.useState<CloudStage>(
    elizaCloudConnected ? "loading" : "login",
  );
  const [currentAgentId, setCurrentAgentId] = React.useState<string | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [provisionStatus, setProvisionStatus] = React.useState("");
  const pollTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(
    null,
  );

  // Remote sub-view
  const [remoteUrl, setRemoteUrl] = React.useState("");
  const [remoteToken, setRemoteToken] = React.useState("");

  // Local embeddings toggle (elizacloud only, default unchecked)
  const [useLocalEmbeddings, setUseLocalEmbeddings] = React.useState(false);

  // Local-runtime setup wizard. When the user picks "Local" in the
  // chooser we render an in-place wizard (provider list → API key entry)
  // before completing onboarding. Without this, finishAsLocal() drops
  // the user straight into chat with no model provider configured —
  // their first send hits the no_provider gate (commit 28e19c8023) and
  // they have to backtrack to Settings. The wizard saves the round-trip.
  const [localStage, setLocalStage] = React.useState<LocalStage>("provider");
  const [localProviderId, setLocalProviderId] = React.useState<string | null>(
    null,
  );
  const [localApiKey, setLocalApiKey] = React.useState("");
  const [localSaving, setLocalSaving] = React.useState(false);
  const [localError, setLocalError] = React.useState<string | null>(null);

  // Filter catalog to direct API-key providers (group:"local" excludes
  // managed cloud + subscription paths — those have their own flows).
  const localProviderCatalog = React.useMemo<
    readonly OnboardingProviderOption[]
  >(
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
  const [localProbeResult, setLocalProbeResult] = React.useState<
    boolean | null
  >(synchronousLocal ? true : isAndroid || isIOS ? null : false);

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
  const pickerTargetOverride = readPickerTargetOverride();
  const elizaOSAutoLocal = isElizaOS() && !pickerOverride;

  React.useEffect(() => {
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

  // ── Re-probe `/api/health` on app resume ──────────────────────────
  // iOS / Android can suspend the WKWebView for minutes at a time. On
  // resume the FGS or dev server may have respawned on a new port (the
  // dev orchestrator auto-shifts when defaults are busy). Re-running the
  // probe nudges the gate back to the picker UI instead of leaving the
  // user stranded on a stale chooser screen with a tile that points at a
  // dead endpoint.
  React.useEffect(() => {
    if (synchronousLocal) return;
    if (!isAndroid && !isIOS) return;
    const onResume = (): void => {
      shouldShowLocalOption({ isDesktop, isDev, isAndroid, isIOS })
        .then((ok) => {
          setLocalProbeResult(ok);
          if (!ok) {
            // Fall back to the chooser when the probe fails so the user
            // can pick a different runtime instead of seeing a dead
            // Local tile.
            setSubView((current) =>
              current === "local" ? "chooser" : current,
            );
          }
        })
        .catch(() => {
          setLocalProbeResult(false);
          setSubView((current) => (current === "local" ? "chooser" : current));
        });
    };
    document.addEventListener(APP_RESUME_EVENT, onResume);
    return () => {
      document.removeEventListener(APP_RESUME_EVENT, onResume);
    };
  }, [isDesktop, isDev, synchronousLocal]);

  const showLocalOption = localProbeResult === true;
  const localProbePending = localProbeResult === null;

  const runtimeChoices = React.useMemo(
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

  React.useEffect(() => {
    if (!pickerOverride || !pickerTargetOverride) return;
    if (!runtimeChoices.includes(pickerTargetOverride)) return;
    setSubView((current) =>
      current === "chooser" ? pickerTargetOverride : current,
    );
  }, [pickerOverride, pickerTargetOverride, runtimeChoices]);

  // ── Gateway discovery (LAN autodetect) ────────────────────────────
  React.useEffect(() => {
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
  React.useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  // ── Cleanup poll when leaving cloud sub-view ──────────────────────
  // The provision poll lives inside subView="cloud". Switching back to the
  // chooser (or to "remote") used to leak the interval — it kept calling
  // setProvisionStatus / setError / finishAsCloud against a screen the user
  // had already left, racing with their next choice.
  React.useEffect(() => {
    if (subView !== "cloud" && pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, [subView]);

  // ── Cloud: auto-advance from login when connected ─────────────────
  React.useEffect(() => {
    if (elizaCloudConnected && cloudStage === "login") {
      setCloudStage("loading");
    }
  }, [elizaCloudConnected, cloudStage]);

  // ── Completion helpers ─────────────────────────────────────────────

  const finishAsCloud = React.useCallback(
    async (agent: CloudCompatAgent) => {
      // Refuse to complete cloud onboarding without a usable agent URL —
      // persisting an active server with no apiBase puts the next boot
      // into an infinite loopback poll (`https://localhost/api/auth/status`)
      // because client.getBaseUrl() falls back to window.location.origin
      // when nothing is set. Surface the failure so the user can retry
      // instead of silently writing a broken active-server record.
      let apiBase = resolveCloudAgentApiBase(agent);
      if (!apiBase) {
        setError(
          t("runtimegate.cloudAgentMissingUrl", {
            defaultValue:
              "Cloud agent is not reachable yet. Retry after it finishes starting.",
          }),
        );
        setCloudStage("retry");
        return;
      }
      setCloudStage("connecting");

      let label = agent.agent_name;
      let accessToken: string | undefined;
      try {
        const launchRes = await client.launchCloudCompatAgent(agent.agent_id);
        const launchConnection = launchRes.data?.connection;
        const launchApiBase = normalizeRuntimeUrl(launchConnection?.apiBase);
        const launchToken = launchConnection?.token?.trim();

        if (!launchRes.success || !launchApiBase || !launchToken) {
          throw new Error(
            launchRes.error ||
              t("runtimegate.cloudLaunchMissingConnection", {
                defaultValue:
                  "Cloud did not return a runtime connection for this agent.",
              }),
          );
        }

        apiBase = launchApiBase;
        accessToken = launchToken;
        if (launchRes.data?.agentName) {
          label = launchRes.data.agentName;
        }
      } catch (err) {
        setError(
          displayErrorMessage(
            err,
            t("runtimegate.cloudLaunchFailed", {
              defaultValue: "Cloud agent launch failed. Please retry.",
            }),
          ),
        );
        setCloudStage("retry");
        return;
      }

      savePersistedActiveServer({
        id: `cloud:${agent.agent_id}`,
        kind: "cloud",
        label,
        apiBase,
        ...(accessToken ? { accessToken } : {}),
      });
      addAgentProfile({
        kind: "cloud",
        label,
        cloudAgentId: agent.agent_id,
        apiBase,
        ...(accessToken ? { accessToken } : {}),
      });

      setError(null);
      client.setBaseUrl(apiBase);
      client.setToken(accessToken ?? null);
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

  const finishAsLocal = React.useCallback(() => {
    setError(null);
    const localApiBase =
      isAndroid || isIOS
        ? MOBILE_LOCAL_AGENT_API_BASE
        : resolveLocalAgentApiBase();
    if (isAndroid || isIOS) {
      // Mobile local mode always pins the loopback-shaped base URL. Android
      // serves it from the foreground service; iOS intercepts the same URL
      // through the in-process ITTP transport before any TCP request is made.
      // Persisting it as a `remote` active server keeps the existing startup
      // restore branch working while `local` mobile runtime mode records the
      // user-visible distinction.
      //
      // AOSP / branded native shells expose the on-device agent's per-boot
      // bearer through `window.ElizaNative.getLocalAgentToken()` so the
      // first /api/auth/status fetch can authenticate without showing the
      // pair-code prompt. Stock Capacitor builds don't register the bridge
      // (the call returns null), preserving the legacy "user types the pair
      // code from the agent log" flow on those targets.
      client.setBaseUrl(localApiBase);
      client.setToken(readSyncOnDeviceAgentBearer());
      savePersistedActiveServer({
        id: isAndroid
          ? ANDROID_LOCAL_AGENT_SERVER_ID
          : MOBILE_LOCAL_AGENT_SERVER_ID,
        kind: "remote",
        label: isAndroid ? ANDROID_LOCAL_AGENT_LABEL : MOBILE_LOCAL_AGENT_LABEL,
        apiBase: localApiBase,
      });
      addAgentProfile({
        kind: "remote",
        label: isAndroid ? ANDROID_LOCAL_AGENT_LABEL : MOBILE_LOCAL_AGENT_LABEL,
        apiBase: localApiBase,
      });
      void startMobileLocalAgent();
      // Fire-and-forget: don't gate the UI on the model download. The user
      // lands in chat immediately; the recommended model is enqueued as
      // soon as the runtime answers /api/health.
      void autoDownloadRecommendedLocalModelInBackground(localApiBase);
    } else {
      // Desktop: the local agent IS the bundled API on loopback.
      // The dev orchestrator may bind a port other than 31337 when that
      // port is taken — `resolveLocalAgentApiBase()` reads the resolved
      // base from `window.__ELIZA_API_BASE__` (set by Electrobun's
      // HTML injection or `apiBaseUpdate` RPC). Setting `baseUrl(null)`
      // would fall back to the page origin (Electrobun static server or
      // Vite), which has no `/api` routes — every fetch 404s and the
      // app gets stuck in a reconnect loop.
      client.setBaseUrl(localApiBase);
      client.setToken(null);
      savePersistedActiveServer({
        id: "local:desktop",
        kind: "remote",
        label: "On-device agent",
        apiBase: localApiBase,
      });
      addAgentProfile({
        kind: "remote",
        label: "On-device agent",
        apiBase: localApiBase,
      });
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
  React.useEffect(() => {
    if (!elizaOSAutoLocal) return;
    if (!showLocalOption) return;
    finishAsLocal();
  }, [elizaOSAutoLocal, finishAsLocal, showLocalOption]);

  const finishAsRemoteGateway = React.useCallback(
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

  const finishAsRemote = React.useCallback(() => {
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

  const handleLocalSelectProvider = React.useCallback((providerId: string) => {
    setLocalProviderId(providerId);
    setLocalApiKey("");
    setLocalError(null);
    setLocalStage("config");
  }, []);

  const handleLocalConfigBack = React.useCallback(() => {
    setLocalStage("provider");
    setLocalError(null);
  }, []);

  const handleLocalSave = React.useCallback(async () => {
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

  const provisionAndConnect = React.useCallback(
    async (agentId: string, existingJobId?: string) => {
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
      // If create already queued a job (compat-namespace flow), use that
      // jobId directly. Calling provisionCloudCompatAgent again on a
      // compat-created agent returns 405 (the v1/app provision endpoint
      // doesn't recognize compat-namespace agent IDs).
      let jobId: string | undefined = existingJobId;
      let provisionData:
        | Awaited<ReturnType<typeof client.provisionCloudCompatAgent>>["data"]
        | undefined;
      let pollingIntervalMs: number | undefined;
      let provisionExpectedDurationMs = 0;
      if (!jobId) {
        let provRes: Awaited<
          ReturnType<typeof client.provisionCloudCompatAgent>
        >;
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
          setCloudStage("retry");
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
          setCloudStage("retry");
          return;
        }
        provisionData = provRes.data;
        jobId = provRes.data?.jobId;
        pollingIntervalMs = provRes.polling?.intervalMs;
        provisionExpectedDurationMs = provRes.polling?.expectedDurationMs ?? 0;
      }

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
          data: provisionData ?? {},
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
            await finishAsCloud(readyFromProvisionUrl);
            return;
          }
        }
        const ready = await fetchAgentWithUrl(
          Date.now() + AGENT_URL_WAIT_DEADLINE_MS,
        );
        if (ready) {
          await finishAsCloud(ready);
        } else {
          setError(
            t("runtimegate.agentNotReady", {
              defaultValue:
                "Agent created but isn't ready yet (no connectable URL). Try again in a moment.",
            }),
          );
          setCloudStage("retry");
        }
        return;
      }

      let consecutivePollFailures = 0;
      const stopPollingWithError = (message: string) => {
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
        setError(message);
        setCloudStage("retry");
      };
      const provisionJobDeadlineMs =
        Date.now() +
        Math.max(PROVISION_JOB_WAIT_DEADLINE_MS, provisionExpectedDurationMs);
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
            await finishAsCloud(ready);
          } else {
            setError(
              t("runtimegate.agentNotReady", {
                defaultValue:
                  "Agent created but isn't ready yet (no connectable URL). Try again in a moment.",
              }),
            );
            setCloudStage("retry");
          }
        } else if (job.status === "failed") {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
          setError(job.error ?? "Provisioning failed");
          setCloudStage("retry");
        } else {
          setProvisionStatus(`Provisioning (${job.status})...`);
        }
      };

      void pollProvisionJob();
      pollTimerRef.current = setInterval(() => {
        void pollProvisionJob();
      }, pollingIntervalMs ?? 2500);
    },
    [finishAsCloud, t],
  );

  // ── Cloud: auto-pick an existing agent, or auto-create one ────────
  // During onboarding the cloud path is intentionally automatic: pick a
  // usable existing agent, start it if needed, or create "My Agent".
  // The user should not have to select an agent or click a second Connect.
  React.useEffect(() => {
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
        setCloudStage("retry");
        return;
      }

      const agentList = res.data;

      if (agentList.length > 0) {
        const primary =
          agentList.find(
            (agent) =>
              agent.status === "running" && resolveCloudAgentApiBase(agent),
          ) ??
          agentList.find(
            (agent) =>
              agent.status !== "failed" && agent.status !== "suspended",
          ) ??
          agentList[0];
        if (primary) {
          if (primary.status === "failed" || primary.status === "suspended") {
            setError(
              primary.error_message ||
                t("runtimegate.cloudAgentFailed", {
                  defaultValue:
                    "Cloud agent is not available. Retry after checking Eliza Cloud.",
                }),
            );
            setCloudStage("retry");
            return;
          }
          const primaryApiBase = resolveCloudAgentApiBase(primary);
          if (primary.status !== "running" || !primaryApiBase) {
            setCurrentAgentId(primary.agent_id);
            await provisionAndConnect(primary.agent_id);
            return;
          }
          const reachable = await probeCloudAgentReachable(
            primaryApiBase,
            CLOUD_AGENT_PROBE_TIMEOUT_MS,
          );
          if (cancelled) return;
          if (!reachable) {
            setCurrentAgentId(primary.agent_id);
            await provisionAndConnect(primary.agent_id);
            return;
          }
          await finishAsCloud(primary);
          return;
        }
      }

      // No agents yet — auto-create "My Agent" and provision.
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
        setCloudStage("retry");
        return;
      }
      // MUST stay below the createCloudCompatAgent await — setting cloudStage
      // earlier fires this effect's cleanup (cloudStage is in deps), flips
      // cancelled=true, and the post-await guard then bails before
      // provisionAndConnect runs.
      setCloudStage("auto-creating");
      setCurrentAgentId(createRes.data.agentId);

      // Show the provisioning chat while the container warms up, then
      // kick off provisionAndConnect in the background (non-blocking).
      setCloudStage("chat");

      // Compat create returns a jobId because the cloud queues provisioning
      // automatically. Pass it through so we skip the redundant provision call
      // (which would 405 on a compat-namespace agent) and poll the job directly.
      try {
        await provisionAndConnect(
          createRes.data.agentId,
          createRes.data.jobId ?? undefined,
        );
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t("runtimegate.unknownError", { defaultValue: "Unknown error" }),
        );
        setCloudStage("retry");
      }
    })().catch((err) => {
      if (cancelled) return;
      setError(
        err instanceof Error
          ? err.message
          : t("runtimegate.unknownError", { defaultValue: "Unknown error" }),
      );
      setCloudStage("retry");
    });

    return () => {
      cancelled = true;
    };
  }, [subView, cloudStage, finishAsCloud, provisionAndConnect, t]);

  const handleLogin = React.useCallback(async () => {
    const win = preOpenWindow();
    setError(null);
    await handleCloudLogin(win);
  }, [handleCloudLogin]);

  const handleRefreshAgents = React.useCallback(() => {
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
    const cloudAvailable = runtimeChoices.includes("cloud");
    const localAvailable = runtimeChoices.includes("local");
    const remoteAvailable = runtimeChoices.includes("remote");
    // Default fast-track: cloud when available (90% case),
    // local when this is a local-only build, remote as last resort.
    const handleGetStarted = () => {
      if (cloudAvailable) {
        setSubView("cloud");
        return;
      }
      if (localAvailable) {
        finishAsLocal();
        return;
      }
      if (remoteAvailable) setSubView("remote");
    };
    const showAdvancedDisclosure =
      !localOnly && (localAvailable || remoteAvailable) && cloudAvailable;

    return (
      <GateShell
        uiLanguage={uiLanguage}
        setUiLanguage={setUiLanguage}
        uiTheme={uiTheme}
        setUiTheme={setUiTheme}
        t={t}
      >
        {runtimeChoices.length === 0 ? (
          <>
            <GateHeader t={t} />
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
            {error && (
              <p
                style={{ fontFamily: MONO_FONT }}
                className="mt-3 text-3xs text-red-400"
              >
                {error}
              </p>
            )}
          </>
        ) : (
          <WelcomeChooser
            onGetStarted={handleGetStarted}
            getStartedLabel={
              cloudAvailable
                ? t("runtimegate.welcomeGetStarted", {
                    defaultValue: "Get started",
                  })
                : localAvailable
                  ? t("runtimegate.welcomeStartLocal", {
                      defaultValue: "Start your local agent",
                    })
                  : t("runtimegate.welcomeConnectRemote", {
                      defaultValue: "Connect to your agent",
                    })
            }
            showAdvanced={showAdvancedDisclosure}
            advancedShowsLocal={!localOnly && localAvailable && cloudAvailable}
            advancedShowsRemote={remoteAvailable && cloudAvailable}
            onUseLocal={finishAsLocal}
            onConnectRemote={() => setSubView("remote")}
            t={t}
          />
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
        <SubviewHeader
          title={
            cloudStage === "login"
              ? t("runtimegate.cloudHeaderLogin", {
                  defaultValue: "Sign in to Eliza Cloud",
                })
              : cloudStage === "auto-creating" ||
                  cloudStage === "loading" ||
                  cloudStage === "chat"
                ? t("runtimegate.cloudHeaderProvisioning", {
                    defaultValue: "Setting up your agent",
                  })
                : t("runtimegate.cloudHeaderConnect", {
                    defaultValue: "Connect to your cloud agent",
                  })
          }
          subtitle={
            cloudStage === "login"
              ? t("runtimegate.cloudHeaderLoginSubtitle", {
                  defaultValue:
                    "We'll provision a hosted agent and keep it running. Free trial; pay for what you use.",
                })
              : undefined
          }
        />

        {/* Local embeddings preference — visible whenever the cloud path is
            active and the user can still interact (not yet connecting or in
            provisioning chat). */}
        {cloudStage !== "connecting" && cloudStage !== "chat" && (
          <LocalEmbeddingsCheckbox
            checked={useLocalEmbeddings}
            onCheckedChange={setUseLocalEmbeddings}
          />
        )}

        {cloudStage === "login" && (
          <div className="mt-4 flex w-full max-w-[28rem] flex-col gap-4 text-left">
            <Button
              type="button"
              variant="default"
              className="min-h-12 justify-center border-2 border-black bg-[#ffe600] px-6 py-4 text-sm font-black uppercase tracking-[0.16em] text-black shadow-[5px_5px_0_rgba(0,0,0,0.72)] transition-transform duration-150 hover:-translate-y-0.5 hover:bg-white active:translate-y-0"
              style={{
                borderRadius: 0,
                clipPath:
                  "polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px)",
                fontFamily: MONO_FONT,
              }}
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
                className="text-3xs uppercase tracking-wide text-red-400"
                style={{ fontFamily: MONO_FONT }}
              >
                {error || elizaCloudLoginError}
              </p>
            )}
            <BackButton t={t} onClick={() => setSubView("chooser")} />
          </div>
        )}

        {cloudStage === "chat" && (
          <div className="mt-4 flex w-full max-w-[28rem] flex-col gap-3">
            <ProvisioningChatView
              agentId={currentAgentId}
              cloudApiBase={client.getBaseUrl()}
              onContainerReady={(bridgeUrl) => {
                void client
                  .getCloudCompatAgent(currentAgentId ?? "")
                  .then((agentRes) => {
                    if (agentRes.success) {
                      void finishAsCloud({
                        ...agentRes.data,
                        bridge_url: bridgeUrl ?? agentRes.data.bridge_url,
                        containerUrl: bridgeUrl ?? agentRes.data.containerUrl,
                      });
                    }
                  })
                  .catch(() => {
                    // provisionAndConnect is still running in the background;
                    // let it complete and call finishAsCloud when ready.
                  });
              }}
              onBack={() => setCloudStage("loading")}
            />
          </div>
        )}

        {(cloudStage === "loading" ||
          cloudStage === "auto-creating" ||
          cloudStage === "creating" ||
          cloudStage === "provisioning" ||
          cloudStage === "connecting") && (
          <div className="mt-6 flex w-full max-w-[28rem] flex-col items-center gap-3">
            <Spinner className="h-6 w-6 text-[#ffe600]/80" />
            <p
              className="text-3xs uppercase tracking-[0.2em] text-white/75"
              style={{ fontFamily: MONO_FONT }}
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

        {cloudStage === "retry" && (
          <div className="mt-4 flex w-full max-w-[34rem] flex-col gap-3 text-left">
            <div className="flex items-center justify-between">
              <p
                className="text-3xs uppercase tracking-[0.2em] text-[#ffe600]/80"
                style={{ fontFamily: MONO_FONT }}
              >
                {t("runtimegate.cloudNeedsAttention", {
                  defaultValue: "Cloud connection needs attention",
                })}
              </p>
              <button
                type="button"
                onClick={handleRefreshAgents}
                className="text-3xs uppercase tracking-[0.2em] text-white/55 underline hover:text-white"
                style={{ fontFamily: MONO_FONT }}
              >
                {t("runtimegate.retry", { defaultValue: "Retry" })}
              </button>
            </div>

            {error && (
              <p
                className="text-3xs uppercase tracking-wide text-red-400"
                style={{ fontFamily: MONO_FONT }}
              >
                {error}
              </p>
            )}

            <p
              className="text-3xs uppercase tracking-wide text-white/50"
              style={{ fontFamily: MONO_FONT }}
            >
              {t("runtimegate.cloudAutoRetryHint", {
                defaultValue:
                  "Retry will check your account, start an agent if needed, and connect automatically.",
              })}
            </p>

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
              {localProviderCatalog.length === 0 ? (
                <Card
                  className="border-2 border-[#f0b90b]/40 bg-black/58 text-white shadow-[4px_4px_0_rgba(0,0,0,0.52)]"
                  style={{ borderRadius: 0 }}
                >
                  <CardContent className="px-3 py-3">
                    <p className="text-sm font-semibold text-white/90">
                      {t("runtimegate.localProviderCatalogEmpty", {
                        defaultValue: "No local providers are available.",
                      })}
                    </p>
                  </CardContent>
                </Card>
              ) : (
                localProviderCatalog.map((provider) => (
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
                ))
              )}
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
      <SubviewHeader
        title={t("runtimegate.remoteHeader", {
          defaultValue: "Connect to your agent",
        })}
        subtitle={t("runtimegate.remoteHeaderSubtitle", {
          defaultValue: "Point at an agent URL you already have running.",
        })}
      />

      <div className="mt-4 flex w-full max-w-[28rem] flex-col gap-3 text-left">
        <p
          className="text-3xs uppercase tracking-[0.22em] text-[#ffe600]/80"
          style={{ fontFamily: MONO_FONT }}
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
                className="border-2 border-[#f0b90b]/45 bg-black/65 text-white shadow-[4px_4px_0_rgba(0,0,0,0.62)]"
                style={{ borderRadius: 0 }}
              >
                <CardContent className="flex items-center justify-between gap-3 px-3 py-3">
                  <div className="min-w-0">
                    <p
                      className="text-3xs uppercase tracking-[0.2em] text-[#ffe600]/80"
                      style={{ fontFamily: MONO_FONT }}
                    >
                      {gateway.isLocal
                        ? t("startupshell.LocalNetworkAgent", {
                            defaultValue: "LAN agent",
                          })
                        : t("startupshell.NetworkAgent", {
                            defaultValue: "Network agent",
                          })}
                    </p>
                    <p
                      className="truncate text-sm font-bold uppercase text-white/95"
                      style={{ fontFamily: MONO_FONT }}
                    >
                      {gateway.name}
                    </p>
                    <p
                      className="truncate text-xs text-white/55"
                      style={{ fontFamily: MONO_FONT }}
                    >
                      {gateway.host}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0 rounded-none border-2 border-black bg-[#ffe600] text-xs font-black uppercase tracking-[0.14em] text-black shadow-[3px_3px_0_rgba(0,0,0,0.65)] hover:bg-white"
                    style={{ fontFamily: MONO_FONT }}
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
          className="h-11 rounded-none border-2 border-[#f0b90b]/45 bg-black/55 text-sm text-white placeholder:text-white/40 focus:border-[#ffe600]"
          style={{ fontFamily: MONO_FONT }}
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
          className="h-11 rounded-none border-2 border-[#f0b90b]/45 bg-black/55 text-sm text-white placeholder:text-white/40 focus:border-[#ffe600]"
          style={{ fontFamily: MONO_FONT }}
        />
        <p
          style={{ fontFamily: MONO_FONT }}
          className="text-3xs leading-relaxed text-white/52"
        >
          {t("runtimegate.remoteTokenHelp", {
            defaultValue:
              "Leave blank unless you already have a permanent access token. Without one, you'll pair with a one-time code on the next screen.",
          })}
        </p>

        {error && (
          <p
            className="text-3xs uppercase tracking-wide text-red-400"
            style={{ fontFamily: MONO_FONT }}
          >
            {error}
          </p>
        )}

        <Button
          type="button"
          variant="default"
          className="min-h-12 justify-center border-2 border-black bg-[#ffe600] px-6 py-4 text-sm font-black uppercase tracking-[0.16em] text-black shadow-[5px_5px_0_rgba(0,0,0,0.72)] transition-transform duration-150 hover:-translate-y-0.5 hover:bg-white active:translate-y-0 disabled:opacity-50 disabled:cursor-not-allowed"
          style={{
            borderRadius: 0,
            clipPath:
              "polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px)",
            fontFamily: MONO_FONT,
          }}
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
    <div
      data-testid="onboarding-ui-overlay"
      className={`relative h-full max-h-[100dvh] min-h-0 w-full overflow-hidden text-white overscroll-none ${
        lightMode ? "bg-[#1a1108]" : "bg-[#0a0805]"
      }`}
      style={{ height: "100dvh" }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 overflow-hidden"
      >
        {/* Splash background. Dark-mode is letterboxed against the wrapper
            bg below, which provides a complementary brand tone. */}
        <img
          src={resolveAppAssetUrl("splash-bg.png")}
          alt=""
          className="absolute inset-0 h-full w-full object-contain object-center"
        />
        {/* Subtle vignette to keep panel content readable when window is large
            and the image sits centered with letterbox. */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_30%,rgba(0,0,0,0.55)_100%)]" />
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

      <div className="relative z-10 flex h-full min-h-0 items-center justify-center px-3 pb-[calc(max(0.75rem,var(--safe-area-bottom,0px))_+_var(--keyboard-height,0px))] pt-[calc(var(--safe-area-top,0px)_+_3.75rem)] sm:px-6 md:px-8">
        <div
          className="flex max-h-full min-h-0 w-full max-w-[64rem] flex-col items-center gap-3 overflow-y-auto border-2 border-black px-3 py-4 shadow-[9px_9px_0_rgba(0,0,0,0.62)] backdrop-blur-md sm:gap-4 sm:px-6 sm:py-5 md:px-8 md:py-6"
          style={{
            borderRadius: 0,
            clipPath:
              "polygon(16px 0,100% 0,100% calc(100% - 16px),calc(100% - 16px) 100%,0 100%,0 16px)",
            // Dark zine panel for both modes — white text reads consistently
            // against either the gold-on-black or gold-on-cream collage. The
            // dark theme image is busy (lots of gold accents) so the panel is
            // slightly more opaque to keep content focus.
            background: lightMode
              ? "rgba(20,16,10,0.78)"
              : "rgba(9,10,14,0.84)",
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

interface SubviewHeaderProps {
  title: string;
  subtitle?: string;
}

/**
 * Cleaner header for the cloud + remote subviews. Replaces the legacy
 * `GateHeader` ("Choose your setup / Where should your agent run?") which
 * was misleading once the user was already past the chooser.
 */
function SubviewHeader({ title, subtitle }: SubviewHeaderProps) {
  return (
    <div className="flex w-full max-w-xl flex-col items-center gap-2 text-center">
      <h1
        style={{
          fontFamily: MONO_FONT,
          textShadow: "2px 2px 0 rgba(0,0,0,0.85)",
        }}
        className="text-2xl font-light uppercase tracking-tight text-white sm:text-3xl"
      >
        {title}
      </h1>
      {subtitle && (
        <p
          className="max-w-md text-sm leading-relaxed text-white/80"
          style={{
            fontFamily: MONO_FONT,
            textShadow: "1px 1px 0 rgba(0,0,0,0.7)",
          }}
        >
          {subtitle}
        </p>
      )}
    </div>
  );
}

interface WelcomeChooserProps {
  onGetStarted: () => void;
  getStartedLabel: string;
  showAdvanced: boolean;
  advancedShowsLocal: boolean;
  advancedShowsRemote: boolean;
  onUseLocal: () => void;
  onConnectRemote: () => void;
  t: (key: string, values?: Record<string, unknown>) => string;
}

/**
 * One primary action ("Get started") for the 90% case, with power-user
 * options (local agent / connect remote) progressively disclosed under a
 * collapsed "I want to run it myself" link. Replaces the prior 3-equal-tiles
 * + select-then-confirm layout, which forced every fresh user to make a
 * mechanics-level choice before they knew what the product was.
 */
function WelcomeChooser({
  onGetStarted,
  getStartedLabel,
  showAdvanced,
  advancedShowsLocal,
  advancedShowsRemote,
  onUseLocal,
  onConnectRemote,
  t,
}: WelcomeChooserProps) {
  const [advancedOpen, setAdvancedOpen] = React.useState(false);

  return (
    <div className="flex w-full flex-col items-center gap-4 text-center sm:gap-5">
      <div className="flex w-full max-w-xl flex-col items-center gap-2">
        <p
          style={{ fontFamily: MONO_FONT }}
          className="text-3xs tracking-[0.22em] text-[#ffe600]/80"
        >
          {t("runtimegate.welcomeEyebrow", {
            defaultValue: "elizaOS — immersion agent runtime",
          })}
        </p>
        <h1
          style={{
            fontFamily: MONO_FONT,
            textShadow: "2px 2px 0 rgba(0,0,0,0.85)",
          }}
          className="text-2xl font-light uppercase tracking-tight text-white sm:text-3xl md:text-4xl"
        >
          {t("runtimegate.welcomeTitle", { defaultValue: "Welcome to Eliza" })}
        </h1>
        <p
          className="max-w-md text-sm leading-relaxed text-white/85"
          style={{
            fontFamily: MONO_FONT,
            textShadow: "1px 1px 0 rgba(0,0,0,0.75)",
          }}
        >
          {t("runtimegate.welcomeSubtitle", {
            defaultValue:
              "Your personal AI, hosted on Eliza Cloud — ready in seconds.",
          })}
        </p>
      </div>

      <Button
        type="button"
        variant="default"
        className="min-h-14 w-full max-w-sm border-2 border-black bg-[#ffe600] px-10 py-4 text-base font-black uppercase tracking-[0.18em] text-black shadow-[6px_6px_0_rgba(0,0,0,0.72)] transition-transform duration-150 hover:-translate-y-0.5 hover:bg-white active:translate-y-0"
        style={{
          borderRadius: 0,
          clipPath:
            "polygon(12px 0,100% 0,100% calc(100% - 12px),calc(100% - 12px) 100%,0 100%,0 12px)",
          fontFamily: MONO_FONT,
        }}
        onClick={onGetStarted}
      >
        {getStartedLabel}
      </Button>

      {showAdvanced && (
        <div className="flex w-full max-w-2xl flex-col items-center gap-3">
          <button
            type="button"
            onClick={() => setAdvancedOpen((open) => !open)}
            aria-expanded={advancedOpen}
            className="inline-flex items-center gap-1.5 text-3xs uppercase tracking-[0.2em] text-[#ffe600]/75 transition-colors hover:text-[#ffe600]"
            style={{ fontFamily: MONO_FONT }}
          >
            {t("runtimegate.welcomeAdvancedToggle", {
              defaultValue: "I want to run it myself",
            })}
            <span aria-hidden="true">{advancedOpen ? "▴" : "▾"}</span>
          </button>

          {advancedOpen && (
            <div
              className={`grid w-full gap-3 text-left ${
                advancedShowsLocal && advancedShowsRemote
                  ? "sm:grid-cols-2"
                  : ""
              }`}
            >
              {advancedShowsLocal && (
                <PowerUserCard
                  eyebrow={t("runtimegate.welcomeLocalEyebrow", {
                    defaultValue: "Power user",
                  })}
                  title={t("runtimegate.welcomeLocalTitle", {
                    defaultValue: "Run on this machine",
                  })}
                  description={t("runtimegate.welcomeLocalDesc", {
                    defaultValue:
                      "Bring your own AI provider key. The agent runs on your hardware. Privacy-first.",
                  })}
                  ctaLabel={t("runtimegate.welcomeLocalCta", {
                    defaultValue: "Use local",
                  })}
                  onClick={onUseLocal}
                />
              )}
              {advancedShowsRemote && (
                <PowerUserCard
                  eyebrow={t("runtimegate.welcomeRemoteEyebrow", {
                    defaultValue: "Already running an agent?",
                  })}
                  title={t("runtimegate.welcomeRemoteTitle", {
                    defaultValue: "Connect to your own server",
                  })}
                  description={t("runtimegate.welcomeRemoteDesc", {
                    defaultValue:
                      "Point at an agent URL you already have running.",
                  })}
                  ctaLabel={t("runtimegate.welcomeRemoteCta", {
                    defaultValue: "Connect remote",
                  })}
                  onClick={onConnectRemote}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface PowerUserCardProps {
  eyebrow: string;
  title: string;
  description: string;
  ctaLabel: string;
  onClick: () => void;
}

function PowerUserCard({
  eyebrow,
  title,
  description,
  ctaLabel,
  onClick,
}: PowerUserCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full flex-col items-start gap-2 border-2 border-[#f0b90b]/45 bg-black/65 p-4 text-left shadow-[5px_5px_0_rgba(0,0,0,0.72)] transition-[border-color,background-color,transform] duration-150 hover:-translate-y-0.5 hover:border-[#ffe600] hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ffe600] focus-visible:ring-offset-2 focus-visible:ring-offset-black"
      style={{
        borderRadius: 0,
        clipPath:
          "polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px)",
      }}
    >
      <span
        className="text-3xs uppercase tracking-[0.2em] text-[#ffe600]/85"
        style={{ fontFamily: MONO_FONT }}
      >
        {eyebrow}
      </span>
      <span
        className="text-base font-bold uppercase tracking-wide text-white/95"
        style={{ fontFamily: MONO_FONT }}
      >
        {title}
      </span>
      <span
        className="text-xs leading-relaxed text-white/70"
        style={{ fontFamily: MONO_FONT }}
      >
        {description}
      </span>
      <span
        className="mt-2 inline-flex items-center gap-1 text-3xs uppercase tracking-[0.22em] text-[#ffe600] group-hover:text-white"
        style={{ fontFamily: MONO_FONT }}
      >
        {ctaLabel} →
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
      className="mt-2 inline-flex items-center gap-1 self-center text-sm text-white/70 transition-colors hover:text-[#ffe600] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-white/70"
    >
      <ChevronLeft className="h-4 w-4" aria-hidden />
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
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
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
        <p className="text-2xs leading-snug text-white/50">
          Generate semantic search locally on this device. Slower first run;
          private.
        </p>
      </div>
    </div>
  );
}
