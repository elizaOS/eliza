/**
 * Verifies lifecycle ownership for native adapters that hosts construct before
 * runtime initialization, including duplicate rejection and shutdown cleanup.
 */
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../runtime";

describe("AgentRuntime.registerServiceInstance", () => {
	it("makes a started adapter discoverable and stops it with the runtime", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		let stopCalls = 0;
		const adapter = {
			capabilityDescription: "Test native adapter",
			async stop() {
				stopCalls += 1;
			},
		};

		runtime.registerServiceInstance("test_native_adapter", adapter);

		expect(runtime.getService("test_native_adapter")).toBe(adapter);
		expect(runtime.hasService("test_native_adapter")).toBe(true);
		expect(runtime.getRegisteredServiceTypes()).toContain(
			"test_native_adapter",
		);
		expect(runtime.getServiceRegistrationStatus("test_native_adapter")).toBe(
			"registered",
		);
		expect(await runtime.getServiceLoadPromise("test_native_adapter")).toBe(
			adapter,
		);

		await runtime.stop();
		expect(stopCalls).toBe(1);
	});

	it("rejects malformed and duplicate started adapters", () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		const adapter = {
			capabilityDescription: "Test native adapter",
			stop() {},
		};

		expect(() =>
			runtime.registerServiceInstance("malformed_native_adapter", {} as never),
		).toThrow("must provide capabilityDescription and stop()");
		runtime.registerServiceInstance("test_native_adapter", adapter);
		expect(() =>
			runtime.registerServiceInstance("test_native_adapter", adapter),
		).toThrow("already registered");
	});
});
