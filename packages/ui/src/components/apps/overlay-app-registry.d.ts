/**
 * Overlay App Registry — simple registry for full-screen overlay apps.
 *
 * Apps register here at module scope. The host shell and apps catalog
 * query the registry to discover and launch overlay apps.
 */
import type { RegistryAppInfo } from "../../api";
import type { OverlayApp } from "./overlay-app-api";
/** Register an overlay app. Call at module scope. */
export declare function registerOverlayApp(app: OverlayApp): void;
/** Look up a registered overlay app by name. */
export declare function getOverlayApp(name: string): OverlayApp | undefined;
/** Get all registered overlay apps. */
export declare function getAllOverlayApps(): OverlayApp[];
/**
 * Get overlay apps that are available on the current platform. Filters
 * out `androidOnly: true` apps unless this is an AOSP Eliza-derived Android
 * build (ElizaOS or any white-label fork). Used by the apps
 * catalog UI so stock Android, iOS, desktop, and web users don't see
 * privileged OS-control tiles that launch into permanent error states.
 *
 * AOSP detection: the framework's `MainActivity.applyElizaOSUserAgentSuffix`
 * appends an `ElizaOS/<tag>` token to the WebView UA when `ro.elizaos.product`
 * is set by the product makefile. Every Eliza-derived AOSP image carries this
 * marker; white-label brands layer additional brand-specific
 * markers on top via `app.config.ts > android.userAgentMarkers`. Stock Android
 * APKs leave the UA untouched.
 *
 * Platform detection: when `Capacitor.getPlatform()` is available it is
 * preferred; otherwise the user-agent is inspected. Tests can pass an
 * explicit context.
 */
export interface OverlayAppAvailabilityContext {
  platform?: string;
  /**
   * True when this is an AOSP Eliza-derived Android build (any fork). When
   * unspecified, derived from `userAgent` by checking for the framework
   * `ElizaOS/<tag>` marker.
   */
  aospAndroid?: boolean;
  userAgent?: string;
}
export declare function getAvailableOverlayApps(
  context?: string | OverlayAppAvailabilityContext,
): OverlayApp[];
/**
 * True when running on an AOSP Eliza-derived Android build (ElizaOS or any
 * white-label fork). Tests may pass an explicit context. Shared with
 * `catalog-loader.ts` so it can apply the same gate to installed/static apps,
 * not just overlay apps that happen to be registered already.
 */
export declare function isAospAndroid(
  context?: OverlayAppAvailabilityContext,
): boolean;
/** Check if an app name belongs to a registered overlay app. */
export declare function isOverlayApp(name: string): boolean;
/** Convert an OverlayApp to a RegistryAppInfo for the apps catalog. */
export declare function overlayAppToRegistryInfo(
  app: OverlayApp,
): RegistryAppInfo;
//# sourceMappingURL=overlay-app-registry.d.ts.map
