/**
 * startup-phase-restore.ts
 *
 * Side-effect logic for the "restoring-session" startup phase.
 * Probes for an existing install/connection and dispatches the result.
 */

import { logger } from "@elizaos/core";
import { getStylePresets, ONBOARDING_PROVIDER_CATALOG } from "@elizaos/shared";
import { client, type OnboardingOptions } from "../api";
import {
  getBackendStartupTimeoutMs,
  getDesktopRuntimeMode,
  inspectExistingElizaInstall,
  invokeDesktopBridgeRequest,
  isElectrobunRuntime,
  scanProviderCredentials,
} from "../bridge";
import type { UiLanguage } from "../i18n";
import {
  ANDROID_LOCAL_AGENT_API_BASE,
  ANDROID_LOCAL_AGENT_LABEL,
  ANDROID_LOCAL_AGENT_SERVER_ID,
  IOS_LOCAL_AGENT_IPC_BASE,
  MOBILE_LOCAL_AGENT_LABEL,
  MOBILE_LOCAL_AGENT_SERVER_ID,
  readPersistedMobileRuntimeMode,
} from "../onboarding/mobile-runtime-mode";
import { isAndroid, isForceFreshOnboardingEnabled, isIOS } from "../platform";
import { getElizaApiBase } from "../utils/eliza-globals";
import { detectExistingOnboardingConnection } from "./onboarding-bootstrap";
import {
  clearPersistedActiveServer,
  loadPersistedActiveServer,
  loadPersistedOnboardingComplete,
  type PersistedActiveServer,
  savePersistedActiveServer,
  savePersistedOnboardingComplete,
} from "./persistence";
import type { StartupEvent } from "./startup-coordinator";

// Direct elizaCloud API base used to backfill a missing apiBase on a
// persisted cloud active-server. Mirrors DEFAULT_DIRECT_CLOUD_API_BASE_URL
// in api/client-cloud.ts; kept inline because that constant is module-private.
const DIRECT_CLOUD_API_BASE = "https://api.elizacloud.ai";

/**
 * If the restored cloud active-server has no apiBase (a broken state from
 * earlier builds where finishAsCloud silently completed onboarding before
 * the cloud surface attached a web_ui_url), look the agent up against the
 * direct cloud API and persist the resolved URL. Returns the up-to-date
 * active server (with apiBase populated when resolution succeeds) or the
 * input unchanged when backfill isn't possible.
 */
async function backfillCloudApiBase(
  active: PersistedActiveServer,
): Promise<PersistedActiveServer> {
  if (active.kind !== "cloud" || active.apiBase) return active;
  const agentId = active.id?.startsWith("cloud:")
    ? active.id.slice("cloud:".length)
    : null;
  if (!agentId) return active;

  const priorBaseUrl = client.getBaseUrl();
  const priorToken = client.hasToken();
  client.setBaseUrl(DIRECT_CLOUD_API_BASE);
  try {
    if (active.accessToken) client.setToken(active.accessToken);
    const res = await client.getCloudCompatAgent(agentId);
    if (!res.success) return active;
    const data = res.data;
    const apiBase = data.web_ui_url ?? data.webUiUrl ?? data.bridge_url ?? null;
    if (!apiBase) return active;
    const updated: PersistedActiveServer = { ...active, apiBase };
    savePersistedActiveServer(updated);
    return updated;
  } catch {
    return active;
  } finally {
    // Restore prior client state — applyRestoredConnection sets the final
    // baseUrl below based on the (possibly backfilled) active server.
    client.setBaseUrl(priorBaseUrl || null);
    if (!priorToken) client.setToken(null);
  }
}

export interface RestoringSessionDeps {
  setStartupError: (v: null) => void;
  setAuthRequired: (v: boolean) => void;
  setConnected: (v: boolean) => void;
  setOnboardingExistingInstallDetected: (v: boolean) => void;
  setOnboardingOptions: (v: OnboardingOptions) => void;
  setOnboardingComplete: (v: boolean) => void;
  setOnboardingLoading: (v: boolean) => void;
  applyDetectedProviders: (
    detected: Awaited<ReturnType<typeof scanProviderCredentials>>,
  ) => void;
  forceLocalBootstrapRef: React.MutableRefObject<boolean>;
  onboardingCompletionCommittedRef: React.MutableRefObject<boolean>;
  uiLanguage: UiLanguage;
}

export interface RestoringSessionCtx {
  persistedActiveServer: ReturnType<typeof loadPersistedActiveServer>;
  restoredActiveServer: PersistedActiveServer;
  shouldPreserveCompletedOnboarding: boolean;
  hadPriorOnboarding: boolean;
}

function isMobileLocalAgentApiBase(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "http:" &&
      parsed.port === "31337" &&
      (parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "::1")
    );
  } catch {
    return false;
  }
}

function isMobileLocalActiveServer(server: PersistedActiveServer): boolean {
  return server.kind === "local" || isMobileLocalAgentApiBase(server.apiBase);
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

// Re-resolve a persisted loopback apiBase against whatever port the
// dev orchestrator / Electrobun bridge actually bound this run. A
// previous session may have captured a stale port (e.g. 31337) when
// the live API has moved (e.g. 31338). Without this, every restore
// re-applies the dead URL and the renderer 404s on every fetch.
function reconcilePersistedApiBaseWithLive(
  apiBase: string | undefined,
): string | undefined {
  if (!apiBase) return apiBase;
  const live = getElizaApiBase();
  if (!live || live === apiBase) return apiBase;
  try {
    const persisted = new URL(apiBase);
    if (!isLoopbackHostname(persisted.hostname)) return apiBase;
    const liveUrl = new URL(live);
    if (!isLoopbackHostname(liveUrl.hostname)) return apiBase;
    return live;
  } catch {
    return apiBase;
  }
}

function mobileLoopbackActiveServer(): PersistedActiveServer {
  return {
    id: isAndroid
      ? ANDROID_LOCAL_AGENT_SERVER_ID
      : MOBILE_LOCAL_AGENT_SERVER_ID,
    kind: "remote",
    label: isAndroid ? ANDROID_LOCAL_AGENT_LABEL : MOBILE_LOCAL_AGENT_LABEL,
    apiBase: isAndroid
      ? ANDROID_LOCAL_AGENT_API_BASE
      : IOS_LOCAL_AGENT_IPC_BASE,
  };
}

export async function applyRestoredConnection(args: {
  restoredActiveServer: PersistedActiveServer;
  clientRef: Pick<typeof client, "setBaseUrl" | "setToken">;
  startLocalRuntime?: () => Promise<void>;
}) {
  const { restoredActiveServer, clientRef, startLocalRuntime } = args;

  if (restoredActiveServer.kind === "local") {
    // Don't clear an already-set token: "local" means the agent runs
    // on this machine, not that the dashboard is unauthenticated.
    clientRef.setBaseUrl(null);
    if (startLocalRuntime) {
      await startLocalRuntime();
    }
    return;
  }

  if (restoredActiveServer.kind === "cloud") {
    const resolved = await backfillCloudApiBase(restoredActiveServer);
    clientRef.setBaseUrl(resolved.apiBase ?? null);
    clientRef.setToken(resolved.accessToken ?? null);
    return;
  }

  const reconciled = reconcilePersistedApiBaseWithLive(
    restoredActiveServer.apiBase,
  );
  if (reconciled && reconciled !== restoredActiveServer.apiBase) {
    savePersistedActiveServer({
      ...restoredActiveServer,
      apiBase: reconciled,
    });
  }
  clientRef.setBaseUrl(reconciled ?? null);
  clientRef.setToken(restoredActiveServer.accessToken ?? null);
}

function activeServerToTarget(
  server: PersistedActiveServer,
): "embedded-local" | "cloud-managed" | "remote-backend" {
  if (isMobileLocalActiveServer(server)) return "embedded-local";

  switch (server.kind) {
    case "local":
      return "embedded-local";
    case "cloud":
      return "cloud-managed";
    case "remote":
      return "remote-backend";
  }
}

export function canRestoreActiveServer(args: {
  server: PersistedActiveServer;
  clientApiAvailable: boolean;
  forceLocal: boolean;
  isDesktop: boolean;
}): boolean {
  if (args.server.apiBase) {
    return true;
  }

  if (args.server.kind === "local") {
    return args.forceLocal || args.isDesktop || args.clientApiAvailable;
  }

  return false;
}

function preserveCloudAuthTokenForOnboarding(
  server: PersistedActiveServer,
): void {
  if (server.kind !== "cloud") return;
  const token = server.accessToken?.trim();
  if (!token) return;
  client.setToken(token);
  if (typeof globalThis !== "undefined") {
    (globalThis as Record<string, unknown>).__ELIZA_CLOUD_AUTH_TOKEN__ = token;
  }
}

/**
 * Runs the restoring-session phase.
 * Probes the local Eliza install and/or API to detect an existing connection,
 * then dispatches SESSION_RESTORED or NO_SESSION.
 *
 * @param deps - Coordinator dependency bag
 * @param dispatch - startupReducer dispatch
 * @param ctxRef - Mutable ref shared with the polling-backend phase
 * @param cancelled - Ref-flag set true by the cleanup function
 */
export async function runRestoringSession(
  deps: RestoringSessionDeps,
  dispatch: (event: StartupEvent) => void,
  ctxRef: React.MutableRefObject<RestoringSessionCtx | null>,
  cancelled: { current: boolean },
): Promise<void> {
  deps.setStartupError(null);
  deps.setAuthRequired(false);
  deps.setConnected(false);
  deps.setOnboardingExistingInstallDetected(false);

  const forceLocal = deps.forceLocalBootstrapRef.current;
  deps.forceLocalBootstrapRef.current = false;
  let persistedActiveServer = loadPersistedActiveServer();
  let hadPrior = loadPersistedOnboardingComplete();
  const forceFreshOnboarding = isForceFreshOnboardingEnabled();
  if (forceFreshOnboarding) {
    clearPersistedActiveServer();
    savePersistedOnboardingComplete(false);
    persistedActiveServer = null;
    hadPrior = false;
    deps.onboardingCompletionCommittedRef.current = false;
    client.setBaseUrl(null);
    client.setToken(null);
  }
  if (cancelled.current) return;

  const desktopInstall =
    !forceFreshOnboarding && !persistedActiveServer && isElectrobunRuntime()
      ? await inspectExistingElizaInstall().catch(() => null)
      : null;
  if (cancelled.current) return;

  const isDesktop = forceLocal || isElectrobunRuntime();
  const _hasExistingEvidence = hadPrior || Boolean(desktopInstall?.detected);

  // Probe the API when there is evidence of a prior install, or when no
  // persisted server exists (covers headless/VPS setups where config was
  // set via files without going through UI onboarding).
  const probed =
    !forceFreshOnboarding && !persistedActiveServer
      ? await detectExistingOnboardingConnection({
          client,
          timeoutMs: isDesktop
            ? Math.min(getBackendStartupTimeoutMs(), 30_000)
            : Math.min(getBackendStartupTimeoutMs(), 3_500),
        })
      : null;
  if (cancelled.current) return;

  let restoredActiveServer =
    persistedActiveServer ?? (probed ? probed.activeServer : null);

  if ((isAndroid || isIOS) && restoredActiveServer) {
    const mobileRuntimeMode = readPersistedMobileRuntimeMode();
    if (
      isMobileLocalActiveServer(restoredActiveServer) &&
      mobileRuntimeMode !== "local"
    ) {
      clearPersistedActiveServer();
      savePersistedOnboardingComplete(false);
      persistedActiveServer = null;
      restoredActiveServer = null;
      hadPrior = false;
      deps.onboardingCompletionCommittedRef.current = false;
    } else if (restoredActiveServer.kind === "local") {
      restoredActiveServer = mobileLoopbackActiveServer();
      persistedActiveServer = restoredActiveServer;
      savePersistedActiveServer(restoredActiveServer);
    } else if (!restoredActiveServer.apiBase) {
      clearPersistedActiveServer();
      savePersistedOnboardingComplete(false);
      persistedActiveServer = null;
      restoredActiveServer = null;
      hadPrior = false;
      deps.onboardingCompletionCommittedRef.current = false;
    }
  }

  if (
    restoredActiveServer &&
    !canRestoreActiveServer({
      server: restoredActiveServer,
      clientApiAvailable: client.apiAvailable,
      forceLocal,
      isDesktop,
    })
  ) {
    preserveCloudAuthTokenForOnboarding(restoredActiveServer);
    clearPersistedActiveServer();
    savePersistedOnboardingComplete(false);
    persistedActiveServer = null;
    restoredActiveServer = null;
    hadPrior = false;
    deps.onboardingCompletionCommittedRef.current = false;
  }

  const preserveCompleted =
    hadPrior && !deps.onboardingCompletionCommittedRef.current;

  deps.setOnboardingExistingInstallDetected(
    forceFreshOnboarding
      ? false
      : Boolean(
          hadPrior ||
            desktopInstall?.detected ||
            probed?.detectedExistingInstall,
        ),
  );

  if (!restoredActiveServer) {
    // No saved backend found — let the user (re-)onboard.
    deps.setOnboardingOptions({
      names: [],
      styles: getStylePresets(deps.uiLanguage),
      providers: [
        ...ONBOARDING_PROVIDER_CATALOG,
      ] as OnboardingOptions["providers"],
      cloudProviders: [],
      models: {
        nano: [],
        small: [],
        medium: [],
        large: [],
        mega: [],
      } as OnboardingOptions["models"],
      inventoryProviders: [],
      sharedStyleRules: "",
    });
    if (!forceFreshOnboarding) {
      try {
        const det = await scanProviderCredentials();
        if (!cancelled.current && det.length > 0) {
          console.log(
            `[eliza][startup] Keychain scan found ${det.length} provider(s):`,
            det.map((p) => p.id),
          );
          deps.applyDetectedProviders(det);
        }
      } catch (scanErr) {
        console.warn(
          "[eliza][startup] Keychain credential scan failed:",
          scanErr,
        );
      }
    }
    deps.setOnboardingComplete(false);
    deps.setOnboardingLoading(false);
    dispatch({ type: "NO_SESSION", hadPriorOnboarding: hadPrior });
    return;
  }

  await applyRestoredConnection({
    restoredActiveServer,
    clientRef: client,
    startLocalRuntime: async () => {
      try {
        const runtimeMode = await getDesktopRuntimeMode().catch(() => null);
        if (runtimeMode && runtimeMode.mode !== "local") {
          return;
        }
        await invokeDesktopBridgeRequest({
          rpcMethod: "agentStart",
          ipcChannel: "agent:start",
        });
      } catch (err) {
        logger.warn(
          `[startup-phase-restore] desktop agent bridge request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  });

  ctxRef.current = {
    persistedActiveServer,
    restoredActiveServer,
    shouldPreserveCompletedOnboarding: preserveCompleted,
    hadPriorOnboarding: hadPrior,
  };
  dispatch({
    type: "SESSION_RESTORED",
    target: activeServerToTarget(restoredActiveServer),
  });
}
