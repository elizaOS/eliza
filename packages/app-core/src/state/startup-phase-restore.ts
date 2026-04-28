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
import { detectExistingOnboardingConnection } from "./onboarding-bootstrap";
import {
  loadPersistedActiveServer,
  loadPersistedOnboardingComplete,
  type PersistedActiveServer,
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

export async function applyRestoredConnection(args: {
  restoredActiveServer: PersistedActiveServer;
  clientRef: Pick<typeof client, "setBaseUrl" | "setToken">;
  startLocalRuntime?: () => Promise<void>;
}) {
  const { restoredActiveServer, clientRef, startLocalRuntime } = args;

  if (restoredActiveServer.kind === "local") {
    clientRef.setToken(null);
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
  const persistedActiveServer = loadPersistedActiveServer();
  const hadPrior = loadPersistedOnboardingComplete();
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

  const restoredActiveServer =
    persistedActiveServer ?? (probed ? probed.activeServer : null);
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
