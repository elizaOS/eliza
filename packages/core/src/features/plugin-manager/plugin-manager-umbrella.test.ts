import { describe, expect, it } from "vitest";
import { listSubactionsFromParameters } from "../../actions/promote-subactions.ts";
import * as pluginManagerExports from "./index.ts";
import { pluginAction, pluginManagerPlugin } from "./index.ts";

const OLD_ACTION_NAMES = [
	"LIST_EJECTED_PLUGINS",
	"LIST_INSTALLED_PLUGINS",
	"SEARCH_PLUGINS",
	"SEARCH_PLUGIN",
	"GET_PLUGIN_DETAILS",
	"CORE_STATUS",
] as const;

describe("plugin manager umbrella action", () => {
	it("registers only the umbrella action in the plugin-manager plugin", () => {
		expect(pluginManagerPlugin.actions?.map((action) => action.name)).toEqual([
			"MANAGE_PLUGINS",
		]);
	});

	it("keeps legacy duplicate names out of the planner-facing action surface", () => {
		const visibleNames = [pluginAction.name, ...(pluginAction.similes ?? [])];
		for (const oldName of OLD_ACTION_NAMES) {
			expect(visibleNames).not.toContain(oldName);
		}
	});

	it("folds plugin management operations into subactions", () => {
		expect(listSubactionsFromParameters(pluginAction.parameters)).toEqual([
			"install",
			"eject",
			"sync",
			"reinject",
			"list",
			"list_ejected",
			"search",
			"details",
			"status",
			"enable",
			"disable",
			"core_status",
			"create",
		]);
		expect(
			pluginAction.parameters?.some(
				(parameter) => parameter.name === "subaction",
			),
		).toBe(false);
	});

	it("does not re-export standalone core plugin management actions", () => {
		for (const oldExport of [
			"coreStatusAction",
			"listEjectedPluginsAction",
			"searchPluginAction",
			"getPluginDetailsAction",
		]) {
			expect(pluginManagerExports).not.toHaveProperty(oldExport);
		}
	});
});
