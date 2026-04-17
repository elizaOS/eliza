import type { RegistryAppInfo } from "../../../api";
import type { AppDetailExtensionComponent } from "./types";

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
 *   registerDetailExtension("babylon-operator-dashboard", BabylonDetailExtension);
 */
export function registerDetailExtension(
  detailPanelId: string,
  component: AppDetailExtensionComponent,
): void {
  DETAIL_EXTENSION_COMPONENTS.set(detailPanelId, component);
}

export function getAppDetailExtension(
  app: RegistryAppInfo,
): AppDetailExtensionComponent | null {
  const detailPanelId = app.uiExtension?.detailPanelId;
  if (!detailPanelId) return null;
  return DETAIL_EXTENSION_COMPONENTS.get(detailPanelId) ?? null;
}
