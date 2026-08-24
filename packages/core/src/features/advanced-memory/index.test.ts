/**
 * Behavior tests for createAdvancedMemoryPlugin — the advanced-memory entry
 * point consumed by the plugin loader.
 *
 * Drives the real module: asserts the assembled plugin registers the
 * MemoryService class, the long-term provider, and the evaluator bundle by
 * identity, passes the loader's own validation gates, and disposes through
 * runtime.getService(MemoryService.serviceType) -> stop(), including the
 * graceful-disable path when no storage service is registered.
 */
import { describe, expect, it, vi } from "vitest";
import { isValidPluginShape, validatePlugin } from "../../plugin.ts";
import type { IAgentRuntime } from "../../types/index.ts";
import { longTermMemoryEvaluator, memoryItems } from "./evaluators/index.ts";
import { createAdvancedMemoryPlugin } from "./index.ts";
import { longTermMemoryProvider } from "./providers/index.ts";
import { MemoryService } from "./services/memory-service.ts";

function makeRuntime(service?: MemoryService): {
	runtime: IAgentRuntime;
	getService: ReturnType<typeof vi.fn>;
} {
	const getService = vi.fn().mockReturnValue(service);
	return { runtime: { getService } as unknown as IAgentRuntime, getService };
}

describe("createAdvancedMemoryPlugin", () => {
	it("names the plugin and describes the capability", () => {
		const plugin = createAdvancedMemoryPlugin();
		expect(plugin.name).toBe("memory");
		expect(typeof plugin.description).toBe("string");
		expect(plugin.description?.length).toBeGreaterThan(0);
	});

	it("registers the real MemoryService class, provider, and evaluator bundle", () => {
		const plugin = createAdvancedMemoryPlugin();
		expect(plugin.services).toEqual([MemoryService]);
		expect(plugin.providers).toEqual([longTermMemoryProvider]);
		expect(plugin.evaluators).toBe(memoryItems);
		expect(memoryItems).toContain(longTermMemoryEvaluator);
	});

	it("passes the loader's own shape and validation gates", () => {
		const plugin = createAdvancedMemoryPlugin();
		expect(isValidPluginShape(plugin)).toBe(true);
		const verdict = validatePlugin(plugin);
		expect(verdict.isValid).toBe(true);
		expect(verdict.errors).toEqual([]);
	});

	it("stops the registered MemoryService on dispose, looked up by serviceType", async () => {
		const stop = vi.fn().mockResolvedValue(undefined);
		const svc = { stop } as unknown as MemoryService;
		const { runtime, getService } = makeRuntime(svc);
		const plugin = createAdvancedMemoryPlugin();

		await plugin.dispose?.(runtime);

		expect(getService).toHaveBeenCalledTimes(1);
		expect(getService).toHaveBeenCalledWith(MemoryService.serviceType);
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("resolves without stopping anything when no MemoryService is registered", async () => {
		const { runtime, getService } = makeRuntime(undefined);
		const plugin = createAdvancedMemoryPlugin();

		await expect(plugin.dispose?.(runtime)).resolves.toBeUndefined();
		expect(getService).toHaveBeenCalledWith(MemoryService.serviceType);
	});

	it("propagates a failing stop instead of swallowing it", async () => {
		const boom = new Error("storage teardown failed");
		const svc = {
			stop: vi.fn().mockRejectedValue(boom),
		} as unknown as MemoryService;
		const { runtime } = makeRuntime(svc);
		const plugin = createAdvancedMemoryPlugin();

		await expect(plugin.dispose?.(runtime)).rejects.toBe(boom);
	});
});
