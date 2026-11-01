/** The authoritative page registry, independent of renderer and overlay hosts. */
import type {
  SurfaceManifest,
  ViewCapability,
  ViewKind,
} from "@elizaos/core/schema-types";
import type { ComponentType } from "react";
import { getUiRegistryStore } from "./registry-host.js";
export type AppShellPageLoader = () => Promise<{
  default: ComponentType<Record<string, unknown>>;
  cleanup?: () => void | Promise<void>;
}>;
export type AppShellPageAvailability = "always" | "managed-cloud";
/**
 * A page contributed at runtime by a plugin or host app. Mirrors the fields
 * on `PluginAppNavTab` from `@elizaos/core`, plus either a resolved React
 * component or a lazy loader the shell mounts on demand.
 */
export interface AppShellPageRegistration {
  /** Stable id, scoped to the owning plugin (e.g. `"wallet.inventory"`). */
  id: string;
  /** Canonical backend view id when it differs from this shell registration id. */
  agentViewId?: string;
  /** Owning plugin id. */
  pluginId: string;
  /** Display label in the tab bar / nav. */
  label: string;
  /** Lucide icon name. */
  icon?: string;
  /** Route path the tab links to. */
  path: string;
  /**
   * Optional additional route patterns owned by this page. A `:segment`
   * consumes one path segment and a terminal `*` consumes the remainder. This
   * lets one host page own a nested family such as `/cloud/*` while its
   * navigation link remains the concrete `/cloud` root.
   */
  pathPatterns?: readonly string[];
  /**
   * Runtime availability enforced by the app router and every registry-backed
   * discovery surface. Defaults to `always`.
   */
  availability?: AppShellPageAvailability;
  /**
   * Optional shell tab id this route activates. Defaults to `id`; use this for
   * plugin pages that are mounted under an existing built-in tab.
   */
  tabAffinity?: string;
  /** Sort priority within the nav (lower = first). Default 100. */
  order?: number;

  /** Four-tier visibility category; absent values default to release. */
  viewKind?: ViewKind;
  /** Optional named group the tab belongs to. */
  group?: string;

  /** Declared surface policies and capability grants. */
  surface?: SurfaceManifest;
  /** Shares the plugin view's typed authority catalog with the bundled renderer. */
  capabilities?: readonly ViewCapability[];
  /** Dispatches declared semantic operations while the owning page is mounted. */
  interact?: (
    capability: string,
    params?: Record<string, unknown>,
  ) => Promise<unknown>;

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
function normalizedRouteSegments(path: string): string[] {
  return path
    .split(/[?#]/, 1)[0]
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);
}
/** Pure exact/pattern matcher shared by navigation and the shell renderer. */
export function appShellPageMatchesPath(
  page: AppShellPageRegistration,
  navigationPath: string,
): boolean {
  const candidate = normalizedRouteSegments(navigationPath);
  const patterns = [page.path, ...(page.pathPatterns ?? [])];
  return patterns.some((pattern) => {
    const expected = normalizedRouteSegments(pattern);
    for (let index = 0; index < expected.length; index += 1) {
      const segment = expected[index];
      if (segment === "*") return index === expected.length - 1;
      if (candidate[index] === undefined) return false;
      if (!segment.startsWith(":") && segment !== candidate[index]) {
        return false;
      }
    }
    return candidate.length === expected.length;
  });
}
/** Pure runtime gate shared by routing, launcher, palette, and slash choices. */
export function appShellPageIsAvailable(
  page: AppShellPageRegistration,
  runtime: {
    managedCloud: boolean;
  },
): boolean {
  return page.availability !== "managed-cloud" || runtime.managedCloud;
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
