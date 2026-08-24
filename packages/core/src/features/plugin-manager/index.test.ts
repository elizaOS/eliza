/**
 * Deterministic tests for the plugin-manager barrel's runtime artifact,
 * `pluginManagerPlugin`: dispose() teardown ordering and missing-service
 * tolerance against recorded fake-runtime collaborators, plus the
 * default-export identity and service-composition contract the runtime
 * consumes. No network or filesystem is touched.
 */

import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import {
	CoreManagerService,
	PluginManagerService,
	pluginManagerPlugin,
} from "./index.ts";
import { PluginManagerServiceType } from "./types.ts";

function createTeardownRuntime(services: Record<string, unknown>): {
	runtime: IAgentRuntime;
	getService: ReturnType<typeof vi.fn>;
	stoppedInOrder: string[];
} {
	const stoppedInOrder: string[] = [];
	const getService = vi.fn((serviceType: string) => {
		if (!services[serviceType]) return null;
		return {
			stop: vi.fn(async () => {
				stoppedInOrder.push(serviceType);
			}),
		};
	});
	return {
		runtime: { getService } as unknown as IAgentRuntime,
		getService,
		stoppedInOrder,
	};
}

describe("pluginManagerPlugin", () => {
	it("is exposed identically as the barrel's default export", () => {
		expect(pluginManagerPlugin.name).toBe("plugin-manager");
	});

	it("composes exactly the two manager services the runtime instantiates", () => {
		expect(pluginManagerPlugin.services).toEqual([
			PluginManagerService,
			CoreManagerService,
		]);
	});

	describe("dispose", () => {
		it("stops the plugin-manager service before the core-manager service", async () => {
			const { runtime, getService, stoppedInOrder } = createTeardownRuntime({
				[PluginManagerServiceType.PLUGIN_MANAGER]: {},
				[PluginManagerServiceType.CORE_MANAGER]: {},
			});

			await pluginManagerPlugin.dispose(runtime);

			expect(getService).toHaveBeenCalledTimes(2);
			expect(getService).toHaveBeenNthCalledWith(
				1,
				PluginManagerServiceType.PLUGIN_MANAGER,
			);
			expect(getService).toHaveBeenNthCalledWith(
				2,
				PluginManagerServiceType.CORE_MANAGER,
			);
			expect(stoppedInOrder).toEqual([
				PluginManagerServiceType.PLUGIN_MANAGER,
				PluginManagerServiceType.CORE_MANAGER,
			]);
		});

		it("still stops the core-manager service when the plugin-manager service is absent", async () => {
			const { runtime, getService, stoppedInOrder } = createTeardownRuntime({
				[PluginManagerServiceType.CORE_MANAGER]: {},
			});

			await pluginManagerPlugin.dispose(runtime);

			expect(getService).toHaveBeenCalledTimes(2);
			expect(stoppedInOrder).toEqual([PluginManagerServiceType.CORE_MANAGER]);
		});

		it("resolves without stopping anything when neither service is registered", async () => {
			const { runtime, getService, stoppedInOrder } = createTeardownRuntime({});

			await expect(
				pluginManagerPlugin.dispose(runtime),
			).resolves.toBeUndefined();

			expect(getService).toHaveBeenCalledTimes(2);
			expect(stoppedInOrder).toEqual([]);
		});
	});
});
