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

describe("action-handler-settlement additional branches", () => {
	function makeAppliedReceipt(): Record<string, unknown> {
		return {
			receiptId: "receipt-1",
			operation: "test.thing.create",
			resource: { kind: "test.thing", id: "thing-1" },
			artifacts: [],
			idempotency: { key: null, replayed: false },
			observedAt: "2026-08-24T00:00:00Z",
			outcome: "applied",
			commit: {
				kind: "durable",
				id: "commit-1",
				committedAt: "2026-08-24T00:00:00Z",
			},
		};
	}

	function makeAction(tags?: string[]): Action {
		return {
			name: "SETTLE_ACTION",
			description: "Settle action",
			similes: [],
			examples: [],
			handler: vi.fn(),
			validate: vi.fn(),
			tags,
		};
	}

	describe("normalizeActionResult", () => {
		it("rejects array returns as non-plain objects", () => {
			expect(() => normalizeActionResult("TEST_ACTION", ["x"])).toThrowError(
				ElizaError,
			);
		});

		it("rejects a non-boolean success field", () => {
			expect(() =>
				normalizeActionResult("TEST_ACTION", { success: "yes" }),
			).toThrowError(ElizaError);
		});

		it("rejects failureProvenance carried by successful results", () => {
			expect(() =>
				normalizeActionResult("TEST_ACTION", {
					success: true,
					failureProvenance: {
						kind: "handler_error",
						boundary: "handler",
						code: "X",
						retryable: true,
					},
				}),
			).toThrowError(ElizaError);
		});

		it("converts number returns into successful text results", () => {
			expect(normalizeActionResult("TEST_ACTION", 42)).toEqual({
				success: true,
				text: "42",
				data: { actionName: "TEST_ACTION" },
			});
		});

		it("replaces a non-object data payload with executor-owned data", () => {
			const res = normalizeActionResult("TEST_ACTION", {
				success: true,
				data: "junk",
			});

			expect(res.data).toEqual({ actionName: "TEST_ACTION" });
		});

		it("lets the executor override a spoofed data.actionName", () => {
			const res = normalizeActionResult("TEST_ACTION", {
				success: true,
				data: { actionName: "SPOOFED", keep: "yes" },
			});

			expect(res.data?.actionName).toBe("TEST_ACTION");
			expect(res.data?.keep).toBe("yes");
		});

		it("preserves valid failureProvenance on failed results", () => {
			const res = normalizeActionResult("TEST_ACTION", {
				success: false,
				failureProvenance: {
					kind: "persistence_error",
					boundary: "persistence",
					code: "DB_DOWN",
					retryable: true,
				},
			});

			expect(res.failureProvenance).toEqual({
				kind: "persistence_error",
				boundary: "persistence",
				code: "DB_DOWN",
				retryable: true,
			});
		});

		it("normalizes and canonicalizes effect receipts onto the result", () => {
			const res = normalizeActionResult("TEST_ACTION", {
				success: true,
				effectReceipts: [makeAppliedReceipt()],
			});

			const receipts = res.effectReceipts ?? [];
			expect(receipts).toHaveLength(1);
			expect(receipts[0]?.receiptId).toBe("receipt-1");
			expect(receipts[0]?.outcome).toBe("applied");
			expect(receipts[0]?.observedAt).toBe("2026-08-24T00:00:00.000Z");
		});
	});

	describe("actionFailureResult provenance", () => {
		it("carries structural provenance when supplied", () => {
			const res = actionFailureResult(
				"SEND_MSG",
				"Provider rejected",
				{ retries: 2 },
				{
					kind: "handler_error",
					boundary: "handler",
					code: "PROVIDER_REJECTED",
					retryable: false,
				},
			);

			expect(res.success).toBe(false);
			expect(res.failureProvenance).toEqual({
				kind: "handler_error",
				boundary: "handler",
				code: "PROVIDER_REJECTED",
				retryable: false,
			});
			expect(res.data).toEqual({ retries: 2, actionName: "SEND_MSG" });
		});
	});

	describe("settleActionHandler failure boundaries", () => {
		it("rethrows the original handler error under rethrow mode", async () => {
			const runtime = makeMockRuntime();
			const original = new RangeError("original boom");
			let caught: unknown;

			try {
				await settleActionHandler({
					runtime,
					action: makeAction(),
					handlerError: "rethrow",
					invoke: async () => {
						throw original;
					},
				});
			} catch (error) {
				caught = error;
			}

			expect(caught).toBe(original);
		});

		it("discards buffered callbacks when the handler fails", async () => {
			const runtime = makeMockRuntime();
			const callback = vi.fn().mockResolvedValue([]);
			const result = await settleActionHandler({
				runtime,
				action: makeAction(),
				callback,
				invoke: async (cb) => {
					if (cb) await cb({ text: "pre-failure reply" });
					throw new Error("kaboom");
				},
			});

			expect(result.success).toBe(false);
			expect(result.text).toBe("kaboom");
			expect(callback).not.toHaveBeenCalled();
		});

		it("returns a reconciliation failure when normalization fails after the handler ran", async () => {
			const runtime = makeMockRuntime();
			const result = await settleActionHandler({
				runtime,
				action: makeAction(),
				invoke: async () => new Error("not a plain result"),
			});

			expect(result.success).toBe(false);
			expect(result.text).toBe(
				"Action completed with an invalid result. Its external outcome is unknown and must be reconciled before retrying.",
			);
			expect(result.failureProvenance).toEqual({
				kind: "handler_error",
				boundary: "handler",
				code: "ACTION_RESULT_INVALID_AFTER_HANDLER",
				retryable: false,
			});

			const data = (result.data ?? {}) as Record<string, unknown>;
			expect(data.outcomeUnknown).toBe(true);
			expect(data.retryable).toBe(false);
			expect(data.reconciliationRequired).toBe(true);
		});

		it("throws ACTION_RESULT_INVALID_AFTER_HANDLER under rethrow mode", async () => {
			const runtime = makeMockRuntime();
			let caught: unknown;

			try {
				await settleActionHandler({
					runtime,
					action: makeAction(),
					handlerError: "rethrow",
					invoke: async () => new Error("not a plain result"),
				});
			} catch (error) {
				caught = error;
			}

			expect(caught).toBeInstanceOf(ElizaError);
			const elizaCaught = caught as ElizaError;
			expect(elizaCaught.code).toBe("ACTION_RESULT_INVALID_AFTER_HANDLER");
			expect(elizaCaught.cause).toBeInstanceOf(ElizaError);
			expect((elizaCaught.cause as ElizaError).code).toBe(
				"INVALID_ACTION_RESULT",
			);
		});
	});

	describe("settleActionHandler callback delivery", () => {
		it("records callback delivery failures and reports them to the runtime", async () => {
			const runtime = makeMockRuntime();
			const callback = vi.fn().mockRejectedValue(new Error("transport down"));
			const result = await settleActionHandler({
				runtime,
				action: makeAction(),
				callback,
				invoke: async (cb) => {
					if (cb) await cb({ text: "hello" });
					return { success: true };
				},
			});

			expect(result.success).toBe(true);
			const data = (result.data ?? {}) as Record<string, unknown>;
			expect(data.callbackDeliveryFailures).toEqual(["transport down"]);
			expect(runtime.reportError).toHaveBeenCalledWith(
				"ActionCallbackDelivery",
				expect.any(Error),
				expect.objectContaining({ actionName: "SETTLE_ACTION" }),
			);
		});

		it("falls back to logger.error when reportError itself throws", async () => {
			const runtime = makeMockRuntime();
			runtime.reportError = (() => {
				throw new Error("ring broken");
			}) as typeof runtime.reportError;
			const callback = vi.fn().mockRejectedValue(new Error("transport down"));
			const result = await settleActionHandler({
				runtime,
				action: makeAction(),
				callback,
				invoke: async (cb) => {
					if (cb) await cb({ text: "hello" });
					return { success: true };
				},
			});

			expect(result.success).toBe(true);
			expect(runtime.logger.error).toHaveBeenCalledWith(
				expect.objectContaining({ src: "action-handler-settlement" }),
				"Action callback delivery and error reporting both failed",
			);
		});

		it("logs delivery failures directly when the runtime lacks reportError", async () => {
			const runtime = makeMockRuntime();
			delete (runtime as { reportError?: unknown }).reportError;
			const callback = vi.fn().mockRejectedValue(new Error("transport down"));
			const result = await settleActionHandler({
				runtime,
				action: makeAction(),
				callback,
				invoke: async (cb) => {
					if (cb) await cb({ text: "hello" });
					return { success: true };
				},
			});

			expect(result.success).toBe(true);
			expect(runtime.logger.error).toHaveBeenCalledWith(
				expect.objectContaining({ src: "action-handler-settlement" }),
				"Action callback delivery failed after the handler settled",
			);
		});

		it("strips untrusted effectReceiptIds from read-only deliveries", async () => {
			const runtime = makeMockRuntime();
			const callback = vi.fn().mockResolvedValue([]);
			await settleActionHandler({
				runtime,
				action: makeAction(),
				callback,
				invoke: async (cb) => {
					if (cb) await cb({ text: "hi", effectReceiptIds: ["spoof"] });
					return { success: true };
				},
			});

			const delivered = callback.mock.calls[0]?.[0] as {
				text?: string;
				effectReceiptIds?: string[];
			};
			expect(delivered.text).toBe("hi");
			expect(delivered.effectReceiptIds).toBeUndefined();
		});

		it("leaves callbacks unvoiced when their text differs from verified canonical text", async () => {
			const runtime = makeMockRuntime();
			const callback = vi.fn().mockResolvedValue([]);
			await settleActionHandler({
				runtime,
				action: makeAction(),
				callback,
				invoke: async (cb) => {
					if (cb) await cb({ text: "different wording" });
					return {
						success: true,
						userFacingText: "canonical words",
						verifiedUserFacing: true,
					};
				},
			});

			const delivered = callback.mock.calls[0]?.[0] as {
				text?: string;
				agentVoiced?: boolean;
			};
			expect(delivered.text).toBe("different wording");
			expect(delivered.agentVoiced).toBeUndefined();
		});

		it("suppresses mutation-contract callbacks whose text drifts from canonical", async () => {
			const runtime = makeMockRuntime();
			const callback = vi.fn().mockResolvedValue([]);
			const result = await settleActionHandler({
				runtime,
				action: makeAction(["effect:receipt-required"]),
				callback,
				invoke: async (cb) => {
					if (cb) await cb({ text: "a paraphrased confirmation" });
					return {
						success: true,
						userFacingText: "Created thing thing-1",
						verifiedUserFacing: true,
						effectReceipts: [makeAppliedReceipt()],
						userFacingEffectReceiptIds: ["receipt-1"],
					};
				},
			});

			expect(result.success).toBe(true);
			expect(callback).not.toHaveBeenCalled();
			expect(runtime.logger.warn).toHaveBeenCalledWith(
				expect.objectContaining({ src: "action-handler-settlement" }),
				"Suppressed an action callback that was not bound to canonical effect receipts",
			);
		});

		it("binds exact canonical text to receipts and marks the callback agent-voiced", async () => {
			const runtime = makeMockRuntime();
			const callback = vi.fn().mockResolvedValue([]);
			const result = await settleActionHandler({
				runtime,
				action: makeAction(["effect:receipt-required"]),
				callback,
				invoke: async (cb) => {
					if (cb) await cb({ text: "Created thing thing-1" });
					return {
						success: true,
						userFacingText: "Created thing thing-1",
						verifiedUserFacing: true,
						effectReceipts: [makeAppliedReceipt()],
						userFacingEffectReceiptIds: ["receipt-1"],
					};
				},
			});

			expect(result.success).toBe(true);
			expect(callback).toHaveBeenCalledTimes(1);
			const delivered = callback.mock.calls[0]?.[0] as {
				text?: string;
				agentVoiced?: boolean;
				effectReceiptIds?: string[];
			};
			expect(delivered.text).toBe("Created thing thing-1");
			expect(delivered.agentVoiced).toBe(true);
			expect(delivered.effectReceiptIds).toEqual(["receipt-1"]);
		});

		it("delivers identical receipt-bound callbacks only once per turn", async () => {
			const runtime = makeMockRuntime();
			const callback = vi.fn().mockResolvedValue([]);
			const result = await settleActionHandler({
				runtime,
				action: makeAction(["effect:receipt-required"]),
				callback,
				invoke: async (cb) => {
					if (cb) {
						await cb({ text: "Created thing thing-1" });
						await cb({ text: "Created thing thing-1" });
					}
					return {
						success: true,
						userFacingText: "Created thing thing-1",
						verifiedUserFacing: true,
						effectReceipts: [makeAppliedReceipt()],
						userFacingEffectReceiptIds: ["receipt-1"],
					};
				},
			});

			expect(result.success).toBe(true);
			expect(callback).toHaveBeenCalledTimes(1);
		});

		it("warns when a mutating action has not migrated to the receipt contract yet", async () => {
			const runtime = makeMockRuntime();
			const callback = vi.fn().mockResolvedValue([]);
			const result = await settleActionHandler({
				runtime,
				action: makeAction(["capability:write"]),
				callback,
				invoke: async (cb) => {
					if (cb) await cb({ text: "done" });
					return { success: true };
				},
			});

			expect(result.success).toBe(true);
			expect(runtime.logger.warn).toHaveBeenCalledWith(
				expect.objectContaining({ action: "SETTLE_ACTION" }),
				"Mutation-capable action has not migrated to the effect receipt contract",
			);
			expect(callback).toHaveBeenCalledTimes(1);
		});

		it("delivers callbacks invoked directly after settlement", async () => {
			const runtime = makeMockRuntime();
			const callback = vi.fn().mockResolvedValue([]);
			let capturedCb:
				| ((response: { text: string }) => Promise<unknown>)
				| undefined;
			await settleActionHandler({
				runtime,
				action: makeAction(),
				callback,
				invoke: async (cb) => {
					capturedCb = cb as typeof capturedCb;
					return { success: true };
				},
			});

			expect(capturedCb).toBeDefined();
			if (capturedCb) await capturedCb({ text: "late reply" });

			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback.mock.calls[0]?.[0]).toEqual(
				expect.objectContaining({ text: "late reply" }),
			);
		});
	});
});
