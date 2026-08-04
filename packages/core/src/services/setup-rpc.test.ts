/**
 * Exercises setup RPC success and failure response variants against the real
 * in-memory setup state machine.
 */
import { describe, expect, it } from "vitest";

import { SetupStep } from "../types/setup.ts";
import { createSetupRPCService } from "./setup-rpc.ts";

describe("SetupRPCService response contracts", () => {
	it("returns real state for a created session", async () => {
		const service = createSetupRPCService();
		const result = await service.start({ platform: "test" });

		expect(result.success).toBe(true);
		if (!result.success) throw new Error(result.error);
		expect(result.sessionId).not.toBe("");
		expect(result.state.currentStep).toBeDefined();
	});

	it("does not fabricate state for an unknown session", async () => {
		const service = createSetupRPCService();
		const result = await service.step({
			sessionId: "missing-session",
			input: { step: SetupStep.WELCOME, data: { acknowledged: true } },
		});

		expect(result).toEqual({
			success: false,
			error: "Session not found: missing-session",
		});
	});
});
