/**
 * startup-phase-restore.ts
 *
 * Side-effect logic for the "restoring-session" startup phase.
 * Probes for an existing install/connection and dispatches the result.
 */

import { logger } from "@elizaos/logger";
import { FIRST_RUN_PROVIDER_CATALOG, getStylePresets } from "@elizaos/shared";
import { client, type FirstRunOptions } from "../api";
import {
  getBackendStartupTimeoutMs,
  invokeDesktopBridgeRequestWithTimeout,
  isElectrobunRuntime,
  scanProviderCredentials,
} from "../bridge";
import {
  ANDROID_LOCAL_AGENT_IPC_BASE,
  ANDROID_LOCAL_AGENT_LABEL,
  ANDROID_LOCAL_AGENT_SERVER_ID,
  IOS_LOCAL_AGENT_IPC_BASE,
  isMobileLocalAgentUrl,
  MOBILE_LOCAL_AGENT_LABEL,
  MOBILE_LOCAL_AGENT_SERVER_ID,
  readPersistedMobileRuntimeMode,
} from "../first-run/mobile-runtime-mode";
import type { UiLanguage } from "../i18n";
import { isAndroid, isForceFreshFirstRunEnabled, isIOS } from "../platform";
import type { ExistingElizaInstallInfo } from "../types";
import { getElizaApiBase } from "../utils/eliza-globals";
import { detectExistingFirstRunConnection } from "./first-run-bootstrap";
import {
  clearPersistedActiveServer,
  loadPersistedActiveServer,
  loadPersistedFirstRunComplete,
  type PersistedActiveServer,
  savePersistedActiveServer,
  savePersistedFirstRunComplete,
} from "./persistence";
import type { StartupEvent } from "./startup-coordinator";

// Direct elizaCloud API base used to backfill a missing apiBase on a
// persisted cloud active-server. Mirrors DEFAULT_DIRECT_CLOUD_API_BASE_URL
// in api/client-cloud.ts; kept inline because that constant is module-private.
const DIRECT_CLOUD_API_BASE = "https://api.elizacloud.ai";
const DESKTOP_RESTORE_RPC_TIMEOUT_MS = 5_000;

/**
 * If the restored cloud active-server has no apiBase (a broken state from
 * earlier builds where finishAsCloud silently completed firstRun before
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
  setFirstRunExistingInstallDetected: (v: boolean) => void;
  setFirstRunOptions: (v: FirstRunOptions) => void;
  setFirstRunComplete: (v: boolean) => void;
  setFirstRunLoading: (v: boolean) => void;
  applyDetectedProviders: (
    detected: Awaited<ReturnType<typeof scanProviderCredentials>>,
  ) => void;
  forceLocalBootstrapRef: React.MutableRefObject<boolean>;
  firstRunCompletionCommittedRef: React.MutableRefObject<boolean>;
  uiLanguage: UiLanguage;
}

export interface RestoringSessionCtx {
  persistedActiveServer: ReturnType<typeof loadPersistedActiveServer>;
  restoredActiveServer: PersistedActiveServer;
  shouldPreserveCompletedFirstRun: boolean;
  hadPriorFirstRun: boolean;
}

function isMobileLocalAgentApiBase(value: string | undefined): boolean {
  return isMobileLocalAgentUrl(value);
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

type MobileNativePlatform = "android" | "ios";

function mobileLocalActiveServer(
  platform: MobileNativePlatform = isAndroid ? "android" : "ios",
): PersistedActiveServer {
  const android = platform === "android";
  return {
    id: android ? ANDROID_LOCAL_AGENT_SERVER_ID : MOBILE_LOCAL_AGENT_SERVER_ID,
    kind: "remote",
    label: android ? ANDROID_LOCAL_AGENT_LABEL : MOBILE_LOCAL_AGENT_LABEL,
    apiBase: android ? ANDROID_LOCAL_AGENT_IPC_BASE : IOS_LOCAL_AGENT_IPC_BASE,
  };
}

export function reconcileMobileRestoredActiveServer(args: {
  server: PersistedActiveServer;
  mobileRuntimeMode: ReturnType<typeof readPersistedMobileRuntimeMode>;
  platform: MobileNativePlatform;
}): PersistedActiveServer | null | undefined {
  const { server, mobileRuntimeMode, platform } = args;
  const mobileLocal = isMobileLocalActiveServer(server);
  if (mobileLocal && mobileRuntimeMode !== "local") {
    return null;
  }

  const expectedMobileIpcBase =
    platform === "android"
      ? ANDROID_LOCAL_AGENT_IPC_BASE
      : IOS_LOCAL_AGENT_IPC_BASE;
  if (
    server.kind === "local" ||
    (mobileLocal && server.apiBase !== expectedMobileIpcBase)
  ) {
    return mobileLocalActiveServer(platform);
  }

  if (!server.apiBase) {
    return null;
  }

  return undefined;
}

function restoredLocalApiBase(): string | null {
  if (isAndroid || isIOS) {
    return null;
  }
  return getElizaApiBase() ?? null;
}

async function inspectExistingElizaInstallForStartup(): Promise<ExistingElizaInstallInfo | null> {
  const result =
    await invokeDesktopBridgeRequestWithTimeout<ExistingElizaInstallInfo>({
      rpcMethod: "agentInspectExistingInstall",
      ipcChannel: "agent:inspectExistingInstall",
      timeoutMs: DESKTOP_RESTORE_RPC_TIMEOUT_MS,
    });
  return result.status === "ok" ? result.value : null;
}

async function getDesktopRuntimeModeForStartup(): Promise<{
  mode?: string;
} | null> {
  const result = await invokeDesktopBridgeRequestWithTimeout<{ mode?: string }>(
    {
      rpcMethod: "desktopGetRuntimeMode",
      ipcChannel: "desktop:getRuntimeMode",
      timeoutMs: DESKTOP_RESTORE_RPC_TIMEOUT_MS,
    },
  );
  return result.status === "ok" ? result.value : null;
}

async function requestDesktopAgentStartForStartup(): Promise<void> {
  await invokeDesktopBridgeRequestWithTimeout({
    rpcMethod: "agentStart",
    ipcChannel: "agent:start",
    timeoutMs: DESKTOP_RESTORE_RPC_TIMEOUT_MS,
  });
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
    clientRef.setBaseUrl(restoredLocalApiBase());
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

function preserveCloudAuthTokenForFirstRun(
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
  deps.setFirstRunExistingInstallDetected(false);

  const forceLocal = deps.forceLocalBootstrapRef.current;
  deps.forceLocalBootstrapRef.current = false;
  let persistedActiveServer = loadPersistedActiveServer();
  let hadPrior = loadPersistedFirstRunComplete();
  const forceFreshFirstRun = isForceFreshFirstRunEnabled();
  if (forceFreshFirstRun) {
    clearPersistedActiveServer();
    savePersistedFirstRunComplete(false);
    persistedActiveServer = null;
    hadPrior = false;
    deps.firstRunCompletionCommittedRef.current = false;
    client.setBaseUrl(null);
    client.setToken(null);
  }
  if (cancelled.current) return;

  const desktopInstall =
    !forceFreshFirstRun && !persistedActiveServer && isElectrobunRuntime()
      ? await inspectExistingElizaInstallForStartup().catch(() => null)
      : null;
  if (cancelled.current) return;

  const isDesktop = forceLocal || isElectrobunRuntime();
  const _hasExistingEvidence = hadPrior || Boolean(desktopInstall?.detected);

  // Probe the API when there is evidence of a prior install, or when no
  // persisted server exists (covers headless/VPS setups where config was
  // set via files without going through UI firstRun).
  const probed =
    !forceFreshFirstRun && !persistedActiveServer
      ? await detectExistingFirstRunConnection({
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
    const reconciledMobileServer = reconcileMobileRestoredActiveServer({
      server: restoredActiveServer,
      mobileRuntimeMode: readPersistedMobileRuntimeMode(),
      platform: isAndroid ? "android" : "ios",
    });
    if (reconciledMobileServer === null) {
      clearPersistedActiveServer();
      savePersistedFirstRunComplete(false);
      persistedActiveServer = null;
      restoredActiveServer = null;
      hadPrior = false;
      deps.firstRunCompletionCommittedRef.current = false;
    } else if (reconciledMobileServer) {
      restoredActiveServer = reconciledMobileServer;
      persistedActiveServer = restoredActiveServer;
      savePersistedActiveServer(restoredActiveServer);
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
    preserveCloudAuthTokenForFirstRun(restoredActiveServer);
    clearPersistedActiveServer();
    savePersistedFirstRunComplete(false);
    persistedActiveServer = null;
    restoredActiveServer = null;
    hadPrior = false;
    deps.firstRunCompletionCommittedRef.current = false;
  }

  const preserveCompleted =
    hadPrior && !deps.firstRunCompletionCommittedRef.current;

  deps.setFirstRunExistingInstallDetected(
    forceFreshFirstRun
      ? false
      : Boolean(
          hadPrior ||
            desktopInstall?.detected ||
            probed?.detectedExistingInstall,
        ),
  );

  if (!restoredActiveServer) {
    // No saved backend found — let the user (re-)onboard.
    deps.setFirstRunOptions({
      names: [],
      styles: getStylePresets(deps.uiLanguage),
      providers: [
        ...FIRST_RUN_PROVIDER_CATALOG,
      ] as FirstRunOptions["providers"],
      cloudProviders: [],
      models: {
        nano: [],
        small: [],
        medium: [],
        large: [],
        mega: [],
      } as FirstRunOptions["models"],
      inventoryProviders: [],
      sharedStyleRules: "",
    });
    if (!forceFreshFirstRun) {
      try {
        const det = await scanProviderCredentials();
        if (!cancelled.current && det.length > 0) {
          deps.applyDetectedProviders(det);
        }
      } catch {
        // keychain scan is best-effort; proceed with fresh firstRun
      }
    }
    deps.setFirstRunComplete(false);
    deps.setFirstRunLoading(false);
    dispatch({ type: "NO_SESSION", hadPriorFirstRun: hadPrior });
    return;
  }

  await applyRestoredConnection({
    restoredActiveServer,
    clientRef: client,
    startLocalRuntime: async () => {
      try {
        const runtimeMode = await getDesktopRuntimeModeForStartup().catch(
          () => null,
        );
        if (runtimeMode && runtimeMode.mode !== "local") {
          return;
        }
        await requestDesktopAgentStartForStartup();
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
    shouldPreserveCompletedFirstRun: preserveCompleted,
    hadPriorFirstRun: hadPrior,
  };
  dispatch({
    type: "SESSION_RESTORED",
    target: activeServerToTarget(restoredActiveServer),
  });
}
