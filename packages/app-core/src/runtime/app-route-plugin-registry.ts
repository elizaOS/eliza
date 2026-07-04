/**
 * Re-exports the app-route-plugin loader registry from `@elizaos/core` so
 * app-core consumers can register, list, and drain the deferred loaders that
 * mount plugin-owned HTTP routes once the runtime is ready.
 */
export type {
  AppRoutePluginLoader,
  AppRoutePluginRegistryEntry,
} from "@elizaos/core";
export {
  drainAppRoutePluginLoaders,
  listAppRoutePluginLoaders,
  registerAppRoutePluginLoader,
} from "@elizaos/core";
