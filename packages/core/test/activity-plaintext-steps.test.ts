/**
 * trajectoryToPlaintext reads steps from one source and skips malformed
 * step entries instead of throwing.
 */
import { describe, expect, it } from "vitest";
import { trajectoryToPlaintext } from "../src/activity-plaintext.ts";

describe("trajectoryToPlaintext steps", () => {
	it("renders a stepsJson with a null element", () => {
		const text = trajectoryToPlaintext({
			id: "t1",
			status: "completed",
			stepsJson: JSON.stringify([
				null,
				{ llmCalls: [null, { callId: "c1", purpose: "plan" }] },
			]),
		} as never);
		expect(text).toContain("llm calls: 1");
		expect(text).toContain("- LLM call c1: plan");
		expect(text).not.toContain("steps unavailable");
	});

	it("counts a record with both steps and stepsJson once", () => {
		const steps = [{ llmCalls: [{ callId: "c1", purpose: "plan" }] }];
		const text = trajectoryToPlaintext({
			id: "t2",
			status: "completed",
			steps,
			stepsJson: JSON.stringify(steps),
		} as never);
		expect(text).toContain("llm calls: 1");
		expect(text.match(/LLM call c1/g)).toHaveLength(1);
	});
});
