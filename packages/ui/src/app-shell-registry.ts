import type { ComponentType } from "react";

export type AppShellPageLoader = () => Promise<{
  default: ComponentType<Record<string, unknown>>;
  cleanup?: () => void | Promise<void>;
}>;

/**
 * A page contributed at runtime by a plugin or host app. Mirrors the fields
 * on `PluginAppNavTab` from `@elizaos/core`, plus either a resolved React
 * component or a lazy loader the shell mounts on demand.
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
  /**
   * When true, the shell mounts this page edge-to-edge with no host
   * top-bar/chrome — for views that own their full window, e.g. the
   * orchestrator workbench.
   */
  fullBleed?: boolean;
  /**
   * The React component the shell mounts when this page is active.
   * Prefer `loader` for heavy pages so boot only pays metadata cost.
   */
  Component?: ComponentType<unknown>;
  /** Lazy page loader. The shell wraps it in React.lazy + Suspense. */
  loader?: AppShellPageLoader;
}

interface AppShellPageRegistryStore {
  entries: Map<string, AppShellPageRegistration>;
  listeners: Set<() => void>;
  version: number;
}

function appShellPageRegistryKey(): symbol {
  return Symbol.for("elizaos.app-core.app-shell-page-registry");
}

function getRegistryStore(): AppShellPageRegistryStore {
  const globalObject = globalThis as Record<PropertyKey, unknown>;
  const registryKey = appShellPageRegistryKey();
  const existing = globalObject[registryKey] as
    | AppShellPageRegistryStore
    | null
    | undefined;
  if (existing) return existing;
  const created: AppShellPageRegistryStore = {
    entries: new Map<string, AppShellPageRegistration>(),
    listeners: new Set(),
    version: 0,
  };
  globalObject[registryKey] = created;
  return created;
}

export function registerAppShellPage(
  registration: AppShellPageRegistration,
): void {
  const store = getRegistryStore();
  store.entries.set(registration.id, registration);
  store.version += 1;
  for (const listener of store.listeners) listener();
}

export function listAppShellPages(): AppShellPageRegistration[] {
  return [...getRegistryStore().entries.values()];
}

export function subscribeAppShellPages(listener: () => void): () => void {
  const store = getRegistryStore();
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

export function getAppShellPageRegistrySnapshot(): number {
  return getRegistryStore().version;
}
