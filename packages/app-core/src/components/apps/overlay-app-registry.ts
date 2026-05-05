/**
 * Overlay App Registry — simple registry for full-screen overlay apps.
 *
 * Apps register here at module scope. The host shell and apps catalog
 * query the registry to discover and launch overlay apps.
 */

import type { RegistryAppInfo } from "../../api";
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
 * out `androidOnly: true` apps unless this is the MiladyOS Android build.
 * Used by the apps catalog UI so stock Android, iOS, desktop, and web users
 * don't see privileged OS-control tiles that launch into permanent error states.
 *
 * Platform detection: when `Capacitor.getPlatform()` is available it is
 * preferred; otherwise the user-agent is inspected. Tests can pass an
 * explicit context.
 */
export interface OverlayAppAvailabilityContext {
  platform?: string;
  miladyOS?: boolean;
  userAgent?: string;
}

export function getAvailableOverlayApps(
  context:
    | string
    | OverlayAppAvailabilityContext = detectOverlayAvailabilityContext(),
): OverlayApp[] {
  const availability =
    typeof context === "string"
      ? { platform: context, miladyOS: false }
      : normalizeOverlayAvailabilityContext(context);
  const canShowAndroidOnly =
    availability.platform === "android" && availability.miladyOS === true;
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
    miladyOS:
      context.miladyOS ??
      (platform === "android" && hasMiladyOSMarker(userAgent)),
    userAgent,
  };
}

function detectOverlayAvailabilityContext(): Required<OverlayAppAvailabilityContext> {
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const platform = detectPlatformForCatalog(userAgent);
  return {
    platform,
    miladyOS: platform === "android" && hasMiladyOSMarker(userAgent),
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

function hasMiladyOSMarker(userAgent: string): boolean {
  return /\bMiladyOS\//.test(userAgent);
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
