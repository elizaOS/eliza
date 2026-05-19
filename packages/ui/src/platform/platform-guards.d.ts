/**
 * Client-side platform guards for dynamic view loading.
 *
 * iOS App Store and Google Play builds prohibit apps from downloading and
 * executing JavaScript not bundled with the binary at submission time.
 * These utilities detect that restriction so the UI can gate dynamic bundle
 * imports and surface appropriate fallback messaging.
 */
/** Frontend platform identifier matching the server-side AgentPlatform type. */
export type FrontendPlatform = "ios" | "android" | "web" | "desktop";
/**
 * Detect the current frontend platform.
 *
 * Resolution order:
 * 1. `window.__ELECTROBUN__` — set by the Electrobun desktop shell.
 * 2. Capacitor.getPlatform() — set by the Capacitor runtime on iOS/Android.
 * 3. Default: "web".
 */
export declare function getFrontendPlatform(): FrontendPlatform;
/**
 * Returns true when the current platform permits dynamic remote JS loading.
 *
 * iOS App Store and Google Play builds cannot load remote JS at runtime.
 * Desktop (Electrobun) and web contexts have no such restriction.
 */
export declare function isDynamicViewLoadingAllowed(): boolean;
//# sourceMappingURL=platform-guards.d.ts.map