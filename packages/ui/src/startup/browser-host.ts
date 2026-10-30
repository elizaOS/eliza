/** Common browser startup wiring. Native lifecycle and runtime commands remain explicit host ports. */

import { getElizaApiBase, getElizaApiToken } from "@elizaos/host/protocol";
import {
  clearStoredStewardToken,
  hasStewardAuthedCookie,
  readStoredStewardToken,
  writeStoredStewardToken,
} from "@elizaos/plugin-elizacloud/steward-session-client";
import { supportsFullAppShellRoutes } from "../api/app-shell-capabilities.js";
import { client } from "../api/client.js";
import {
  cloudTokenSecsRemaining,
  getCloudAuthToken,
  isDirectCloudSharedAgentBase,
  refreshCloudStewardSession,
} from "../api/client-cloud.js";
import { fetchWithCsrf } from "../api/csrf-client.js";
import { isPasswordAuthTransportConfidential } from "../api/password-auth-transport-policy.js";
import { invokeDesktopBridgeRequestWithTimeout } from "../bridge/electrobun-rpc.js";
import { isElectrobunRuntime } from "../bridge/electrobun-runtime.js";
import { resumePendingCloudHandoff } from "../cloud/handoff/resume-pending-handoff.js";
import { dispatchCompletedActionNavigation } from "../completed-action-navigation.js";
import { prefetchAppsCatalog } from "../components/apps/load-apps-catalog.js";
import { getBootConfig } from "../config/boot-config-store.js";
import {
  dispatchAppEmoteEvent,
  dispatchVoiceControl,
} from "../events/index.js";
import { emitViewEvent } from "../events/view-events.js";
import { enforceDeviceRamPolicyOnPersistedRuntimeModeAtBoot } from "../first-run/device-ram-gate.js";
import {
  isCommittedOnDeviceMobileRuntimeMode,
  persistMobileRuntimeMode,
  readPersistedMobileRuntimeMode,
} from "../first-run/mobile-runtime-mode.js";
import {
  readMobileRuntimeBuildTruth,
  reconcilePersistedMobileRuntimeModeAtBoot,
} from "../first-run/reconcile-mobile-runtime-mode.js";
import { primeAuthStatusProbe } from "../hooks/useAuthStatus.js";
import {
  getWindowNavigationPath,
  resolveDefaultLandingTab,
  shouldUseHashNavigation,
} from "../navigation/index.js";
import {
  clearForceFreshFirstRun,
  isForceFreshFirstRunEnabled,
  wasForceFreshResetApplied,
} from "../platform/first-run-reset.js";
import { isAndroid, isElizaOS, isIOS, isNative } from "../platform/init.js";
import { isCapacitorNativeRuntime as isCapacitorNative } from "../platform/native-probe.js";
import { isOnboardingReplayRequested } from "../platform/onboarding-replay.js";
import { isViteDevUiShell } from "../platform/vite-dev-ui-shell.js";
import { dispatchConversationResync } from "../state/AppContext.hooks.js";
import {
  loadAgentProfileRegistry,
  resolveAgentProfileByQuery,
} from "../state/agent-profiles.js";
import { detectExistingFirstRunConnection } from "../state/first-run-bootstrap.js";
import {
  clearPersistedActiveServer,
  hydratePersistedFirstRunCompleteFromNativeStore,
  loadAvatarIndex,
  loadPersistedActiveServer,
  loadPersistedFirstRunComplete,
  savePersistedActiveServer,
  savePersistedFirstRunComplete,
} from "../state/persistence.js";
import {
  isTrustedCloudApiBaseUrl,
  isTrustedRestoreApiBaseUrl,
} from "../state/runtime-url-trust.js";
import { clearSharedCloudAccountBinding } from "../state/shared-cloud-account-binding.js";
import { markStartup } from "../state/startup-telemetry.js";
import { switchRuntimeNonDestructive } from "../state/switch-runtime.js";
import { normalizeAvatarIndex } from "../state/vrm.js";
import { resolveCloudEnvironmentBase } from "../utils/cloud-agent-base.js";
import { recoverMissedCurrentView } from "../view-action-handoff.js";
import { loadViewInteractRegistry } from "../view-loaders.js";
import type { StartupHostPorts } from "./startup-host-ports.js";

export interface BrowserStartupHostOptions {
  native: Pick<
    StartupHostPorts["transport"],
    | "getAndroidLocalAgentBootStateForUrl"
    | "requestAndroidLocalAgentStartForUrl"
    | "prepareNativeRuntimeForUrl"
    | "appendIosBootTrace"
    | "isIosInProcessLocalAgentBase"
    | "isIosNativeAgentBootInProgress"
    | "isTerminalIosNativeAgentBootErrorMessage"
  >;
  executeRuntimeManagementCommand: StartupHostPorts["services"]["executeRuntimeManagementCommand"];
  platform?: Partial<StartupHostPorts["platform"]>;
  configuration?: Partial<StartupHostPorts["configuration"]>;
}

export function createBrowserStartupHost(
  options: BrowserStartupHostOptions,
): StartupHostPorts {
  return {
    platform: {
      isElectrobunRuntime,
      isAndroid,
      isIOS,
      isNative,
      isCapacitorNative,
      isElizaOS,
      ...options.platform,
    },
    transport: {
      client,
      invokeDesktopBridgeRequestWithTimeout,
      primeAuthStatusProbe,
      fetchWithCsrf,
      ...options.native,
    },
    configuration: {
      supportsFullAppShellRoutes,
      isDirectCloudSharedAgentBase,
      cloudTokenSecsRemaining,
      getElizaApiBase,
      getElizaApiToken,
      clearStoredStewardToken,
      hasStewardAuthedCookie,
      readStoredStewardToken,
      writeStoredStewardToken,
      isCommittedOnDeviceMobileRuntimeMode,
      readPersistedMobileRuntimeMode,
      resolveCloudEnvironmentBase,
      clearForceFreshFirstRun,
      isForceFreshFirstRunEnabled,
      wasForceFreshResetApplied,
      clearPersistedActiveServer,
      hydratePersistedFirstRunCompleteFromNativeStore,
      loadPersistedActiveServer,
      loadPersistedFirstRunComplete,
      savePersistedActiveServer,
      savePersistedFirstRunComplete,
      clearSharedCloudAccountBinding,
      refreshCloudStewardSession,
      detectExistingFirstRunConnection,
      getBootConfig,
      isTrustedCloudApiBaseUrl,
      isTrustedRestoreApiBaseUrl,
      isOnboardingReplayRequested,
      persistMobileRuntimeMode,
      getCloudAuthToken,
      isPasswordAuthTransportConfidential,
      isViteDevUiShell,
      readMobileRuntimeBuildTruth,
      resumePendingCloudHandoff,
      getWindowNavigationPath,
      shouldUseHashNavigation,
      enforceDeviceRamPolicyOnPersistedRuntimeModeAtBoot,
      reconcilePersistedMobileRuntimeModeAtBoot,
      ...options.configuration,
    },
    services: {
      normalizeAvatarIndex,
      loadViewInteractRegistry,
      dispatchAppEmoteEvent,
      dispatchVoiceControl,
      dispatchCompletedActionNavigation,
      dispatchConversationResync,
      emitViewEvent,
      resolveDefaultLandingTab,
      loadAgentProfileRegistry,
      resolveAgentProfileByQuery,
      loadAvatarIndex,
      prefetchAppsCatalog,
      recoverMissedCurrentView,
      switchRuntimeNonDestructive,
      markStartup,
      executeRuntimeManagementCommand: options.executeRuntimeManagementCommand,
    },
  };
}
