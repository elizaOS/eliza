/**
 * Coverage for the plugin-config feature barrel: importing the module must
 * eagerly anchor the assembled plugin under its unique bundle-safety key on
 * globalThis (the Bun.build tree-shaking workaround), alias the default export
 * to the same plugin object, and forward every action and runtime constant as
 * the identical reference from its defining module. Real module under test;
 * no mocks.
 */
import { describe, expect, test } from "vitest";
import { activatePluginIfReadyAction } from "./actions/activate-plugin-if-ready";
import { deliverPluginConfigFormAction } from "./actions/deliver-plugin-config-form";
import { pollPluginConfigStatusAction } from "./actions/poll-plugin-config-status";
import { probePluginConfigRequirementsAction } from "./actions/probe-plugin-config-requirements";
import * as pluginConfigIndex from "./index";
import { pluginConfigPlugin } from "./plugin";
import { PLUGIN_ACTIVATED_EVENT, PLUGIN_CONFIG_CLIENT_SERVICE } from "./types";

describe("features/plugin-config/index", () => {
	test("anchors the assembled plugin on globalThis for bundle retention", () => {
		const source = globalThis as Record<string, unknown>;
		const anchored = source.__bundle_safety_FEATURES_PLUGIN_CONFIG_INDEX__;
		expect(Array.isArray(anchored)).toBe(true);
		const values = anchored as readonly unknown[];
		expect(values).toHaveLength(1);
		expect(values[0]).toBe(pluginConfigPlugin);
	});

	test("aliases the default export to the named pluginConfigPlugin", () => {
		expect(pluginConfigIndex.pluginConfigPlugin).toBe(pluginConfigPlugin);
		expect(pluginConfigIndex.default).toBe(pluginConfigPlugin);
	});

	test("forwards each atomic action by reference from its defining module", () => {
		expect(pluginConfigIndex.activatePluginIfReadyAction).toBe(
			activatePluginIfReadyAction,
		);
		expect(pluginConfigIndex.deliverPluginConfigFormAction).toBe(
			deliverPluginConfigFormAction,
		);
		expect(pluginConfigIndex.pollPluginConfigStatusAction).toBe(
			pollPluginConfigStatusAction,
		);
		expect(pluginConfigIndex.probePluginConfigRequirementsAction).toBe(
			probePluginConfigRequirementsAction,
		);
	});

	test("forwards the runtime event and service constants from types", () => {
		expect(pluginConfigIndex.PLUGIN_ACTIVATED_EVENT).toBe(
			PLUGIN_ACTIVATED_EVENT,
		);
		expect(pluginConfigIndex.PLUGIN_CONFIG_CLIENT_SERVICE).toBe(
			PLUGIN_CONFIG_CLIENT_SERVICE,
		);
	});
});
