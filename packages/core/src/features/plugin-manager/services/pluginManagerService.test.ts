/**
 * Exercises the plugin manager's in-memory registry and dynamic lifecycle
 * against real runtime component arrays, without invoking package installation.
 */
import { describe, expect, it } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import type { Action, Provider } from "../../../types/components.ts";
import type { Plugin } from "../../../types/plugin.ts";
import type { IAgentRuntime } from "../../../types/runtime.ts";
import { PluginStatus } from "../types.ts";
import { PluginManagerService } from "./pluginManagerService.ts";

function createAction(name: string): Action {
	return {
		name,
		description: `${name} action`,
		validate: async () => true,
		handler: async () => undefined,
	};
}

function createProvider(name: string): Provider {
	return {
		name,
		get: async () => ({ text: `${name} context` }),
	};
}

function createRuntime(plugins: Plugin[] = []): IAgentRuntime {
	const actions: Action[] = [];
	const providers: Provider[] = [];
	const runtime = createMockRuntime({ actions, plugins, providers });
	runtime.registerAction = (action) => {
		actions.push(action);
	};
	runtime.registerProvider = (provider) => {
		providers.push(provider);
	};
	return runtime;
}

describe("PluginManagerService registry", () => {
	it("requires a runtime", () => {
		expect(() => new PluginManagerService()).toThrow(
			"PluginManagerService requires a runtime",
		);
	});

	it("starts with original plugins loaded and records their components", async () => {
		const original: Plugin = {
			name: "startup-plugin",
			description: "Loaded before the manager starts",
			actions: [createAction("startup-action")],
			providers: [createProvider("startup-provider")],
		};
		const runtime = createRuntime([original]);

		const service = await PluginManagerService.start(runtime);
		const [state] = service.getAllPlugins();

		expect(state).toMatchObject({
			name: "startup-plugin",
			status: PluginStatus.LOADED,
			plugin: original,
		});
		expect(state?.components?.actions).toEqual(new Set(["startup-action"]));
		expect(state?.components?.providers).toEqual(new Set(["startup-provider"]));
		expect(service.getLoadedPlugins()).toEqual([state]);
		expect(service.getOriginalPlugins()).toEqual(["startup-plugin"]);
		expect(service.canUnloadPlugin("startup-plugin")).toBe(false);
		expect(service.getProtectionReason("startup-plugin")).toContain(
			"loaded at startup",
		);
	});

	it("updates known plugin state and ignores a missing id", async () => {
		const service = await PluginManagerService.start(createRuntime());
		const pluginId = await service.registerPlugin({
			name: "stateful-plugin",
			description: "Exercises state updates",
		});

		service.updatePluginState(pluginId, {
			status: PluginStatus.ERROR,
			error: "failed",
		});
		service.updatePluginState("missing", { status: PluginStatus.LOADED });

		expect(service.getPlugin(pluginId)).toMatchObject({
			name: "stateful-plugin",
			status: PluginStatus.ERROR,
			error: "failed",
		});
		expect(service.getPlugin("missing")).toBeUndefined();
		expect(service.getLoadedPlugins()).toEqual([]);
	});

	it("rejects duplicate and protected registrations across naming forms", async () => {
		const service = await PluginManagerService.start(createRuntime());
		const plugin = {
			name: "ordinary-plugin",
			description: "Registered once",
		};

		await service.registerPlugin(plugin);
		await expect(service.registerPlugin(plugin)).rejects.toThrow(
			"Plugin ordinary-plugin already registered",
		);
		await expect(
			service.registerPlugin({ name: "bootstrap", description: "protected" }),
		).rejects.toThrow("Cannot register protected plugin: bootstrap");
		await expect(
			service.registerPlugin({
				name: "@elizaos/bootstrap",
				description: "protected alias",
			}),
		).rejects.toThrow("Cannot register protected plugin: @elizaos/bootstrap");
		await expect(
			service.registerPlugin({
				name: "plugin-sql",
				description: "unscoped protected alias",
			}),
		).rejects.toThrow("Cannot register protected plugin: plugin-sql");
	});

	it("reports protection reasons for exact, scoped, unscoped, and ordinary names", async () => {
		const service = await PluginManagerService.start(createRuntime());

		expect(service.getProtectedPlugins()).toContain("bootstrap");
		expect(service.canUnloadPlugin("bootstrap")).toBe(false);
		expect(service.canUnloadPlugin("@elizaos/bootstrap")).toBe(false);
		expect(service.canUnloadPlugin("plugin-sql")).toBe(false);
		expect(service.getProtectionReason("bootstrap")).toContain(
			"core system plugin",
		);
		expect(service.getProtectionReason("@elizaos/bootstrap")).toContain(
			"core system plugin",
		);
		expect(service.getProtectionReason("plugin-sql")).toContain(
			"core system plugin",
		);
		expect(service.canUnloadPlugin("ordinary-plugin")).toBe(true);
		expect(service.getProtectionReason("ordinary-plugin")).toBeNull();
	});
});

describe("PluginManagerService dynamic lifecycle", () => {
	it("loads and unloads a plugin through the real component collections", async () => {
		const runtime = createRuntime();
		let initRuntime: IAgentRuntime | undefined;
		const action = createAction("dynamic-action");
		const provider = createProvider("dynamic-provider");
		const plugin: Plugin = {
			name: "dynamic-plugin",
			description: "Loaded after startup",
			actions: [action],
			providers: [provider],
			init: async (_config, initializedRuntime) => {
				initRuntime = initializedRuntime;
			},
		};
		const service = await PluginManagerService.start(runtime);
		const pluginId = await service.registerPlugin(plugin);

		await service.loadPlugin({ pluginId });

		expect(initRuntime).toBe(runtime);
		expect(runtime.actions).toEqual([action]);
		expect(runtime.providers).toEqual([provider]);
		expect(runtime.plugins).toEqual([plugin]);
		expect(service.getPlugin(pluginId)).toMatchObject({
			status: PluginStatus.LOADED,
			error: undefined,
		});

		await service.unloadPlugin({ pluginId });

		expect(runtime.actions).toEqual([]);
		expect(runtime.providers).toEqual([]);
		expect(runtime.plugins).toEqual([]);
		expect(service.getPlugin(pluginId)).toMatchObject({
			status: PluginStatus.UNLOADED,
		});
	});

	it("treats repeated load and unload calls as no-ops", async () => {
		const runtime = createRuntime();
		let initCalls = 0;
		const service = await PluginManagerService.start(runtime);
		const pluginId = await service.registerPlugin({
			name: "idempotent-plugin",
			description: "Exercises repeated lifecycle calls",
			init: () => {
				initCalls += 1;
			},
		});

		await service.unloadPlugin({ pluginId });
		await service.loadPlugin({ pluginId });
		await service.loadPlugin({ pluginId });
		await service.unloadPlugin({ pluginId });
		await service.unloadPlugin({ pluginId });

		expect(initCalls).toBe(1);
		expect(runtime.plugins).toEqual([]);
		expect(service.getPlugin(pluginId)?.status).toBe(PluginStatus.UNLOADED);
	});

	it("rejects unknown ids and states that cannot be loaded", async () => {
		const service = await PluginManagerService.start(createRuntime());

		await expect(service.loadPlugin({ pluginId: "missing" })).rejects.toThrow(
			"Plugin missing not found in registry",
		);
		await expect(service.unloadPlugin({ pluginId: "missing" })).rejects.toThrow(
			"Plugin missing not found in registry",
		);

		const pluginId = await service.registerPlugin({
			name: "invalid-state-plugin",
			description: "Cannot load from an error state",
		});
		service.updatePluginState(pluginId, { status: PluginStatus.ERROR });

		await expect(service.loadPlugin({ pluginId })).rejects.toThrow(
			"Plugin invalid-state-plugin is not ready to load (status: error)",
		);
	});

	it("rejects loading a state without a plugin instance", async () => {
		const service = await PluginManagerService.start(createRuntime());
		service.plugins.set("detached", {
			id: "detached",
			name: "detached-plugin",
			status: PluginStatus.READY,
			createdAt: Date.now(),
		});

		await expect(service.loadPlugin({ pluginId: "detached" })).rejects.toThrow(
			"Plugin detached-plugin has no plugin instance",
		);
	});

	it("refuses original plugin unloads and forced protected loads", async () => {
		const original: Plugin = {
			name: "startup-plugin",
			description: "Protected because it was present at startup",
		};
		const service = await PluginManagerService.start(createRuntime([original]));
		const originalState = service.getAllPlugins()[0];

		await expect(
			service.unloadPlugin({ pluginId: originalState.id }),
		).rejects.toThrow("Cannot unload original plugin startup-plugin");

		service.plugins.set("protected", {
			id: "protected",
			name: "bootstrap",
			status: PluginStatus.ERROR,
			plugin: { name: "bootstrap", description: "protected" },
			createdAt: Date.now(),
		});
		await expect(
			service.loadPlugin({ pluginId: "protected", force: true }),
		).rejects.toThrow("Cannot force load protected plugin bootstrap");
	});
});
