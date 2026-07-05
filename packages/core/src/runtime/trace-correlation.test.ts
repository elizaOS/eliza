/**
 * Env round-trip for the correlation envelope (#13775): what the orchestrator
 * stamps on a sub-agent's env is what the child resolves back. Pure — synthetic
 * env in, partial envelope out.
 */

import { describe, expect, it } from "vitest";
import { resolveTraceCorrelationFromEnv, TRACE_ENV } from "./trace-correlation";

describe("resolveTraceCorrelationFromEnv", () => {
	it("returns an empty envelope for a root turn (no trace env)", () => {
		expect(resolveTraceCorrelationFromEnv({} as NodeJS.ProcessEnv)).toEqual({});
	});

	it("reads the stamped envelope a spawner set", () => {
		const env = {
			[TRACE_ENV.TRACE_ID]: "trace-123",
			[TRACE_ENV.TASK_ID]: "task-abc",
			[TRACE_ENV.PARENT_STEP_ID]: "step-9",
		} as NodeJS.ProcessEnv;
		expect(resolveTraceCorrelationFromEnv(env)).toEqual({
			traceId: "trace-123",
			taskId: "task-abc",
			parentStepId: "step-9",
		});
	});

	it("trims and drops blank values so an empty env var never reads as present", () => {
		const env = {
			[TRACE_ENV.TRACE_ID]: "  trace-x  ",
			[TRACE_ENV.TASK_ID]: "   ",
		} as NodeJS.ProcessEnv;
		const out = resolveTraceCorrelationFromEnv(env);
		expect(out.traceId).toBe("trace-x");
		expect("taskId" in out).toBe(false);
	});
});
