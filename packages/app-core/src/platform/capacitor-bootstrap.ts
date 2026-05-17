// === Phase 5D: extracted from packages/app/src/main.tsx ===
// Single orchestration entrypoint for the white-label app shell's pre-React
// platform setup: applies onboarding/permission/cloud-preference client
// patches, hydrates the storage bridge, installs the Capacitor event bridge,
// and pre-seeds the Android local runtime preference when the device boots
// into the elizaOS branded surface for the first time.
import {
  applyForceFreshOnboardingReset,
  client,
  initializeCapacitorBridge,
  initializeStorageBridge,
  installDesktopPermissionsClientPatch,
  installForceFreshOnboardingClientPatch,
  installLocalProviderCloudPreferencePatch,
  isElizaOS,
  preSeedAndroidLocalRuntimeIfFresh,
  shouldInstallMainWindowOnboardingPatches,
  type WindowShellRoute,
} from "@elizaos/ui";

export interface InitializeAppBootstrapClientsArgs {
  /**
   * Resolved window shell route (main, detached, popout, etc.). The
   * onboarding-reset patch only runs on the main window.
   */
  windowShellRoute: WindowShellRoute;
  /**
   * When true, the runtime should treat the host as a desktop electrobun
   * shell — needed by the desktop-permissions client patch to short-circuit
   * permission flows the native host handles.
   */
  isDesktopPlatform: boolean;
  /**
   * Allows the caller to skip the Android local runtime pre-seed when the
   * user has explicitly requested the runtime picker via `?runtime=picker`.
   */
  skipAndroidLocalRuntimeSeed?: boolean;
}

/**
 * Synchronous portion of the shell bootstrap. Applies all client-side
 * patches and the Android local-runtime pre-seed. The storage and Capacitor
 * bridges live behind `initializeAppBootstrapBridges` because they require
 * async preferences hydration.
 */
export function installAppBootstrapClientPatches(
  args: InitializeAppBootstrapClientsArgs,
): void {
  if (shouldInstallMainWindowOnboardingPatches(args.windowShellRoute)) {
    applyForceFreshOnboardingReset();
    installForceFreshOnboardingClientPatch(client);
  }
  installLocalProviderCloudPreferencePatch(client);
  installDesktopPermissionsClientPatch(client);

  if (isElizaOS() && !args.skipAndroidLocalRuntimeSeed) {
    preSeedAndroidLocalRuntimeIfFresh();
  }
}

/**
 * Async portion of the shell bootstrap. Hydrates the storage bridge from
 * Capacitor Preferences (so localStorage reads are authoritative before
 * React mounts), then installs the Capacitor event bridge.
 */
export async function initializeAppBootstrapBridges(): Promise<void> {
  await initializeStorageBridge();
  initializeCapacitorBridge();
}
