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
import {
	activatePluginIfReadyAction,
	deliverPluginConfigFormAction,
	pollPluginConfigStatusAction,
	probePluginConfigRequirementsAction,
} from "./actions/index.ts";

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
