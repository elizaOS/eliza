import type { AppShellBackgroundPolicy, ViewKind } from "@elizaos/core";
import type { ComponentType } from "react";
import { getUiRegistryStore } from "./registry-host";

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
  /**
   * Optional shell tab id this route activates. Defaults to `id`; use this for
   * plugin pages that are mounted under an existing built-in tab.
   */
  tabAffinity?: string;
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

const APP_SHELL_PAGE_REGISTRY_STORE = "app-shell-pages";

function getRegistryStore(): AppShellPageRegistryStore {
  return getUiRegistryStore(APP_SHELL_PAGE_REGISTRY_STORE, () => ({
    entries: new Map<string, AppShellPageRegistration>(),
    listeners: new Set<() => void>(),
    version: 0,
  }));
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

/**
 * A thunk that resolves a host-provided module for view bundles. View bundles
 * are built with `@elizaos/ui`, `react`, etc. left external; at runtime the
 * shell resolves each external specifier to the host's own singleton through
 * this importer so the view shares the host realm.
 */
export type HostExternalImporter = () => Promise<Record<string, unknown>>;

function hostExternalImporterRegistryKey(): symbol {
  return Symbol.for("elizaos.app-core.host-external-importer-registry");
}

function getHostExternalImporterStore(): Map<string, HostExternalImporter> {
  const globalObject = globalThis as Record<PropertyKey, unknown>;
  const registryKey = hostExternalImporterRegistryKey();
  const existing = globalObject[registryKey] as
    | Map<string, HostExternalImporter>
    | undefined;
  if (existing) return existing;
  const created = new Map<string, HostExternalImporter>();
  globalObject[registryKey] = created;
  return created;
}

/**
 * Contribute a host-external importer for a view-bundle specifier the framework
 * trunk map in `DynamicViewLoader` does not own. This is the extension point
 * that keeps plugin-specific specifiers (e.g. `@elizaos/plugin-browser`) out of
 * the shared UI trunk: a plugin app-shell bundle or a build-variant entrypoint
 * registers its own specifiers, and `DynamicViewLoader` consults this registry
 * after its framework map. Backed by a global-symbol store so a single registry
 * is shared even if `@elizaos/ui` is instantiated in more than one chunk.
 */
export function registerHostExternalImporter(
  specifier: string,
  importer: HostExternalImporter,
): void {
  getHostExternalImporterStore().set(specifier, importer);
}

/** Resolve a registered host-external importer, or `undefined` if none. */
export function resolveRegisteredHostExternalImporter(
  specifier: string,
): HostExternalImporter | undefined {
  return getHostExternalImporterStore().get(specifier);
}

/** The specifiers contributed through {@link registerHostExternalImporter}. */
export function registeredHostExternalSpecifiers(): string[] {
  return [...getHostExternalImporterStore().keys()];
}
