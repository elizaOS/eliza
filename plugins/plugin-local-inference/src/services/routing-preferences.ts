/**
 * Re-export of the shared routing-preferences module. The canonical
 * implementation lives in `@elizaos/shared/local-inference` because both
 * the server (`@elizaos/app-core`) and the UI client (`@elizaos/ui`)
 * read/write the same routing.json with identical semantics.
 */
export {
	DEFAULT_ROUTING_POLICY,
	isRoutingPolicy,
	ROUTING_POLICIES,
	type RoutingPolicy,
	type RoutingPreferences,
	readRoutingPreferences,
	setPolicy,
	setPreferredProvider,
	writeRoutingPreferences,
} from "@elizaos/shared/local-inference/routing-preferences";
