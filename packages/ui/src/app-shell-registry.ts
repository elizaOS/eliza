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

interface AppShellPageRegistryStore {
  entries: Map<string, AppShellPageRegistration>;
}

const APP_SHELL_PAGE_REGISTRY_KEY = Symbol.for(
  "elizaos.app-core.app-shell-page-registry",
);

function getRegistryStore(): AppShellPageRegistryStore {
  const globalObject = globalThis as Record<PropertyKey, unknown>;
  const existing = globalObject[APP_SHELL_PAGE_REGISTRY_KEY] as
    | AppShellPageRegistryStore
    | null
    | undefined;
  if (existing) return existing;
  const created: AppShellPageRegistryStore = {
    entries: new Map<string, AppShellPageRegistration>(),
  };
  globalObject[APP_SHELL_PAGE_REGISTRY_KEY] = created;
  return created;
}

export function registerAppShellPage(
  registration: AppShellPageRegistration,
): void {
  getRegistryStore().entries.set(registration.id, registration);
}

export function listAppShellPages(): AppShellPageRegistration[] {
  return [...getRegistryStore().entries.values()];
}
