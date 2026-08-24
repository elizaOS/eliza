/**
 * Behavior tests for createAdvancedPlanningPlugin — the advanced-planning
 * barrel consumed by the plugin loader.
 *
 * Drives the real module: asserts the assembled plugin registers the actual
 * PLAN action instance and PlanningService class by identity with no
 * providers, passes the loader's own validation gates, returns fresh
 * registration arrays per call, and disposes through
 * runtime.getService(PlanningService.serviceType) -> stop(), including the
 * unregistered-service path and propagation of a failing stop.
 */
import { describe, expect, it, vi } from "vitest";

import { isValidPluginShape, validatePlugin } from "../../plugin.ts";
import type { IAgentRuntime } from "../../types/index.ts";
import { planAction } from "./actions/plan.ts";
import { createAdvancedPlanningPlugin, PlanningService } from "./index.ts";

function makeRuntime(service?: { stop: () => Promise<void> }): {
	runtime: IAgentRuntime;
	getService: ReturnType<typeof vi.fn>;
} {
	const getService = vi.fn().mockReturnValue(service);
	return { runtime: { getService } as unknown as IAgentRuntime, getService };
}

describe("createAdvancedPlanningPlugin", () => {
	it("names the plugin and describes the capability", () => {
		const plugin = createAdvancedPlanningPlugin();
		expect(plugin.name).toBe("advanced-planning");
		expect(typeof plugin.description).toBe("string");
		expect(plugin.description?.length).toBeGreaterThan(0);
	});

	it("registers the real PLAN action instance and the exported PlanningService class", () => {
		const plugin = createAdvancedPlanningPlugin();
		expect(plugin.actions).toEqual([planAction]);
		expect(plugin.actions?.[0]).toBe(planAction);
		expect(plugin.services).toEqual([PlanningService]);
		expect(plugin.providers).toEqual([]);
	});

	it("passes the loader's own shape and validation gates", () => {
		const plugin = createAdvancedPlanningPlugin();
		expect(isValidPluginShape(plugin)).toBe(true);
		const verdict = validatePlugin(plugin);
		expect(verdict.isValid).toBe(true);
		expect(verdict.errors).toEqual([]);
	});

	it("returns fresh registration arrays on every call", () => {
		const first = createAdvancedPlanningPlugin();
		const second = createAdvancedPlanningPlugin();

		expect(second).not.toBe(first);

		first.actions?.push(planAction);
		if (first.services) first.services.length = 0;

		expect(second.actions).toEqual([planAction]);
		expect(second.services).toEqual([PlanningService]);
	});

	it("stops the registered PlanningService on dispose, looked up by serviceType", async () => {
		const stop = vi.fn().mockResolvedValue(undefined);
		const { runtime, getService } = makeRuntime({ stop });
		const plugin = createAdvancedPlanningPlugin();

		await plugin.dispose?.(runtime);

		expect(getService).toHaveBeenCalledTimes(1);
		expect(getService).toHaveBeenCalledWith(PlanningService.serviceType);
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("resolves without stopping anything when no PlanningService is registered", async () => {
		const { runtime, getService } = makeRuntime(undefined);
		const plugin = createAdvancedPlanningPlugin();

		await expect(plugin.dispose?.(runtime)).resolves.toBeUndefined();
		expect(getService).toHaveBeenCalledWith(PlanningService.serviceType);
	});

	it("propagates a failing stop instead of swallowing it", async () => {
		const boom = new Error("planning teardown failed");
		const { runtime } = makeRuntime({ stop: vi.fn().mockRejectedValue(boom) });
		const plugin = createAdvancedPlanningPlugin();

		await expect(plugin.dispose?.(runtime)).rejects.toBe(boom);
	});
});
