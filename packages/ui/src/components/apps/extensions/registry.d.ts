import type { RegistryAppInfo } from "../../../api";
import type { AppDetailExtensionComponent } from "./types";
/**
 * Register a detail-panel extension component for a given panel id.
 * Call this once per app at module load time (e.g. from the app's UI entry).
 *
 * @example
 *   registerDetailExtension("babylon-operator-dashboard", BabylonDetailExtension);
 */
export declare function registerDetailExtension(
  detailPanelId: string,
  component: AppDetailExtensionComponent,
): void;
export declare function getAppDetailExtension(
  app: RegistryAppInfo,
): AppDetailExtensionComponent | null;
//# sourceMappingURL=registry.d.ts.map
