/**
 * Unit coverage for the owner-only plugin-state provider. The suite drives the
 * real provider against an in-memory service boundary and verifies relevance,
 * lifecycle rendering, metadata, empty state, and explicit failure behavior.
 */
import { describe, expect, it } from "vitest";
import type { Memory } from "../../../types/memory.ts";
import type { IAgentRuntime } from "../../../types/runtime.ts";
import type { State } from "../../../types/state.ts";
import type { PluginManagerService } from "../services/pluginManagerService.ts";
import {
	type EjectedPluginInfo,
	type PluginState,
	PluginStatus,
} from "../types.ts";
import { pluginStateProvider } from "./pluginStateProvider.ts";

const state: State = { values: {}, data: {}, text: "" };

function message(text: string): Memory {
	return { content: { text } } as Memory;
}

function plugin(
	name: string,
	status: PluginStatus,
	overrides: Partial<PluginState> = {},
): PluginState {
	return {
		id: `id-${name}`,
		name,
		status,
		createdAt: 1,
		...overrides,
	};
}

function setup(options?: {
	plugins?: PluginState[];
	protectedPlugins?: string[];
	originalPlugins?: string[];
	ejectedPlugins?: EjectedPluginInfo[];
	serviceError?: unknown;
	managerAvailable?: boolean;
}) {
	const calls = {
		getAllPlugins: 0,
		getProtectedPlugins: 0,
		getOriginalPlugins: 0,
		listEjectedPlugins: 0,
	};
	const reportedErrors: Array<{ scope: string; error: unknown }> = [];
	const manager = {
		getAllPlugins: () => {
			calls.getAllPlugins += 1;
			if (options?.serviceError !== undefined) throw options.serviceError;
			return options?.plugins ?? [];
		},
		getProtectedPlugins: () => {
			calls.getProtectedPlugins += 1;
			return options?.protectedPlugins ?? [];
		},
		getOriginalPlugins: () => {
			calls.getOriginalPlugins += 1;
			return options?.originalPlugins ?? [];
		},
		listEjectedPlugins: async () => {
			calls.listEjectedPlugins += 1;
			return options?.ejectedPlugins ?? [];
		},
	} as unknown as PluginManagerService;
	const runtime = {
		getService: () => (options?.managerAvailable === false ? null : manager),
		reportError: (scope: string, error: unknown) => {
			reportedErrors.push({ scope, error });
		},
	} as unknown as IAgentRuntime;

	return { runtime, calls, reportedErrors };
}

describe("pluginStateProvider", () => {
	it("exposes its dynamic owner-only provider contract", () => {
		expect(pluginStateProvider).toMatchObject({
			name: "pluginState",
			dynamic: true,
			contexts: ["connectors", "settings"],
			contextGate: { anyOf: ["connectors", "settings"] },
			cacheStable: false,
			cacheScope: "turn",
			roleGate: { minRole: "OWNER" },
		});
		expect(pluginStateProvider.relevanceKeywords).toContain("plugin state");
	});

	it("stays silent for an unrelated turn before reading protected state", async () => {
		const { runtime, calls } = setup({
			plugins: [plugin("calendar-sync", PluginStatus.LOADED)],
		});

		await expect(
			pluginStateProvider.get(runtime, message("tell me a joke"), state),
		).resolves.toEqual({ text: "" });
		expect(calls).toEqual({
			getAllPlugins: 1,
			getProtectedPlugins: 0,
			getOriginalPlugins: 0,
			listEjectedPlugins: 0,
		});
	});

	it("reports an unavailable manager only on a relevant turn", async () => {
		const { runtime } = setup({ managerAvailable: false });

		await expect(
			pluginStateProvider.get(runtime, message("show plugin state"), state),
		).resolves.toEqual({
			text: "Plugin Manager service is not available",
			values: {},
			data: { error: "Plugin Manager service not found" },
		});
	});

	it("uses registered plugin names as dynamic relevance keywords", async () => {
		const weather = plugin(
			"@elizaos/plugin-weather-station",
			PluginStatus.READY,
		);
		const { runtime } = setup({ plugins: [weather] });

		const result = await pluginStateProvider.get(
			runtime,
			message("how is weather-station doing?"),
			state,
		);

		expect(result.text).toContain("**Ready to Load:**");
		expect(result.text).toContain("@elizaos/plugin-weather-station (ready)");
	});

	it("groups every lifecycle status while preserving order within a group", async () => {
		const loadedAt = Date.UTC(2026, 0, 2, 3, 4, 5);
		const plugins = [
			plugin("ready-one", PluginStatus.READY),
			plugin("loaded-first", PluginStatus.LOADED, { loadedAt }),
			plugin("broken", PluginStatus.ERROR, { error: "missing API key" }),
			plugin("unloaded-one", PluginStatus.UNLOADED, { unloadedAt: 99 }),
			plugin("loaded-second", PluginStatus.LOADED),
		];
		const { runtime } = setup({
			plugins,
			protectedPlugins: ["loaded-first"],
			originalPlugins: ["loaded-first", "ready-one"],
		});

		const result = await pluginStateProvider.get(
			runtime,
			message("show loaded plugin errors and state"),
			state,
		);
		const text = result.text;

		expect(text.indexOf("**Loaded Plugins:**")).toBeLessThan(
			text.indexOf("**Plugins with Errors:**"),
		);
		expect(text.indexOf("**Plugins with Errors:**")).toBeLessThan(
			text.indexOf("**Ready to Load:**"),
		);
		expect(text.indexOf("**Ready to Load:**")).toBeLessThan(
			text.indexOf("**Unloaded:**"),
		);
		expect(text.indexOf("loaded-first")).toBeLessThan(
			text.indexOf("loaded-second"),
		);
		expect(text).toContain(`Loaded at: ${new Date(loadedAt).toLocaleString()}`);
		expect(text).toContain("broken (error) - Error: missing API key");
		expect(result.values).toEqual({
			totalPlugins: 5,
			loadedCount: 2,
			errorCount: 1,
			readyCount: 1,
			unloadedCount: 1,
			ejectedCount: 0,
			protectedPlugins: ["loaded-first"],
			originalPlugins: ["loaded-first", "ready-one"],
		});
		expect(result.data).toMatchObject({
			plugins: [
				{ name: "ready-one", isProtected: false, isOriginal: true },
				{ name: "loaded-first", isProtected: true, isOriginal: true },
				{
					name: "broken",
					error: "missing API key",
					isProtected: false,
					isOriginal: false,
				},
				{
					name: "unloaded-one",
					unloadedAt: 99,
					isProtected: false,
					isOriginal: false,
				},
				{ name: "loaded-second", isProtected: false, isOriginal: false },
			],
			ejectedPlugins: [],
			truncated: false,
		});
	});

	it("returns the explicit empty state with zero counts", async () => {
		const { runtime } = setup();

		const result = await pluginStateProvider.get(
			runtime,
			message("list plugins"),
			state,
		);

		expect(result.text).toBe("No plugins registered in the Plugin Manager.");
		expect(result.values).toMatchObject({
			totalPlugins: 0,
			loadedCount: 0,
			errorCount: 0,
			readyCount: 0,
			unloadedCount: 0,
			ejectedCount: 0,
		});
		expect(result.data).toEqual({
			plugins: [],
			ejectedPlugins: [],
			truncated: false,
		});
	});

	it("renders every ejected plugin without truncation", async () => {
		const ejectedPlugins: EjectedPluginInfo[] = [
			{
				name: "plugin-alpha",
				version: "1.2.3",
				path: "/plugins/alpha",
				upstream: null,
			},
			{
				name: "plugin-beta",
				version: "4.5.6",
				path: "/plugins/beta",
				upstream: null,
			},
		];
		const { runtime } = setup({ ejectedPlugins });

		const result = await pluginStateProvider.get(
			runtime,
			message("show ejected plugins"),
			state,
		);

		expect(result.text).toContain(
			"- plugin-alpha (v1.2.3) at /plugins/alpha\n- plugin-beta (v4.5.6) at /plugins/beta",
		);
		expect(result.values?.ejectedCount).toBe(2);
		expect(result.data).toMatchObject({ ejectedPlugins, truncated: false });
	});

	it.each([
		["protected", ["plugin-sql"], []],
		["startup-original", [], ["plugin-bootstrap"]],
	] as const)(
		"renders system state when only %s plugins exist",
		async (_label, protectedPlugins, originalPlugins) => {
			const { runtime } = setup({
				protectedPlugins: [...protectedPlugins],
				originalPlugins: [...originalPlugins],
			});

			const result = await pluginStateProvider.get(
				runtime,
				message("show system plugins"),
				state,
			);

			expect(result.text).toContain("**System Plugins:**");
			expect(result.text).toContain(
				`- Protected: ${protectedPlugins.join(", ")}`,
			);
			expect(result.text).toContain(
				`- Original (loaded at startup): ${originalPlugins.join(", ")}`,
			);
		},
	);

	it.each([
		["Error objects", new Error("registry failed"), "registry failed"],
		["non-Error values", "registry offline", "registry offline"],
	] as const)(
		"degrades explicitly and reports %s",
		async (_label, serviceError, expectedMessage) => {
			const { runtime, reportedErrors } = setup({ serviceError });

			await expect(
				pluginStateProvider.get(runtime, message("show plugin state"), state),
			).resolves.toEqual({
				text: "Plugin state unavailable",
				values: { pluginStateAvailable: false },
				data: { available: false, error: expectedMessage },
			});
			expect(reportedErrors).toEqual([
				{ scope: "PluginStateProvider.get", error: serviceError },
			]);
		},
	);
});
