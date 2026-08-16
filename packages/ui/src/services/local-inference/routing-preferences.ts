/**
 * Re-exports the browser-safe inference routing preference types used by the
 * UI API client. Persistence remains server-owned because the shared runtime
 * module imports Node filesystem, crypto, path, and host APIs.
 */
export type {
  RoutingPolicy,
  RoutingPreferences,
} from "@elizaos/shared/local-inference/routing-preferences";
