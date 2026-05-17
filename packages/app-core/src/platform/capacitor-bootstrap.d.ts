import { type WindowShellRoute } from "@elizaos/ui";
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
export declare function installAppBootstrapClientPatches(args: InitializeAppBootstrapClientsArgs): void;
/**
 * Async portion of the shell bootstrap. Hydrates the storage bridge from
 * Capacitor Preferences (so localStorage reads are authoritative before
 * React mounts), then installs the Capacitor event bridge.
 */
export declare function initializeAppBootstrapBridges(): Promise<void>;
//# sourceMappingURL=capacitor-bootstrap.d.ts.map