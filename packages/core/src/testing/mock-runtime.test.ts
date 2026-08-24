/**
 * Unit tests for mock-runtime factory: validates default mock agent id,
 * character structure, services and state maps, and override propagation.
 */
import { describe, expect, it } from "vitest";
import { createMockRuntime, MOCK_AGENT_ID } from "./mock-runtime.ts";

describe("mock-runtime", () => {
	it("provides stable mock agent id constant", () => {
		expect(MOCK_AGENT_ID).toBe("00000000-0000-0000-0000-000000000000");
	});

	it("creates default mock runtime with required structural fields", () => {
		const runtime = createMockRuntime();

		expect(runtime.agentId).toBe(MOCK_AGENT_ID);
		expect(runtime.character.name).toBe("MockAgent");
		expect(Array.isArray(runtime.providers)).toBe(true);
		expect(Array.isArray(runtime.actions)).toBe(true);
		expect(Array.isArray(runtime.evaluators)).toBe(true);
		expect(Array.isArray(runtime.plugins)).toBe(true);
		expect(runtime.services instanceof Map).toBe(true);
		expect(runtime.stateCache instanceof Map).toBe(true);
	});

	it("applies overrides correctly", () => {
		const customAgentId = "11111111-1111-1111-1111-111111111111" as any;
		const runtime = createMockRuntime({
			agentId: customAgentId,
			getSetting: (k) => (k === "CUSTOM_KEY" ? "custom_value" : undefined),
		});

		expect(runtime.agentId).toBe(customAgentId);
		expect(runtime.getSetting("CUSTOM_KEY")).toBe("custom_value");
		expect(runtime.getSetting("UNKNOWN")).toBeUndefined();
	});
});
