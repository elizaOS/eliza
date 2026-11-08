/**
 * trajectoryToPlaintext tolerates malformed persisted steps and reads one
 * source of steps for a run.
 */
import { describe, expect, it } from "vitest";
import { trajectoryToPlaintext } from "../src/activity-plaintext.ts";

describe("trajectoryToPlaintext", () => {
	it("skips a null step in stepsJson instead of throwing", () => {
		const text = trajectoryToPlaintext({
			id: "t1",
			status: "completed",
			stepsJson: JSON.stringify([
				null,
				{ llmCalls: [null, { callId: "c1", purpose: "plan" }] },
			]),
		} as never);
		expect(text).toContain("llm calls: 1");
		expect(text).toContain("LLM call c1: plan");
		expect(text).not.toContain("steps unavailable");
	});

	it("counts a run once when it has both steps and stepsJson", () => {
		const steps = [
			{ llmCalls: [{ callId: "c1", purpose: "plan" }] },
			{ llmCalls: [{ callId: "c2", purpose: "reply" }] },
		];
		const text = trajectoryToPlaintext({
			id: "t2",
			status: "completed",
			steps,
			stepsJson: JSON.stringify(steps),
		} as never);
		expect(text).toContain("llm calls: 2");
		expect(text.match(/LLM call c1/g)).toHaveLength(1);
	});
});
