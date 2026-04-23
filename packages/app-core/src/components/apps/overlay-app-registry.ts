/**
 * Overlay App Registry — simple registry for full-screen overlay apps.
 *
 * Apps register here at module scope. The host shell and apps catalog
 * query the registry to discover and launch overlay apps.
 */

import type { RegistryAppInfo } from "../../api";
import type { OverlayApp } from "./overlay-app-api";

const registry = new Map<string, OverlayApp>();

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
    launchType: "local",
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
