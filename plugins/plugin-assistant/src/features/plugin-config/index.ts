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
