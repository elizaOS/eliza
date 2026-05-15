import { describe, expect, test } from "vitest";
import { pluginConfigPlugin } from "./plugin";

describe("pluginConfigPlugin", () => {
	test("registers the four atomic plugin-config actions", () => {
		expect(pluginConfigPlugin.name).toBe("plugin-config");
		const actionNames = (pluginConfigPlugin.actions ?? []).map((a) => a.name);
		expect(actionNames).toEqual([
			"PROBE_PLUGIN_CONFIG_REQUIREMENTS",
			"DELIVER_PLUGIN_CONFIG_FORM",
			"POLL_PLUGIN_CONFIG_STATUS",
			"ACTIVATE_PLUGIN_IF_READY",
		]);
	});

	test("does not register any services, providers, or evaluators", () => {
		expect(pluginConfigPlugin.services ?? []).toHaveLength(0);
		expect(pluginConfigPlugin.providers ?? []).toHaveLength(0);
		expect(pluginConfigPlugin.evaluators ?? []).toHaveLength(0);
	});
});
