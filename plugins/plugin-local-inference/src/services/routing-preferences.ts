/**
 * Re-export of the shared routing-preferences module. The canonical
 * implementation lives in `@elizaos/plugin-native-inference/model-catalog` because both
 * the server (`@elizaos/app`) and the UI client (`@elizaos/ui`)
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
	setTextRouting,
	updateRoutingPreferences,
	writeRoutingPreferences,
} from "@elizaos/plugin-native-inference/model-catalog/routing-preferences";
