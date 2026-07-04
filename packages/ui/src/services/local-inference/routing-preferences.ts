/**
 * Re-exports the inference routing-policy preferences (local vs cloud provider
 * selection) from the local-inference shared surface.
 */
export {
  DEFAULT_ROUTING_POLICY,
  type RoutingPolicy,
  type RoutingPreferences,
  readRoutingPreferences,
  setPolicy,
  setPreferredProvider,
  writeRoutingPreferences,
} from "@elizaos/shared/local-inference/routing-preferences";
