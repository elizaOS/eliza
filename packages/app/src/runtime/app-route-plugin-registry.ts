/**
 * Re-exports the app-route-plugin loader registry from `@elizaos/core` so
 * app consumers can register, list, and drain the deferred loaders that
 * mount plugin-owned HTTP routes once the runtime is ready.
 */

export { drainAppRoutePluginLoaders } from "@elizaos/host";
export {
  type AppRoutePluginLoader,
  type AppRoutePluginRegistryEntry,
  listAppRoutePluginLoaders,
  registerAppRoutePluginLoader,
} from "@elizaos/host/protocol";
