// Single-sourced from @elizaos/cloud-routing (#12092 item 28). Core previously
// duplicated this module; the copies drifted. `RuntimeSettings` is re-exported
// under core's historical `CloudRuntimeSettings` name to preserve the surface.
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
