/**
 * Re-exports the cloud inference routing surface — route resolution plus the
 * cloud-connection gate — from `@elizaos/cloud-routing`, keeping core a thin
 * pass-through over a single source of truth. `RuntimeSettings` is re-exported
 * under core's historical `CloudRuntimeSettings` name to preserve the public
 * surface. (#12092 item 28)
 */
export type {
	CloudRoute,
	CloudRouteSource,
	RouteSpec,
} from "@elizaos/cloud-routing";
export {
	cloudServiceApisBaseUrl,
	isCloudConnected,
	type RuntimeSettings as CloudRuntimeSettings,
	resolveCloudRoute,
	toRuntimeSettings,
} from "@elizaos/cloud-routing";
