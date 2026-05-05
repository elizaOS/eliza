/**
 * startup-phase-restore.ts
 *
 * Side-effect logic for the "restoring-session" startup phase.
 * Probes for an existing install/connection and dispatches the result.
 */

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
  readPersistedMobileRuntimeMode,
} from "../onboarding/mobile-runtime-mode";
import { isAndroid } from "../platform";
import { detectExistingOnboardingConnection } from "./onboarding-bootstrap";
import {
  clearPersistedActiveServer,
  loadPersistedActiveServer,
  loadPersistedOnboardingComplete,
  savePersistedActiveServer,
  type PersistedActiveServer,
  savePersistedOnboardingComplete,
} from "./persistence";
import type { StartupEvent } from "./startup-coordinator";

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

function isAndroidLocalAgentApiBase(value: string | undefined): boolean {
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

function isAndroidLocalActiveServer(server: PersistedActiveServer): boolean {
  return (
    server.kind === "local" || isAndroidLocalAgentApiBase(server.apiBase)
  );
}

function androidLoopbackActiveServer(): PersistedActiveServer {
  return {
    id: ANDROID_LOCAL_AGENT_SERVER_ID,
    kind: "remote",
    label: ANDROID_LOCAL_AGENT_LABEL,
    apiBase: ANDROID_LOCAL_AGENT_API_BASE,
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
    clientRef.setBaseUrl(restoredActiveServer.apiBase ?? null);
    clientRef.setToken(restoredActiveServer.accessToken ?? null);
    return;
  }

  clientRef.setBaseUrl(restoredActiveServer.apiBase ?? null);
  clientRef.setToken(restoredActiveServer.accessToken ?? null);
}

function activeServerToTarget(
  kind: PersistedActiveServer["kind"],
): "embedded-local" | "cloud-managed" | "remote-backend" {
  switch (kind) {
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
  if (cancelled.current) return;

  const desktopInstall =
    !persistedActiveServer && isElectrobunRuntime()
      ? await inspectExistingElizaInstall().catch(() => null)
      : null;
  if (cancelled.current) return;

  const isDesktop = forceLocal || isElectrobunRuntime();
  const _hasExistingEvidence = hadPrior || Boolean(desktopInstall?.detected);

  // Probe the API when there is evidence of a prior install, or when no
  // persisted server exists (covers headless/VPS setups where config was
  // set via files without going through UI onboarding).
  const probed = !persistedActiveServer
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

  if (isAndroid && restoredActiveServer) {
    const mobileRuntimeMode = readPersistedMobileRuntimeMode();
    if (
      isAndroidLocalActiveServer(restoredActiveServer) &&
      mobileRuntimeMode !== "local"
    ) {
      clearPersistedActiveServer();
      savePersistedOnboardingComplete(false);
      persistedActiveServer = null;
      restoredActiveServer = null;
      hadPrior = false;
      deps.onboardingCompletionCommittedRef.current = false;
    } else if (restoredActiveServer.kind === "local") {
      restoredActiveServer = androidLoopbackActiveServer();
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
    Boolean(
      hadPrior || desktopInstall?.detected || probed?.detectedExistingInstall,
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
      } catch {}
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
    target: activeServerToTarget(restoredActiveServer.kind),
  });
}
