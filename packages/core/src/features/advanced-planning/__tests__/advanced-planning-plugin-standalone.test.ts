/**
 * Unit tests for advanced planning plugin factory and lifecycle hooks.
 */

import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime } from "../../../types/index.ts";
import { createAdvancedPlanningPlugin, PlanningService } from "../index.ts";

describe("advanced-planning plugin", () => {
	it("creates plugin definition with expected metadata, actions, and services", () => {
		const plugin = createAdvancedPlanningPlugin();
		expect(plugin.name).toBe("advanced-planning");
		expect(plugin.description).toBeTruthy();
		expect(plugin.actions).toHaveLength(1);
		expect(plugin.actions?.[0]?.name).toBe("PLAN");
		expect(plugin.services).toHaveLength(1);
		expect(plugin.services?.[0]).toBe(PlanningService);
	});

	it("disposes PlanningService on plugin disposal", async () => {
		const plugin = createAdvancedPlanningPlugin();
		const mockStop = vi.fn().mockResolvedValue(undefined);
		const mockRuntime = {
			getService: vi.fn().mockReturnValue({ stop: mockStop }),
		} as unknown as IAgentRuntime;

		if (plugin.dispose) {
			await plugin.dispose(mockRuntime);
		}

		expect(mockRuntime.getService).toHaveBeenCalledWith(
			PlanningService.serviceType,
		);
		expect(mockStop).toHaveBeenCalledTimes(1);
	});

	it("handles plugin disposal when PlanningService is not registered", async () => {
		const plugin = createAdvancedPlanningPlugin();
		const mockRuntime = {
			getService: vi.fn().mockReturnValue(null),
		} as unknown as IAgentRuntime;

		if (plugin.dispose) {
			await expect(plugin.dispose(mockRuntime)).resolves.toBeUndefined();
		}
	});
});
