/**
 * Runtime registry of cloud dashboard routes: register lazy route components and
 * their public/authed access policy, consumed by the CloudRouterShell.
 */
import type { ComponentType, LazyExoticComponent, ReactNode } from "react";

export const CLOUD_PUBLIC_ROUTE_ACCESS = "cloud-public-route-reviewed" as const;

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
  /**
   * Required whenever `public: true` is set. This makes public exposure a
   * searchable, explicit opt-in instead of a boolean that can be flipped by
   * accident during re-registration.
   */
  publicAccess?: typeof CLOUD_PUBLIC_ROUTE_ACCESS;
  /** Optional grouping key for nav/IA (e.g. `"dashboard"`, `"auth"`). */
  group?: string;
  /**
   * Access gate the shell enforces centrally (#12087 Item 23). Names a gate
   * component registered via {@link registerCloudRouteGate} (built-in:
   * `"admin"` → `AdminGate`). The shell wraps the route body in that gate, so a
   * route declares its authorization as data instead of self-wrapping — and a
   * body that forgets to gate itself is still gated. A `gate` naming an
   * unregistered component renders a fail-closed denial, never the body.
   */
  gate?: string;
}

/** A gate component: wraps a route body and renders it only when authorized. */
export type CloudRouteGate = ComponentType<{ children: ReactNode }>;

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
  const existing = store.entries.get(def.path);
  if (def.public === true && def.publicAccess !== CLOUD_PUBLIC_ROUTE_ACCESS) {
    throw new Error(
      `Cloud route "${def.path}" is public but did not opt in with CLOUD_PUBLIC_ROUTE_ACCESS`,
    );
  }
  if (
    isDevMode() &&
    existing &&
    existing.public !== true &&
    def.public === true
  ) {
    console.warn(
      `[cloud-route-registry] Route "${def.path}" was re-registered from private to public. Use CLOUD_PUBLIC_ROUTE_ACCESS only for intentionally public routes.`,
    );
  }
  const entry: CloudRouteEntry = { ...def, order: store.seq };
  store.seq += 1;
  store.entries.set(def.path, entry);
}

function isDevMode(): boolean {
  return (
    import.meta.env.DEV ||
    import.meta.env.MODE === "test" ||
    process.env.NODE_ENV !== "production"
  );
}

/** All registered cloud routes, in registration order. */
export function listCloudRoutes(): CloudRouteDef[] {
  return [...getStore().entries.values()]
    .sort((a, b) => (a as CloudRouteEntry).order - (b as CloudRouteEntry).order)
    .map(({ path, element, public: isPublic, publicAccess, group, gate }) => ({
      path,
      element,
      public: isPublic,
      publicAccess,
      group,
      gate,
    }));
}

/** Look up a single registered route by path. */
export function getCloudRoute(path: string): CloudRouteDef | undefined {
  return getStore().entries.get(path);
}

// ── Route-gate registry ──────────────────────────────────────────────────────
//
// The shell enforces `CloudRouteDef.gate` centrally but stays domain-agnostic:
// each gate implementation is registered by name (mirroring the route registry
// symbol-store pattern), so the shell never imports a domain's gate directly and
// no cycle forms. `admin/index.ts` registers `"admin" → AdminGate` at import
// time, alongside its route registration.

function gateRegistryKey(): symbol {
  return Symbol.for("elizaos.ui.cloud-route-gate-registry");
}

function getGateStore(): Map<string, CloudRouteGate> {
  const globalObject = globalThis as Record<PropertyKey, unknown>;
  const key = gateRegistryKey();
  const existing = globalObject[key] as Map<string, CloudRouteGate> | undefined;
  if (existing) return existing;
  const created = new Map<string, CloudRouteGate>();
  globalObject[key] = created;
  return created;
}

/** Register (or replace) a named route gate. */
export function registerCloudRouteGate(
  name: string,
  gate: CloudRouteGate,
): void {
  getGateStore().set(name, gate);
}

/** Resolve a registered route gate by name, or `undefined` if none. */
export function getCloudRouteGate(name: string): CloudRouteGate | undefined {
  return getGateStore().get(name);
}
