/**
 * Unit coverage for the owner-only registry-plugins provider. The suite drives
 * the real provider with deterministic registry and plugin-manager boundaries
 * to verify relevance, complete rendering, empty state, and fetch degradation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import type { Memory } from "../../../types/memory.ts";
import type { IAgentRuntime } from "../../../types/runtime.ts";
import type { State } from "../../../types/state.ts";
import type { PluginManagerService } from "../services/pluginManagerService.ts";
import { getAllPlugins } from "../services/pluginRegistryService.ts";
import {
	type EjectedPluginInfo,
	type PluginMetadata,
	type PluginState,
	PluginStatus,
} from "../types.ts";
import { registryPluginsProvider } from "./registryPluginsProvider.ts";

vi.mock("../services/pluginRegistryService.ts", () => ({
	getAllPlugins: vi.fn(),
}));

const registryGetAllPlugins = vi.mocked(getAllPlugins);
const state: State = { values: {}, data: {}, text: "" };

function message(text: string): Memory {
	return { content: { text } } as Memory;
}

function registryPlugin(
	name: string,
	overrides: Partial<PluginMetadata> = {},
): PluginMetadata {
	return {
		name,
		description: `${name} description`,
		author: "elizaOS",
		repository: `https://github.com/elizaOS/${name}`,
		versions: ["1.0.0"],
		latestVersion: "1.0.0",
		runtimeVersion: "2",
		maintainer: "elizaOS",
		...overrides,
	};
}

function setup(options?: {
	plugins?: PluginState[];
	installedPlugins?: EjectedPluginInfo[];
	managerAvailable?: boolean;
}) {
	const getManagedPlugins = vi.fn(() => options?.plugins ?? []);
	const listInstalledPlugins = vi.fn(
		async () => options?.installedPlugins ?? [],
	);
	const manager = {
		getAllPlugins: getManagedPlugins,
		listInstalledPlugins,
	} as PluginManagerService;
	const reportError = vi.fn();
	const runtime = createMockRuntime({
		getService: (() =>
			options?.managerAvailable === false
				? null
				: manager) as IAgentRuntime["getService"],
		reportError,
	});

	return { runtime, getManagedPlugins, listInstalledPlugins, reportError };
}

describe("registryPluginsProvider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		registryGetAllPlugins.mockResolvedValue([]);
	});

	it("exposes its dynamic owner-only provider contract", () => {
		expect(registryPluginsProvider).toMatchObject({
			name: "registryPlugins",
			dynamic: true,
			contexts: ["connectors", "settings"],
			contextGate: { anyOf: ["connectors", "settings"] },
			cacheStable: true,
			cacheScope: "agent",
			roleGate: { minRole: "OWNER" },
		});
		expect(registryPluginsProvider.relevanceKeywords).toContain(
			"plugin registry",
		);
	});

	it("stays silent for an unrelated turn before fetching registry state", async () => {
		const { runtime, getManagedPlugins, listInstalledPlugins } = setup();

		await expect(
			registryPluginsProvider.get(runtime, message("tell me a joke"), state),
		).resolves.toEqual({ text: "" });
		expect(getManagedPlugins).toHaveBeenCalledOnce();
		expect(registryGetAllPlugins).not.toHaveBeenCalled();
		expect(listInstalledPlugins).not.toHaveBeenCalled();
	});

	it("reports an unavailable manager only on a relevant turn", async () => {
		const { runtime } = setup({ managerAvailable: false });

		await expect(
			registryPluginsProvider.get(
				runtime,
				message("show available plugins"),
				state,
			),
		).resolves.toEqual({
			text: "Plugin manager service not available",
			data: { error: "Plugin manager service not available" },
		});
		expect(registryGetAllPlugins).not.toHaveBeenCalled();
	});

	it("uses managed plugin names as dynamic relevance keywords", async () => {
		const { runtime } = setup({
			plugins: [
				{
					id: "weather",
					name: "@elizaos/plugin-cumulonimbus",
					status: PluginStatus.LOADED,
					createdAt: 1,
				},
			],
		});

		const result = await registryPluginsProvider.get(
			runtime,
			message("is cumulonimbus available?"),
			state,
		);

		expect(result.text).toBe("No plugins available in registry.\n");
		expect(registryGetAllPlugins).toHaveBeenCalledOnce();
	});

	it("returns an explicit empty registry with complete zero-count data", async () => {
		const { runtime } = setup();

		const result = await registryPluginsProvider.get(
			runtime,
			message("list registry plugins"),
			state,
		);

		expect(result).toEqual({
			text: "No plugins available in registry.\n",
			data: {
				availablePlugins: [],
				installedPlugins: [],
				registryError: undefined,
				truncated: false,
			},
			values: {
				availableCount: 0,
				installedCount: 0,
				registryAvailable: true,
			},
		});
	});

	it("renders every available and installed plugin in source order", async () => {
		const registryPlugins = [
			registryPlugin("plugin-alpha", { tags: ["social", "chat"] }),
			registryPlugin("plugin-beta", { description: "", tags: [] }),
			registryPlugin("plugin-gamma", { tags: undefined }),
		];
		const installedPlugins: EjectedPluginInfo[] = [
			{
				name: "plugin-beta",
				version: "2.3.4",
				path: "/plugins/plugin-beta",
				upstream: null,
			},
			{
				name: "plugin-delta",
				version: "5.6.7",
				path: "/plugins/plugin-delta",
				upstream: null,
			},
		];
		registryGetAllPlugins.mockResolvedValue(registryPlugins);
		const { runtime } = setup({ installedPlugins });

		const result = await registryPluginsProvider.get(
			runtime,
			message("show the plugin catalog"),
			state,
		);

		expect(result.text).toBe(
			"**Available Plugins from Registry (3 total):**\n" +
				"- **plugin-alpha**: plugin-alpha description\n" +
				"  Tags: social, chat\n" +
				"- **plugin-beta**: No description\n" +
				"- **plugin-gamma**: plugin-gamma description\n" +
				"\n**Installed Registry Plugins:**\n" +
				"- **plugin-beta** v2.3.4 (Path: /plugins/plugin-beta)\n" +
				"- **plugin-delta** v5.6.7 (Path: /plugins/plugin-delta)\n",
		);
		expect(result.data).toEqual({
			availablePlugins: [
				{
					name: "plugin-alpha",
					description: "plugin-alpha description",
					repository: "https://github.com/elizaOS/plugin-alpha",
					tags: ["social", "chat"],
					version: "1.0.0",
				},
				{
					name: "plugin-beta",
					description: "",
					repository: "https://github.com/elizaOS/plugin-beta",
					tags: [],
					version: "1.0.0",
				},
				{
					name: "plugin-gamma",
					description: "plugin-gamma description",
					repository: "https://github.com/elizaOS/plugin-gamma",
					tags: [],
					version: "1.0.0",
				},
			],
			installedPlugins,
			registryError: undefined,
			truncated: false,
		});
		expect(result.values).toEqual({
			availableCount: 3,
			installedCount: 2,
			registryAvailable: true,
		});
	});

	it.each([
		["Error objects", new Error("registry offline"), "registry offline"],
		["non-Error values", "network unavailable", "network unavailable"],
	] as const)(
		"keeps installed state and reports registry failures from %s",
		async (_label, failure, expectedMessage) => {
			registryGetAllPlugins.mockRejectedValue(failure);
			const installedPlugins: EjectedPluginInfo[] = [
				{
					name: "plugin-local",
					version: "9.0.0",
					path: "/plugins/plugin-local",
					upstream: null,
				},
			];
			const { runtime, reportError } = setup({ installedPlugins });

			const result = await registryPluginsProvider.get(
				runtime,
				message("show installed plugins"),
				state,
			);

			expect(result.text).toBe(
				`**Registry unavailable:** ${expectedMessage}\n\n` +
					"**Installed Registry Plugins:**\n" +
					"- **plugin-local** v9.0.0 (Path: /plugins/plugin-local)\n",
			);
			expect(result.data).toEqual({
				availablePlugins: [],
				installedPlugins,
				registryError: expectedMessage,
				truncated: false,
			});
			expect(result.values).toEqual({
				availableCount: 0,
				installedCount: 1,
				registryAvailable: false,
			});
			expect(reportError).toHaveBeenCalledWith(
				"RegistryPluginsProvider.fetch",
				failure,
			);
		},
	);
});
