/**
 * Process-scoped registry mapping an app's `uiExtension.detailPanelId` to the
 * React component that renders its custom detail panel. Apps self-register on
 * startup via side-effect import; the app-details UI looks up components here.
 */
import type { RegistryAppInfo } from "../contracts/apps.js";
import type { AppDetailExtensionComponent } from "./detail-extension-types.js";

/**
 * Registry of app detail extension components keyed by the app's
 * `uiExtension.detailPanelId` string.
 *
 * Apps register their detail extension on startup via side-effect import.
 */
const DETAIL_EXTENSION_COMPONENTS = new Map<
  string,
  AppDetailExtensionComponent
>();

/**
 * Register a detail-panel extension component for a given panel id.
 * Call this once per app at module load time (e.g. from the app's UI entry).
 *
 * @example
 *   registerDetailExtension("example-detail-panel", ExampleDetailExtension);
 */
export function registerDetailExtension(
  detailPanelId: string,
  component: AppDetailExtensionComponent,
): void {
  if (
    typeof detailPanelId !== "string" ||
    !detailPanelId.trim() ||
    !component
  ) {
    return;
  }
  DETAIL_EXTENSION_COMPONENTS.set(detailPanelId, component);
}

/** Unregister a detail-panel extension component by panel id. */
export function unregisterDetailExtension(detailPanelId: string): boolean {
  if (typeof detailPanelId !== "string") return false;
  return DETAIL_EXTENSION_COMPONENTS.delete(detailPanelId);
}

/** Clear all registered detail extension components. */
export function clearDetailExtensionRegistry(): void {
  DETAIL_EXTENSION_COMPONENTS.clear();
}

/** Directly retrieve a registered detail extension component by panel id. */
export function getDetailExtension(
  detailPanelId: string,
): AppDetailExtensionComponent | null {
  if (typeof detailPanelId !== "string") return null;
  return DETAIL_EXTENSION_COMPONENTS.get(detailPanelId) ?? null;
}

export function getAppDetailExtension(
  app: RegistryAppInfo | null | undefined,
): AppDetailExtensionComponent | null {
  if (!app || typeof app !== "object") return null;
  const detailPanelId = app.uiExtension?.detailPanelId;
  if (!detailPanelId) return null;
  return getDetailExtension(detailPanelId);
}
