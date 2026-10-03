/**
 * Re-exports the app-route-plugin loader registry from `@elizaos/core` so
 * app consumers can register, list, and drain the deferred loaders that
 * mount plugin-owned HTTP routes once the runtime is ready.
 */
export {
  type AppRoutePluginLoader,
  type AppRoutePluginRegistryEntry,
  listAppRoutePluginLoaders,
  registerAppRoutePluginLoader,
} from "@elizaos/core/api/app-route-plugin-registry";
export { drainAppRoutePluginLoaders } from "@elizaos/core/api/drain-app-route-plugins";
