/**
 * Plugin-config — action slice.
 *
 * Re-exports the four atomic actions, the plugin scaffold, and the runtime
 * contract types (`PluginConfigClient`, requirements / status / delivery
 * shapes, service + event name constants).
 */

export {
	activatePluginIfReadyAction,
	deliverPluginConfigFormAction,
	pollPluginConfigStatusAction,
	probePluginConfigRequirementsAction,
} from "./actions/index.ts";

export { pluginConfigPlugin, pluginConfigPlugin as default } from "./plugin.ts";

export type {
	PluginActivatedEventPayload,
	PluginActivationResult,
	PluginConfigClient,
	PluginConfigDeliveryEntry,
	PluginConfigDeliveryResult,
	PluginConfigKey,
	PluginConfigRequirements,
	PluginConfigStatus,
} from "./types.ts";

export {
	PLUGIN_ACTIVATED_EVENT,
	PLUGIN_CONFIG_CLIENT_SERVICE,
} from "./types.ts";
