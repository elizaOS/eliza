/**
 * Deterministic unit coverage for the secrets services barrel: the
 * bundle-safety anchor it writes on globalThis at import time, the
 * service-type bindings the runtime service registry consumes, and the real
 * activation lifecycle reachable through its re-exported classes with no
 * database, network, or timers involved.
 */
import { describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import type { IAgentRuntime } from "../../../types/index.ts";
import {
	PLUGIN_ACTIVATOR_SERVICE_TYPE,
	PluginActivatorService,
	type PluginWithSecrets,
	SECRETS_SERVICE_TYPE,
	SecretsService,
} from "./index.ts";
// Direct-module imports prove the barrel forwards exactly one shared class
// binding per symbol instead of duplicating module instances per path.
import { PluginActivatorService as DirectPluginActivatorService } from "./plugin-activator.ts";
import { SecretsService as DirectSecretsService } from "./secrets.ts";

describe("secrets services barrel", () => {
	it("anchors every re-exported binding on globalThis at import time", () => {
		const anchor = (globalThis as Record<string, unknown>)
			.__bundle_safety_FEATURES_SECRETS_SERVICES_INDEX__;

		expect(Array.isArray(anchor)).toBe(true);
		const anchored = anchor as unknown[];

		expect(anchored).toHaveLength(4);
		expect(anchored[0]).toBe(PLUGIN_ACTIVATOR_SERVICE_TYPE);
		expect(anchored[1]).toBe(PluginActivatorService);
		expect(anchored[2]).toBe(SECRETS_SERVICE_TYPE);
		expect(anchored[3]).toBe(SecretsService);
	});

	it("binds each service class to the registry constant consumers resolve", () => {
		expect(SECRETS_SERVICE_TYPE).toBe("SECRETS");
		expect(SecretsService.serviceType).toBe(SECRETS_SERVICE_TYPE);
		expect(PLUGIN_ACTIVATOR_SERVICE_TYPE).toBe("PLUGIN_ACTIVATOR");
		expect(PluginActivatorService.serviceType).toBe(
			PLUGIN_ACTIVATOR_SERVICE_TYPE,
		);
	});

	it("re-exports one shared class binding across direct and barrel paths", () => {
		expect(new SecretsService()).toBeInstanceOf(DirectSecretsService);
		expect(new PluginActivatorService()).toBeInstanceOf(
			DirectPluginActivatorService,
		);
	});

	it("reports an empty activation surface before any plugin registers", () => {
		const service = new PluginActivatorService();

		expect(service.getPendingPlugins()).toEqual([]);
		expect(service.getActivatedPlugins()).toEqual([]);
		expect(service.getRequiredSecrets().size).toBe(0);
		expect(service.isPending("no-such-plugin")).toBe(false);
		expect(service.isActivated("no-such-plugin")).toBe(false);
		expect(service.getPluginsWaitingFor("TOKEN")).toEqual([]);
		expect(service.getPluginStatuses().size).toBe(0);
	});

	it("activates immediately when a plugin declares no secret requirements", async () => {
		const runtime = createMockRuntime();
		const service = new PluginActivatorService(runtime);
		const activation = vi.fn(async () => undefined);
		const readyRuntimes: IAgentRuntime[] = [];
		const listenerRuntimes: IAgentRuntime[] = [];
		const plugin: PluginWithSecrets = {
			name: "no-secrets-plugin",
			description: "Needs nothing, activates right away.",
			onSecretsReady: async (activatedRuntime) => {
				readyRuntimes.push(activatedRuntime);
			},
		};
		const unsubscribe = service.onSecretsReady(
			plugin.name,
			async (listenerRuntime) => {
				listenerRuntimes.push(listenerRuntime);
			},
		);

		try {
			expect(await service.registerPlugin(plugin, activation)).toBe(true);
			expect(activation).toHaveBeenCalledTimes(1);
			expect(readyRuntimes).toEqual([runtime]);
			expect(listenerRuntimes).toEqual([runtime]);
			expect(service.isActivated(plugin.name)).toBe(true);
			expect(service.getRegisteredPluginIds()).toEqual([plugin.name]);
			expect(service.getPluginStatuses().get(plugin.name)).toEqual({
				pending: false,
				activated: true,
				missingSecrets: [],
			});

			// A second registration of an already-activated plugin must not run
			// the activation work again.
			expect(await service.registerPlugin(plugin, activation)).toBe(true);
			expect(activation).toHaveBeenCalledTimes(1);
		} finally {
			unsubscribe();
			await service.stop();
		}
	});

	it("queues a plugin with unmet required secrets and unregisters it once", async () => {
		const runtime = createMockRuntime();
		const service = new PluginActivatorService(runtime);
		const activation = vi.fn(async () => undefined);
		const plugin: PluginWithSecrets = {
			name: "queued-plugin",
			description: "Waits for a token that never arrives.",
			requiredSecrets: {
				TOKEN: {
					description: "Access token",
					type: "token",
					required: true,
				},
			},
		};

		expect(await service.registerPlugin(plugin, activation)).toBe(false);
		expect(activation).not.toHaveBeenCalled();
		expect(service.getPendingPlugins()).toEqual([plugin.name]);
		expect(service.isPending(plugin.name)).toBe(true);
		expect(service.isActivated(plugin.name)).toBe(false);
		expect([...service.getRequiredSecrets()]).toEqual(["TOKEN"]);
		expect(service.getPluginsWaitingFor("TOKEN")).toEqual([plugin.name]);
		expect(service.getPluginStatuses().get(plugin.name)).toEqual({
			pending: true,
			activated: false,
			missingSecrets: ["TOKEN"],
		});

		expect(service.unregisterPlugin(plugin.name)).toBe(true);
		expect(service.isPending(plugin.name)).toBe(false);
		expect(service.getPluginsWaitingFor("TOKEN")).toEqual([]);

		// Unregistering again reports the now-missing pending entry.
		expect(service.unregisterPlugin(plugin.name)).toBe(false);
		await service.stop();
	});

	it("runs the real validation strategy registry behind the barrel", async () => {
		const service = new SecretsService();
		const strategies = service.getValidationStrategies();

		expect(strategies).toContain("none");
		expect(strategies).toContain("custom");
		expect(strategies).toContain("api_key:openai");

		const passing = await service.validate("ANY_KEY", "anything", "none");
		expect(passing.isValid).toBe(true);

		const failing = await service.validate(
			"OPENAI_API_KEY",
			"not-an-openai-key",
			"api_key:openai",
		);
		expect(failing.isValid).toBe(false);
		expect(failing.error).toContain("sk-");

		await service.stop();
	});
});
