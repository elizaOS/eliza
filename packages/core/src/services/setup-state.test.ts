/**
 * Unit tests for setup state machine transitions, step validations, serialization, and summaries.
 */

import { describe, expect, it, vi } from "vitest";
import { SetupStep } from "../types/setup.js";
import {
	createSetupStateMachine,
	getSetupSummary,
	isSetupComplete,
	SetupStateMachine,
} from "./setup-state.js";

describe("setup-state", () => {
	it("initializes state machine at WELCOME step and transitions through flow", async () => {
		const onStepChange = vi.fn();
		const onComplete = vi.fn();

		const sm = new SetupStateMachine({
			platform: "cli",
			mode: "cli",
			onStepChange,
			onComplete,
		});

		expect(sm.getCurrentStep()).toBe(SetupStep.WELCOME);
		expect(sm.canAdvance()).toBe(true);

		// 1. Advance WELCOME
		const res1 = await sm.advanceStep({
			step: SetupStep.WELCOME,
			data: { acknowledged: true, userName: "Alice" },
		});
		expect(res1.success).toBe(true);
		expect(res1.newStep).toBe(SetupStep.RISK_ACK);
		expect(sm.getCurrentStep()).toBe(SetupStep.RISK_ACK);

		// 2. Advance RISK_ACK
		const res2 = await sm.advanceStep({
			step: SetupStep.RISK_ACK,
			data: { accepted: true },
		});
		expect(res2.success).toBe(true);
		expect(res2.newStep).toBe(SetupStep.AUTH);

		// 3. Skip AUTH
		const res3 = await sm.skipStep();
		expect(res3.success).toBe(true);
		expect(res3.newStep).toBe(SetupStep.CHANNELS);

		// 4. Skip CHANNELS
		const res4 = await sm.skipStep();
		expect(res4.success).toBe(true);
		expect(res4.newStep).toBe(SetupStep.SKILLS);

		// 5. Complete SKILLS
		const res5 = await sm.advanceStep({
			step: SetupStep.SKILLS,
			data: { skills: ["test-skill"], install: [] },
		});
		expect(res5.success).toBe(true);
		expect(res5.isComplete).toBe(true);
		expect(sm.getCurrentStep()).toBe(SetupStep.COMPLETE);
		expect(onComplete).toHaveBeenCalled();
	});

	it("handles step mismatch and validation errors gracefully", async () => {
		const onError = vi.fn();
		const sm = createSetupStateMachine({
			platform: "chat",
			onError,
		});

		// Attempting to advance AUTH while at WELCOME
		const res = await sm.advanceStep({
			step: SetupStep.AUTH,
			data: { method: "api_key", apiKey: "key-1234567890" },
		});

		expect(res.success).toBe(false);
		expect(res.error?.code).toBe("STEP_MISMATCH");
		expect(onError).toHaveBeenCalled();
	});

	it("supports goBack and step rewinds", async () => {
		const sm = new SetupStateMachine({
			platform: "cli",
			mode: "cli",
		});

		await sm.advanceStep({
			step: SetupStep.WELCOME,
			data: { acknowledged: true },
		});
		expect(sm.getCurrentStep()).toBe(SetupStep.RISK_ACK);

		const backRes = sm.goBack();
		expect(backRes.success).toBe(true);
		expect(backRes.newStep).toBe(SetupStep.WELCOME);
		expect(sm.getCurrentStep()).toBe(SetupStep.WELCOME);
	});

	it("serializes to JSON and restores from JSON", async () => {
		const sm1 = new SetupStateMachine({
			platform: "cli",
			mode: "cli",
		});

		await sm1.advanceStep({
			step: SetupStep.WELCOME,
			data: { acknowledged: true, userName: "Bob" },
		});

		const serialized = sm1.toJSON();
		const sm2 = SetupStateMachine.fromJSON(serialized, {
			platform: "cli",
			mode: "cli",
		});

		expect(sm2.getCurrentStep()).toBe(SetupStep.RISK_ACK);
		expect(sm2.getContext().metadata?.userName).toBe("Bob");
	});

	it("formats setup summary correctly", () => {
		const sm = new SetupStateMachine({ platform: "cli", mode: "cli" });
		const summary = getSetupSummary(sm.getContext());
		expect(summary).toContain("Setup Progress:");
		expect(summary).toContain("Current Step:");
		expect(isSetupComplete(sm.getContext())).toBe(false);
	});
});
