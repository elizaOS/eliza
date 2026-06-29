import type { AppShellBackgroundPolicy, ViewKind } from "@elizaos/core";
import type { ComponentType } from "react";
import { registerViewPolicy } from "./state/view-lifecycle";

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
  /**
   * When true, only visible when Developer Mode is enabled in Settings.
   * Equivalent to `viewKind: "developer"`.
   */
  developerOnly?: boolean;
  /**
   * Four-tier visibility category. Supersedes `developerOnly` when set.
   * See {@link ViewKind}.
   */
  viewKind?: ViewKind;
  /** Optional named group the tab belongs to. */
  group?: string;
  /**
   * When true, the shell mounts this page edge-to-edge with no host
   * top-bar/chrome — for views that own their full window, e.g. the
   * orchestrator workbench.
   */
  fullBleed?: boolean;
  /** Screen background policy for this page. Defaults to `"opaque"`. */
  backgroundPolicy?: AppShellBackgroundPolicy;
  /**
   * Retain this page mounted-but-hidden when another view becomes active
   * (#10202). Opt-in; default is unmount-on-hide. Retained pages are bounded by
   * the device-memory keep-alive LRU and paused while hidden.
   */
  keepAlive?: boolean;
  /**
   * Pause this page's timers/polling/media/native subscriptions while hidden or
   * backgrounded (#10202). Defaults to `true`.
   */
  pausable?: boolean;
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
  // Mirror any declared retention policy into the view-lifecycle controller so a
  // plugin page can opt into keep-alive / declare pausability (#10202).
  if (
    registration.keepAlive !== undefined ||
    registration.pausable !== undefined
  ) {
    registerViewPolicy(registration.id, {
      ...(registration.keepAlive !== undefined
        ? { keepAlive: registration.keepAlive }
        : {}),
      ...(registration.pausable !== undefined
        ? { pausable: registration.pausable }
        : {}),
    });
  }
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
