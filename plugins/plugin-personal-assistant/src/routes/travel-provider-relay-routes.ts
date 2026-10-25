/**
 * Re-export shim for the travel-provider relay route, which lives in
 * `@elizaos/plugin-elizacloud`; PA callers import it from here.
 */

export {
  handleTravelProviderRelayRoute,
  type TravelProviderRelayRouteState,
} from "@elizaos/plugin-elizacloud/routes/travel-provider-relay-routes";
