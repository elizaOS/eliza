/**
 * Unit tests for advanced-planning plugin factory and lifecycle hooks.
 * Validates plugin descriptor shape, action/service registrations, and runtime disposal.
 */
import { describe, expect, it, vi } from "vitest";
import { planAction } from "../features/advanced-planning/actions/plan.ts";
import {
	createAdvancedPlanningPlugin,
	PlanningService,
} from "../features/advanced-planning/index.ts";
import type { IAgentRuntime } from "../types/index.ts";

describe("advanced-planning plugin factory", () => {
	it("creates plugin with expected metadata, actions, and services", () => {
		const plugin = createAdvancedPlanningPlugin();
		expect(plugin.name).toBe("advanced-planning");
		expect(plugin.description).toContain("advanced planning and execution");
		expect(plugin.actions).toContain(planAction);
		expect(plugin.services).toContain(PlanningService);
		expect(plugin.providers).toEqual([]);
	});

	it("disposes running PlanningService on runtime dispose", async () => {
		const plugin = createAdvancedPlanningPlugin();
		const mockStop = vi.fn().mockResolvedValue(undefined);
		const fakeService = { stop: mockStop };
		const fakeRuntime = {
			getService: vi.fn().mockReturnValue(fakeService),
		} as unknown as IAgentRuntime;

		await plugin.dispose?.(fakeRuntime);

		expect(fakeRuntime.getService).toHaveBeenCalledWith(
			PlanningService.serviceType,
		);
		expect(mockStop).toHaveBeenCalled();
	});

	it("safely handles missing PlanningService on dispose", async () => {
		const plugin = createAdvancedPlanningPlugin();
		const fakeRuntime = {
			getService: vi.fn().mockReturnValue(null),
		} as unknown as IAgentRuntime;

		await expect(plugin.dispose?.(fakeRuntime)).resolves.not.toThrow();
	});
});
