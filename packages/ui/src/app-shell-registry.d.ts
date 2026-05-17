import type { ComponentType } from "react";
/**
 * A page contributed at runtime by a plugin or host app. Mirrors the fields
 * on `PluginAppNavTab` from `@elizaos/core`, plus the resolved React
 * component the shell will mount.
 */
export interface AppShellPageRegistration {
  /** Stable id, scoped to the owning plugin (e.g. `"wallet.inventory"`). */
  id: string;
  /** Owning plugin id. */
  pluginId: string;
  /** Display label in the tab bar / nav. */
  label: string;
  /** Lucide icon name. */
  icon?: string;
  /** Route path the tab links to. */
  path: string;
  /** Sort priority within the nav (lower = first). Default 100. */
  order?: number;
  /** When true, only visible when Developer Mode is enabled in Settings. */
  developerOnly?: boolean;
  /** Optional named group the tab belongs to. */
  group?: string;
  /** The React component the shell mounts when this page is active. */
  Component: ComponentType<unknown>;
}
export declare function registerAppShellPage(
  registration: AppShellPageRegistration,
): void;
export declare function listAppShellPages(): AppShellPageRegistration[];
//# sourceMappingURL=app-shell-registry.d.ts.map
