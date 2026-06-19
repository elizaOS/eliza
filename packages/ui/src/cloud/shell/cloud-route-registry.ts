import type { ComponentType, LazyExoticComponent } from "react";

/**
 * Pluggable cloud-route registry.
 *
 * Cloud domain modules (apps, agents, billing, api-keys, earnings, …) each
 * register their own routes through {@link registerCloudRoute} at import time;
 * the app shell renders whatever {@link listCloudRoutes} returns. The store is
 * keyed on a global symbol — mirroring `settings-section-registry` and
 * `app-shell-registry` — so every bundle in the process shares one registry
 * even across module-identity splits (lazy chunks, plugin view bundles).
 *
 * This is what makes the cloud surface modular: a domain module adds its routes
 * with one `registerCloudRoute(...)` call, with no edits to any shared route
 * table.
 */

export interface CloudRouteDef {
  /** Route path relative to the cloud mount (e.g. `"dashboard/apps"`). */
  path: string;
  /**
   * Element to render. Either an already-`React.lazy`-wrapped component
   * (preferred for code-splitting) or a plain component.
   */
  element: LazyExoticComponent<ComponentType<unknown>> | ComponentType<unknown>;
  /**
   * When true, the route renders without an authenticated Steward session
   * (public marketing / auth / payment pages). Defaults to `false`.
   */
  public?: boolean;
  /** Optional grouping key for nav/IA (e.g. `"dashboard"`, `"auth"`). */
  group?: string;
}

interface CloudRouteRegistryStore {
  entries: Map<string, CloudRouteDef>;
  seq: number;
}

function registryKey(): symbol {
  return Symbol.for("elizaos.ui.cloud-route-registry");
}

function getStore(): CloudRouteRegistryStore {
  const globalObject = globalThis as Record<PropertyKey, unknown>;
  const key = registryKey();
  const existing = globalObject[key] as CloudRouteRegistryStore | undefined;
  if (existing) return existing;
  const created: CloudRouteRegistryStore = {
    entries: new Map<string, CloudRouteDef>(),
    seq: 0,
  };
  globalObject[key] = created;
  return created;
}

interface CloudRouteEntry extends CloudRouteDef {
  /** Registration order, used to keep `listCloudRoutes` stable. */
  order: number;
}

/**
 * Register (or replace) a cloud route. Later registration with the same `path`
 * wins, so a host app can override a built-in route by re-registering its path.
 */
export function registerCloudRoute(def: CloudRouteDef): void {
  const store = getStore();
  const entry: CloudRouteEntry = { ...def, order: store.seq };
  store.seq += 1;
  store.entries.set(def.path, entry);
}

/** All registered cloud routes, in registration order. */
export function listCloudRoutes(): CloudRouteDef[] {
  return [...getStore().entries.values()]
    .sort((a, b) => (a as CloudRouteEntry).order - (b as CloudRouteEntry).order)
    .map(({ path, element, public: isPublic, group }) => ({
      path,
      element,
      public: isPublic,
      group,
    }));
}

/** Look up a single registered route by path. */
export function getCloudRoute(path: string): CloudRouteDef | undefined {
  return getStore().entries.get(path);
}
