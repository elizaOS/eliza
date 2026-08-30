/**
 * Runtime registry of cloud dashboard routes: register lazy route components and
 * their public/authed access policy, consumed by the CloudRouterShell.
 */
import type { SurfaceManifest } from "@elizaos/core";
import type { ComponentType, LazyExoticComponent, ReactNode } from "react";
import { reportRendererDiagnostic } from "../../utils/renderer-diagnostics";

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
  /** Route path relative to the cloud mount (e.g. `"cloud/agents"`). */
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
  /** Cross-host surface and page-layout policy for this route. */
  surface?: SurfaceManifest;
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
  listeners: Set<() => void>;
}

function registryKey(): symbol {
  return Symbol.for("elizaos.ui.cloud-route-registry");
}

function getStore(): CloudRouteRegistryStore {
  const globalObject = globalThis as Record<PropertyKey, unknown>;
  const key = registryKey();
  const existing = globalObject[key] as CloudRouteRegistryStore | undefined;
  if (existing) {
    if (!existing.listeners) existing.listeners = new Set();
    return existing;
  }
  const created: CloudRouteRegistryStore = {
    entries: new Map<string, CloudRouteDef>(),
    seq: 0,
    listeners: new Set(),
  };
  globalObject[key] = created;
  return created;
}

function notifyCloudRouteListeners(): void {
  for (const listener of getStore().listeners) {
    listener();
  }
}

/**
 * Subscribe to route-registry mutations (registration / override). Used by
 * {@link CloudRouterShell} so public routes can paint before private domains
 * finish dynamically importing (#18056).
 */
export function subscribeCloudRoutes(onStoreChange: () => void): () => void {
  const store = getStore();
  store.listeners.add(onStoreChange);
  return () => {
    store.listeners.delete(onStoreChange);
  };
}

/** Snapshot version for `useSyncExternalStore` — increments on each mutation. */
export function getCloudRouteRegistryVersion(): number {
  return getStore().seq;
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
    (def.group === "cloud" || def.group === "admin") &&
    def.surface?.layout?.topology === "ambient"
  ) {
    throw new Error(
      `Managed cloud route "${def.path}" must use the canonical framed topology`,
    );
  }
  if (
    isDevMode() &&
    existing &&
    existing.public !== true &&
    def.public === true
  ) {
    reportRendererDiagnostic({
      scope: "cloud-routes.private-to-public-reregistration",
      error: new Error("A private cloud route was re-registered as public"),
      severity: "warning",
      context: { path: def.path },
    });
  }
  const entry: CloudRouteEntry = { ...def, order: store.seq };
  store.seq += 1;
  store.entries.set(def.path, entry);
  notifyCloudRouteListeners();
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
    .map(
      ({
        path,
        element,
        public: isPublic,
        publicAccess,
        group,
        gate,
        surface,
      }) => ({
        path,
        element,
        public: isPublic,
        publicAccess,
        group,
        gate,
        surface,
      }),
    );
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
