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
			[TRACE_ENV.SESSION_ID]: "session-456",
			[TRACE_ENV.PARENT_STEP_ID]: "step-9",
		} as NodeJS.ProcessEnv;
		expect(resolveTraceCorrelationFromEnv(env)).toEqual({
			traceId: "trace-123",
			taskId: "task-abc",
			sessionId: "session-456",
			parentStepId: "step-9",
		});
	});

	it("trims and drops blank values so an empty env var never reads as present", () => {
		const env = {
			[TRACE_ENV.TRACE_ID]: "  trace-x  ",
			[TRACE_ENV.TASK_ID]: "   ",
			[TRACE_ENV.SESSION_ID]: "  session-x  ",
		} as NodeJS.ProcessEnv;
		const out = resolveTraceCorrelationFromEnv(env);
		expect(out.traceId).toBe("trace-x");
		expect(out.sessionId).toBe("session-x");
		expect("taskId" in out).toBe(false);
	});

	it("names the spawn-managed session marker for the generic orchestrator", () => {
		expect(TRACE_ENV.SESSION_ID).toBe("ORCHESTRATOR_SESSION_ID");
	});
});
