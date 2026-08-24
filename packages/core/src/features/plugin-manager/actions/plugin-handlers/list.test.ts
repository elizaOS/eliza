/**
 * Exercises the plugin list handler's unavailable, empty, loaded, installed,
 * and combined planner-facing results using the real handler implementation.
 */

import { describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import { type EjectedPluginInfo, PluginStatus } from "../../types.ts";
import { runList } from "./list.ts";

const INSTALLED_PLUGINS: EjectedPluginInfo[] = [
	{
		name: "@elizaos/plugin-discord",
		version: "2.1.0",
		path: "/plugins/discord",
		upstream: null,
	},
	{
		name: "@elizaos/plugin-telegram",
		version: "3.0.0",
		path: "/plugins/telegram",
		upstream: null,
	},
];

function createRuntime({
	loaded = [],
	installed = [],
	available = true,
}: {
	loaded?: Array<{ name: string; status: PluginStatus }>;
	installed?: EjectedPluginInfo[];
	available?: boolean;
} = {}): IAgentRuntime {
	const service = available
		? {
				getAllPlugins: () => loaded,
				listInstalledPlugins: async () => installed,
			}
		: null;

	return {
		getService: (name: string) => (name === "plugin_manager" ? service : null),
	} as unknown as IAgentRuntime;
}

describe("runList", () => {
	it("returns a structured failure without invoking the callback when the service is unavailable", async () => {
		let callbackCalls = 0;

		const result = await runList({
			runtime: createRuntime({ available: false }),
			callback: async () => {
				callbackCalls += 1;
				return [];
			},
		});

		expect(result).toEqual({
			success: false,
			text: "Plugin manager service not available",
		});
		expect(callbackCalls).toBe(0);
	});

	it("reports an empty plugin inventory through the callback and completion metadata", async () => {
		const replies: unknown[] = [];

		const result = await runList({
			runtime: createRuntime(),
			callback: async (content) => {
				replies.push(content);
				return [];
			},
		});

		expect(replies).toEqual([{ text: "No plugins are loaded or installed." }]);
		expect(result).toEqual({
			success: true,
			text: "No plugins are loaded or installed.",
			userFacingText: "No plugins are loaded or installed.",
			verifiedUserFacing: true,
			turnComplete: true,
			values: { mode: "list", count: 0 },
		});
	});

	it("preserves loaded plugin order and exposes only the public list fields", async () => {
		const loaded = [
			{ name: "plugin-second", status: PluginStatus.ERROR },
			{ name: "plugin-first", status: PluginStatus.LOADED },
		];

		const result = await runList({ runtime: createRuntime({ loaded }) });

		expect(result.text).toBe(
			[
				"Loaded plugins (2):",
				"  - plugin-second [error]",
				"  - plugin-first [loaded]",
			].join("\n"),
		);
		expect(result.values).toEqual({
			mode: "list",
			loadedCount: 2,
			installedCount: 0,
		});
		expect(result.data).toEqual({ loaded, installed: [] });
	});

	it("renders installed plugins in source order without a leading separator", async () => {
		const replies: unknown[] = [];

		const result = await runList({
			runtime: createRuntime({ installed: INSTALLED_PLUGINS }),
			callback: async (content) => {
				replies.push(content);
				return [];
			},
		});

		const text = [
			"Installed via registry (2):",
			"  - @elizaos/plugin-discord (v2.1.0) at /plugins/discord",
			"  - @elizaos/plugin-telegram (v3.0.0) at /plugins/telegram",
		].join("\n");
		expect(result.text).toBe(text);
		expect(replies).toEqual([{ text }]);
		expect(result.data).toEqual({
			loaded: [],
			installed: INSTALLED_PLUGINS,
		});
	});

	it("separates loaded and installed sections and reports both counts", async () => {
		const loaded = [{ name: "plugin-local", status: PluginStatus.READY }];

		const result = await runList({
			runtime: createRuntime({
				loaded,
				installed: INSTALLED_PLUGINS.slice(0, 1),
			}),
		});

		expect(result).toMatchObject({
			success: true,
			text: [
				"Loaded plugins (1):",
				"  - plugin-local [ready]",
				"",
				"Installed via registry (1):",
				"  - @elizaos/plugin-discord (v2.1.0) at /plugins/discord",
			].join("\n"),
			verifiedUserFacing: true,
			turnComplete: true,
			values: { mode: "list", loadedCount: 1, installedCount: 1 },
		});
	});
});
