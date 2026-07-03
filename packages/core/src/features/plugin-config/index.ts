/**
 * Plugin-config — action slice.
 *
 * Re-exports the four atomic actions, the plugin assembly, and the runtime
 * contract types (`PluginConfigClient`, requirements / status / delivery
 * shapes, service + event name constants).
 */

// Re-export each action from its defining file, NOT through a re-export-only
// barrel — see the note in ./plugin.ts (Bun.build drops barrel-only-reachable
// modules when the mobile bundle lowers @elizaos/core to lazy CJS-interop
// inits, silently removing the feature from the on-device bundle).
export { activatePluginIfReadyAction } from "./actions/activate-plugin-if-ready.ts";
export { deliverPluginConfigFormAction } from "./actions/deliver-plugin-config-form.ts";
export { pollPluginConfigStatusAction } from "./actions/poll-plugin-config-status.ts";
export { probePluginConfigRequirementsAction } from "./actions/probe-plugin-config-requirements.ts";

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

// Path-derived symbol so parents that `export *` two of these don't
// collide on a shared `__BUNDLE_SAFETY__` name. Without this eager anchor
// the whole feature is reachable only through re-export edges and Bun.build
// tree-shakes the module bodies out of the mobile agent bundle (see
// features/payments/index.ts — same incident class). The plugin eagerly
// imports every action, so anchoring it keeps the full feature.
import { anchorBundleSafety } from "../../bundle-safety.ts";
import { pluginConfigPlugin as _bs_1_pluginConfigPlugin } from "./plugin.ts";

anchorBundleSafety("FEATURES_PLUGIN_CONFIG_INDEX", [_bs_1_pluginConfigPlugin]);
