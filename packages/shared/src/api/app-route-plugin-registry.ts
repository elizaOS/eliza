/** Browser-safe loader registration; the Node host owns route draining and validation. */
import type { Plugin } from "@elizaos/core";

export type AppRoutePluginLoader = () => Plugin | Promise<Plugin>;

export interface AppRoutePluginRegistryEntry {
  id: string;
  load: AppRoutePluginLoader;
}

/**
 * Canonical `Error.name` for the error an app-route plugin loader throws when
 * its plugin is intentionally absent from this deployment (optional plugin).
 *
 * This single string literal is the whole cross-package contract: hosts
 * (`@elizaos/app-core`) construct {@link OptionalAppRoutePluginUnavailableError}
 * and {@link drainAppRoutePluginLoaders} recognizes it. Matching is by name (not
 * `instanceof`) so it stays robust when a combined deployment bundles two copies
 * of `@elizaos/core` — the class identity differs across bundles but the name
 * does not.
 */
export const OPTIONAL_APP_ROUTE_PLUGIN_UNAVAILABLE_ERROR_NAME =
  "OptionalAppRoutePluginUnavailableError";

/**
 * Error an app-route plugin loader throws when its optional plugin is not
 * installed in this deployment. Hosts throw it; {@link drainAppRoutePluginLoaders}
 * treats it as a graceful skip. Owned by the host registry so the contract has one definition.
 */
export class OptionalAppRoutePluginUnavailableError extends Error {
  readonly specifier: string;

  constructor(specifier: string, cause?: unknown) {
    super(`Optional app route plugin ${specifier} is unavailable`, { cause });
    this.name = OPTIONAL_APP_ROUTE_PLUGIN_UNAVAILABLE_ERROR_NAME;
    this.specifier = specifier;
  }
}

/**
 * Whether `err` is the optional-app-route-plugin-unavailable signal. Matches by
 * `Error.name` (not `instanceof`) so it holds across duplicate host
 * bundles in a combined deployment.
 */
export function isOptionalAppRoutePluginUnavailableError(
  err: unknown,
): boolean {
  return (
    err instanceof Error &&
    err.name === OPTIONAL_APP_ROUTE_PLUGIN_UNAVAILABLE_ERROR_NAME
  );
}

interface AppRoutePluginRegistryStore {
  entries: Map<string, AppRoutePluginRegistryEntry>;
}

const APP_ROUTE_PLUGIN_REGISTRY_KEY = Symbol.for(
  "elizaos.app.route-plugin-registry",
);

function getRegistryStore(): AppRoutePluginRegistryStore {
  const slot = globalThis as Record<PropertyKey, unknown>;
  slot[APP_ROUTE_PLUGIN_REGISTRY_KEY] ??= {
    entries: new Map<string, AppRoutePluginRegistryEntry>(),
  };
  return slot[APP_ROUTE_PLUGIN_REGISTRY_KEY] as AppRoutePluginRegistryStore;
}

export function registerAppRoutePluginLoader(
  id: string,
  load: AppRoutePluginLoader,
): void {
  getRegistryStore().entries.set(id, { id, load });
}

export function listAppRoutePluginLoaders(): AppRoutePluginRegistryEntry[] {
  return [...getRegistryStore().entries.values()];
}
