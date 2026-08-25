/**
 * Unit tests for coreExtensions: validates unregisterAction, unregisterProvider,
 * and unregisterService extensions added to IAgentRuntime.
 */
import { describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../../types/runtime.ts";
import {
	applyRuntimeExtensions,
	type ExtendedRuntime,
	extendRuntimeWithComponentUnregistration,
} from "./coreExtensions.ts";

describe("coreExtensions", () => {
	function createMockRuntime() {
		const servicesMap = new Map();
		return {
			actions: [
				{ name: "ACTION_ONE", description: "First action" },
				{ name: "ACTION_TWO", description: "Second action" },
			],
			providers: [
				{ name: "PROVIDER_A", get: async () => ({ text: "A" }) },
				{ name: "PROVIDER_B", get: async () => ({ text: "B" }) },
			],
			getServicesByType: (type: string) => {
				return servicesMap.get(type) || [];
			},
			getAllServices: () => servicesMap,
		} as unknown as IAgentRuntime;
	}

	it("extends runtime with unregisterAction and removes action", () => {
		const runtime = createMockRuntime();
		extendRuntimeWithComponentUnregistration(runtime);
		const ext = runtime as ExtendedRuntime;

		expect(ext.actions.length).toBe(2);
		const removed = ext.unregisterAction("ACTION_ONE");
		expect(removed).toBe(true);
		expect(ext.actions.length).toBe(1);
		expect(ext.actions[0].name).toBe("ACTION_TWO");

		const removedAgain = ext.unregisterAction("ACTION_ONE");
		expect(removedAgain).toBe(false);
	});

	it("extends runtime with unregisterProvider and removes provider", () => {
		const runtime = createMockRuntime();
		extendRuntimeWithComponentUnregistration(runtime);
		const ext = runtime as ExtendedRuntime;

		expect(ext.providers.length).toBe(2);
		ext.unregisterProvider?.("PROVIDER_A");
		expect(ext.providers.length).toBe(1);
		expect(ext.providers[0].name).toBe("PROVIDER_B");
	});

	it("extends runtime with unregisterService and stops services", async () => {
		const runtime = createMockRuntime();
		let stopped = false;
		const mockService = {
			stop: async () => {
				stopped = true;
			},
		};
		runtime.getAllServices().set("CUSTOM_SERVICE", [mockService]);

		applyRuntimeExtensions(runtime);
		const ext = runtime as ExtendedRuntime;

		await ext.unregisterService?.("CUSTOM_SERVICE");
		expect(stopped).toBe(true);
		expect(runtime.getAllServices().has("CUSTOM_SERVICE")).toBe(false);
	});
});
