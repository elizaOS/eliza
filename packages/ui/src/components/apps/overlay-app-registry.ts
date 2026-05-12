/**
 * Overlay App Registry — simple registry for full-screen overlay apps.
 *
 * Apps register here at module scope. The host shell and apps catalog
 * query the registry to discover and launch overlay apps.
 */

import type { RegistryAppInfo } from "../../api";
import { userAgentHasElizaOSMarker } from "../../platform/aosp-user-agent";
import type { OverlayApp } from "./overlay-app-api";

const OVERLAY_APP_REGISTRY_KEY = "__elizaosOverlayAppRegistry__";

type OverlayAppRegistryGlobal = typeof globalThis & {
  [OVERLAY_APP_REGISTRY_KEY]?: Map<string, OverlayApp>;
};

const overlayRegistryGlobal = globalThis as OverlayAppRegistryGlobal;

function getOverlayRegistry(): Map<string, OverlayApp> {
  const existing = overlayRegistryGlobal[OVERLAY_APP_REGISTRY_KEY];
  if (existing) {
    return existing;
  }
  const next = new Map<string, OverlayApp>();
  overlayRegistryGlobal[OVERLAY_APP_REGISTRY_KEY] = next;
  return next;
}

const registry = getOverlayRegistry();

/** Register an overlay app. Call at module scope. */
export function registerOverlayApp(app: OverlayApp): void {
  registry.set(app.name, app);
}

/** Look up a registered overlay app by name. */
export function getOverlayApp(name: string): OverlayApp | undefined {
  return registry.get(name);
}

/** Get all registered overlay apps. */
export function getAllOverlayApps(): OverlayApp[] {
  return Array.from(registry.values());
}

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

export function getAvailableOverlayApps(
  context:
    | string
    | OverlayAppAvailabilityContext = detectOverlayAvailabilityContext(),
): OverlayApp[] {
  const availability =
    typeof context === "string"
      ? { platform: context, aospAndroid: false }
      : normalizeOverlayAvailabilityContext(context);
  const canShowAndroidOnly =
    availability.platform === "android" && availability.aospAndroid === true;
  return getAllOverlayApps().filter(
    (app) => canShowAndroidOnly || app.androidOnly !== true,
  );
}

function normalizeOverlayAvailabilityContext(
  context: OverlayAppAvailabilityContext,
): Required<OverlayAppAvailabilityContext> {
  const userAgent =
    context.userAgent ??
    (typeof navigator !== "undefined" ? navigator.userAgent : "");
  const platform = context.platform ?? detectPlatformForCatalog(userAgent);
  return {
    platform,
    aospAndroid:
      context.aospAndroid ??
      (platform === "android" && userAgentHasElizaOSMarker(userAgent)),
    userAgent,
  };
}

function detectOverlayAvailabilityContext(): Required<OverlayAppAvailabilityContext> {
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const platform = detectPlatformForCatalog(userAgent);
  return {
    platform,
    aospAndroid: platform === "android" && userAgentHasElizaOSMarker(userAgent),
    userAgent,
  };
}

function detectPlatformForCatalog(userAgent: string): string {
  type CapacitorGlobal = {
    Capacitor?: { getPlatform?: () => string };
  };
  const cap = (globalThis as CapacitorGlobal).Capacitor;
  const fromCap = cap?.getPlatform?.();
  if (fromCap) return fromCap;
  if (/Android/i.test(userAgent)) {
    return "android";
  }
  return "web";
}

/**
 * True when running on an AOSP Eliza-derived Android build (ElizaOS or any
 * white-label fork). Tests may pass an explicit context. Shared with
 * `catalog-loader.ts` so it can apply the same gate to installed/static apps,
 * not just overlay apps that happen to be registered already.
 */
export function isAospAndroid(
  context: OverlayAppAvailabilityContext = {},
): boolean {
  const availability = normalizeOverlayAvailabilityContext(context);
  return (
    availability.platform === "android" && availability.aospAndroid === true
  );
}

/** Check if an app name belongs to a registered overlay app. */
export function isOverlayApp(name: string): boolean {
  return registry.has(name);
}

/** Convert an OverlayApp to a RegistryAppInfo for the apps catalog. */
export function overlayAppToRegistryInfo(app: OverlayApp): RegistryAppInfo {
  return {
    name: app.name,
    displayName: app.displayName,
    description: app.description,
    category: app.category,
    launchType: "overlay",
    launchUrl: null,
    icon: app.icon,
    heroImage: app.heroImage ?? null,
    capabilities: [],
    stars: 0,
    repository: "",
    latestVersion: null,
    supports: { v0: false, v1: false, v2: true },
    npm: {
      package: app.name,
      v0Version: null,
      v1Version: null,
      v2Version: null,
    },
  };
}
