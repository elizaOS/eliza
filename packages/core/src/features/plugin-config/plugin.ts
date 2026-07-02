/**
 * Plugin-config capability — action slice.
 *
 * Registers four atomic actions:
 *   PROBE_PLUGIN_CONFIG_REQUIREMENTS, DELIVER_PLUGIN_CONFIG_FORM,
 *   POLL_PLUGIN_CONFIG_STATUS, ACTIVATE_PLUGIN_IF_READY.
 *
 * Composition (probe → deliver → poll → activate) is done by the planner.
 * The cloud / app-core `PluginConfigClient` implementation is registered by
 * sibling waves and resolved here via `runtime.getService(...)`.
 *
 * This plugin is intentionally NOT auto-enabled.
 */

import { logger } from "../../logger.ts";
import type { Plugin } from "../../types/index.ts";
// Import each action from its defining file, NOT through a re-export-only
// barrel. When the mobile agent bundle lowers @elizaos/core into lazy
// CJS-interop module inits (the core barrel graph is cyclic via
// features/basic-capabilities -> ../index.ts), Bun's tree-shaker drops
// modules that are reachable only through a pure re-export barrel — this
// entire feature was silently absent from the shipped mobile bundle
// (same incident class as sub-agent-credentials/plugin.ts).
import { activatePluginIfReadyAction } from "./actions/activate-plugin-if-ready.ts";
import { deliverPluginConfigFormAction } from "./actions/deliver-plugin-config-form.ts";
import { pollPluginConfigStatusAction } from "./actions/poll-plugin-config-status.ts";
import { probePluginConfigRequirementsAction } from "./actions/probe-plugin-config-requirements.ts";

export const pluginConfigPlugin: Plugin = {
	name: "plugin-config",
	description:
		"Plugin-config atomic actions: probe / deliver / poll / activate.",
	actions: [
		probePluginConfigRequirementsAction,
		deliverPluginConfigFormAction,
		pollPluginConfigStatusAction,
		activatePluginIfReadyAction,
	],
	init: async () => {
		logger.info("[PluginConfigPlugin] Initialized");
	},
};

export default pluginConfigPlugin;
