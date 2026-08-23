/**
 * Unit tests for action handler settlement boundary, ActionResult normalization, and error handling.
 */

import { describe, expect, it, vi } from "vitest";
import { ElizaError } from "../errors.js";
import type { Action, IAgentRuntime } from "../types.js";
import {
	actionFailureResult,
	normalizeActionResult,
	settleActionHandler,
	stringifyActionError,
} from "./action-handler-settlement.js";

function makeMockRuntime(): IAgentRuntime {
	return {
		agentId: "test-agent",
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		reportError: vi.fn(),
	} as unknown as IAgentRuntime;
}

describe("action-handler-settlement", () => {
	describe("normalizeActionResult", () => {
		it("normalizes boolean and nullish returns", () => {
			expect(normalizeActionResult("TEST_ACTION", true)).toEqual({
				success: true,
				data: { actionName: "TEST_ACTION" },
			});

			expect(normalizeActionResult("TEST_ACTION", false)).toEqual({
				success: false,
				data: { actionName: "TEST_ACTION" },
			});

			expect(normalizeActionResult("TEST_ACTION", null)).toEqual({
				success: true,
				data: { actionName: "TEST_ACTION" },
			});

			expect(normalizeActionResult("TEST_ACTION", undefined)).toEqual({
				success: true,
				data: { actionName: "TEST_ACTION" },
			});
		});

		it("normalizes primitive text returns", () => {
			expect(normalizeActionResult("TEST_ACTION", "done")).toEqual({
				success: true,
				text: "done",
				data: { actionName: "TEST_ACTION" },
			});
		});

		it("normalizes plain ActionResult object returns", () => {
			const res = normalizeActionResult("TEST_ACTION", {
				success: true,
				values: { count: 5 },
			});

			expect(res.success).toBe(true);
			expect(res.values).toEqual({ count: 5 });
			expect(res.data).toEqual({ actionName: "TEST_ACTION" });
		});

		it("throws ElizaError on invalid non-plain object returns", () => {
			expect(() =>
				normalizeActionResult("TEST_ACTION", new Error("some error")),
			).toThrowError(ElizaError);
		});
	});

	describe("actionFailureResult and stringifyActionError", () => {
		it("constructs failure ActionResult with error message and actionName", () => {
			const failRes = actionFailureResult("SEND_MSG", "Network failure", {
				retries: 2,
			});

			expect(failRes.success).toBe(false);
			expect(failRes.text).toBe("Network failure");
			expect(failRes.error).toBe("Network failure");
			expect(failRes.data).toEqual({
				retries: 2,
				actionName: "SEND_MSG",
			});
		});

		it("stringifies errors and non-error objects", () => {
			expect(stringifyActionError(new Error("custom error"))).toBe(
				"custom error",
			);
			expect(stringifyActionError("plain string error")).toBe(
				"plain string error",
			);
			expect(stringifyActionError(404)).toBe("404");
		});
	});

	describe("settleActionHandler", () => {
		it("settles handler execution and invokes callback upon completion", async () => {
			const runtime = makeMockRuntime();
			const action: Action = {
				name: "TEST_ACTION",
				description: "Test action",
				similes: [],
				examples: [],
				handler: vi.fn(),
				validate: vi.fn(),
			};

			const mockCallback = vi.fn().mockResolvedValue([]);

			const result = await settleActionHandler({
				runtime,
				action,
				callback: mockCallback,
				invoke: async (cb) => {
					if (cb) {
						await cb({ text: "Action executed" });
					}
					return { success: true };
				},
			});

			expect(result.success).toBe(true);
			expect(mockCallback).toHaveBeenCalledWith(
				expect.objectContaining({ text: "Action executed" }),
				"TEST_ACTION",
			);
		});

		it("catches handler exceptions and returns actionFailureResult", async () => {
			const runtime = makeMockRuntime();
			const action: Action = {
				name: "FAIL_ACTION",
				description: "Fail action",
				similes: [],
				examples: [],
				handler: vi.fn(),
				validate: vi.fn(),
			};

			const result = await settleActionHandler({
				runtime,
				action,
				invoke: async () => {
					throw new Error("Handler exploded");
				},
			});

			expect(result.success).toBe(false);
			expect(result.text).toBe("Handler exploded");
		});
	});
});
