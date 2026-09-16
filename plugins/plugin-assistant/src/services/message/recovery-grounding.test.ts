/** Exercises actual recovery and receipt validation with controlled model verdicts. */
import { describe, expect, it, vi } from "vitest";
import { hashString } from "../../../../../packages/core/src/runtime/context-hash";
import { createMockRuntime } from "@elizaos/testing/mock-runtime";
import type { ActionResult, Memory } from "@elizaos/core";
import { resolvePlannedReplyEgress } from "./egress-policy";

const message: Memory = {
	id: "00000000-0000-4000-8000-000000000001",
	roomId: "00000000-0000-4000-8000-000000000002",
	entityId: "00000000-0000-4000-8000-000000000003",
	content: { text: "Delete the dentist appointment from my calendar." },
};
const rejectedReply = "Deleted your dentist appointment from the calendar.";
const approved = {
	grounded: true,
	completedChangeClaim: false,
	reason: "The evidence supports the uncertainty or observation.",
};

describe("semantic recovery grounding", () => {
	it("rejects fabricated receipt metadata even when the reviewer accepts uncertainty", async () => {
		const useModel = vi
			.fn()
			.mockResolvedValueOnce(
				JSON.stringify({
					response: "I could not verify the outcome.",
					effectReceiptIds: ["stale-id"],
				}),
			)
			.mockResolvedValueOnce(JSON.stringify(approved));
		await expect(
			resolvePlannedReplyEgress({
				runtime: createMockRuntime({ useModel }),
				message,
				reply: rejectedReply,
				actionResults: [],
			}),
		).rejects.toMatchObject({ code: "REPLY_GROUNDING_FAILED" });
	});

	it.each(["unavailable", "revoked"])(
		"does not deliver or execute effects after review %s",
		async (failure) => {
			const full = "Complete authorized original context.";
			const selected = "Selected original.";
			const useModel = vi.fn().mockResolvedValueOnce(
				JSON.stringify({
					response: "I cannot verify the outcome.",
					effectReceiptIds: [],
				}),
			);
			if (failure === "unavailable")
				useModel.mockRejectedValueOnce(new Error("Model unavailable"));
			else
				useModel.mockResolvedValueOnce(
					JSON.stringify({ contextRequest: "full" }),
				);
			const processActions = vi.fn();
			const runtime = createMockRuntime({ useModel, processActions });
			const beforeContextRestore = vi.fn(async () => {
				throw new Error("Recovery audience revoked");
			});
			const pending = resolvePlannedReplyEgress({
				runtime,
				message,
				reply: rejectedReply,
				actionResults: [],
				recovery: {
					context: full,
					historySelection: {
						context: selected,
						contextHash: hashString(selected),
						fullContextHash: hashString(full),
					},
					pendingToolCalls: [],
					evaluatorOutputs: [],
					ownerExclusiveDisclosureUsed: false,
				},
				beforeContextRestore,
			});
			if (failure === "unavailable")
				await expect(pending).rejects.toMatchObject({
					code: "REPLY_GROUNDING_REVIEW_FAILED",
				});
			else await expect(pending).rejects.toThrow("Recovery audience revoked");
			expect(useModel).toHaveBeenCalledTimes(2);
			expect(processActions).not.toHaveBeenCalled();
			expect(beforeContextRestore).toHaveBeenCalledTimes(
				failure === "revoked" ? 1 : 0,
			);
		},
	);
	it.each([
		{ grounded: false, completedChangeClaim: false },
		{ grounded: false, completedChangeClaim: true },
		{ grounded: true, completedChangeClaim: true },
	])(
		"rejects unsupported outcomes or missing mutation proof: %j",
		async ({ grounded, completedChangeClaim }) => {
			const useModel = vi
				.fn()
				.mockResolvedValueOnce(
					JSON.stringify({
						response: "The event is gone.",
						effectReceiptIds: [],
					}),
				)
				.mockResolvedValueOnce(
					JSON.stringify({
						grounded,
						completedChangeClaim,
						reason:
							"The reply asserts deletion, but there is no applied receipt.",
					}),
				);
			const runtime = createMockRuntime({ useModel });
			await expect(
				resolvePlannedReplyEgress({
					runtime,
					message,
					reply: rejectedReply,
					actionResults: [],
				}),
			).rejects.toMatchObject({ code: "REPLY_GROUNDING_FAILED" });
			expect(useModel).toHaveBeenCalledTimes(2);
		},
	);
	it.each([
		"I could not verify whether the appointment was deleted.",
		"The calendar read returned no matching appointment. Deletion is unverified.",
		'Yesterday you wrote "the event is gone". I have not verified its current state.',
	])(
		"preserves supported uncertainty, read observations and historical quotations: %s",
		async (response) => {
			const useModel = vi
				.fn()
				.mockResolvedValueOnce(
					JSON.stringify({ response, effectReceiptIds: [] }),
				)
				.mockResolvedValueOnce(JSON.stringify(approved));
			const runtime = createMockRuntime({ useModel });
			const results: ActionResult[] = [
				{
					success: true,
					data: {
						actionName: "CALENDAR_READ",
						readOnlyOperation: true,
						items: [],
					},
				},
			];
			const recovery = {
				context:
					'Yesterday the user wrote "the event is gone". This is historical dialogue, not current calendar state.',
				pendingToolCalls: [],
				evaluatorOutputs: [],
				ownerExclusiveDisclosureUsed: false,
			};
			await expect(
				resolvePlannedReplyEgress({
					runtime,
					message,
					reply: rejectedReply,
					actionResults: results,
					recovery,
				}),
			).resolves.toEqual({ text: response, effectReceiptIds: [] });
		},
	);
	it.each([false, true])(
		"revalidates applied receipt binding after context restoration: revoked=%s",
		async (revoked) => {
			const response = "The event is gone.";
			const useModel = vi
				.fn()
				.mockResolvedValueOnce(
					JSON.stringify({ response, effectReceiptIds: ["delete-proof"] }),
				)
				.mockResolvedValueOnce(
					JSON.stringify(
						revoked
							? { contextRequest: "full" }
							: { ...approved, completedChangeClaim: true },
					),
				);
			if (revoked)
				useModel.mockResolvedValueOnce(
					JSON.stringify({ ...approved, completedChangeClaim: true }),
				);
			const runtime = createMockRuntime({ useModel });
			const results: ActionResult[] = [
				{
					success: true,
					verifiedUserFacing: true,
					userFacingText: response,
					data: { actionName: "CALENDAR_DELETE" },
					effectReceipts: [
						{
							receiptId: "delete-proof",
							operation: "calendar.delete",
							outcome: "applied",
							resource: { kind: "event", id: "dentist" },
							artifacts: [],
							idempotency: { key: "delete-dentist", replayed: false },
							observedAt: "2026-09-15T12:00:00Z",
							commit: {
								kind: "durable",
								id: "delete-1",
								committedAt: "2026-09-15T12:00:00Z",
							},
						},
					],
				},
			];
			runtime.actions = [
				{
					name: "CALENDAR_DELETE",
					description: "Delete calendar event",
					tags: ["resource:calendar", "capability:write"],
					examples: [],
					validate: async () => true,
					handler: async () => results[0],
				},
			];
			const full = "Complete original request.";
			const selected = "Selected request.";
			const pending = resolvePlannedReplyEgress({
				runtime,
				message,
				reply: "",
				actionResults: results,
				recovery: revoked
					? {
							context: full,
							historySelection: {
								context: selected,
								contextHash: hashString(selected),
								fullContextHash: hashString(full),
							},
							pendingToolCalls: [],
							evaluatorOutputs: [],
							ownerExclusiveDisclosureUsed: false,
						}
					: undefined,
				beforeContextRestore: async () => {
					results[0].effectReceipts = [];
				},
			});
			if (revoked)
				await expect(pending).rejects.toMatchObject({
					code: "REPLY_GROUNDING_FAILED",
				});
			else
				await expect(pending).resolves.toEqual({
					text: response,
					effectReceiptIds: ["delete-proof"],
				});
		},
	);
	it.each([
		"not JSON",
		JSON.stringify({ grounded: true }),
		JSON.stringify({ response: "The event is gone.", effectReceiptIds: [] }),
	])("rejects an unusable review: %s", async (review) => {
		const useModel = vi
			.fn()
			.mockResolvedValueOnce(
				JSON.stringify({
					response: "I cannot verify the outcome.",
					effectReceiptIds: [],
				}),
			)
			.mockResolvedValueOnce(review);
		const runtime = createMockRuntime({ useModel });
		await expect(
			resolvePlannedReplyEgress({
				runtime,
				message,
				reply: rejectedReply,
				actionResults: [],
			}),
		).rejects.toMatchObject({ code: "REPLY_GROUNDING_REVIEW_FAILED" });
	});
	it.each(["current", "saved"])(
		"rejects %s evidence changed while the semantic review is running",
		async (source) => {
			const results: ActionResult[] = [];
			const savedResults: ActionResult[] = [];
			const useModel = vi
				.fn()
				.mockResolvedValueOnce(
					JSON.stringify({
						response: "I cannot verify the outcome.",
						effectReceiptIds: [],
					}),
				)
				.mockImplementationOnce(async () => {
					(source === "current" ? results : savedResults).push({
						success: false,
						error: "Concurrent evidence changed",
					});
					return JSON.stringify(approved);
				});
			const runtime = createMockRuntime({ useModel });
			await expect(
				resolvePlannedReplyEgress({
					runtime,
					message,
					reply: rejectedReply,
					actionResults: results,
					recovery: {
						context: "Complete original context.",
						pendingToolCalls: [],
						evaluatorOutputs: [],
						ownerExclusiveDisclosureUsed: false,
						actionResults: savedResults,
					},
				}),
			).rejects.toMatchObject({ code: "REPLY_GROUNDING_REVIEW_STALE" });
		},
	);
	it("restores complete original evidence once before accepting a review", async () => {
		const full = "Complete original λ雪 correction.\n".repeat(1200);
		const selected = "Selected original.";
		const response = "I cannot verify the outcome.";
		const useModel = vi
			.fn()
			.mockResolvedValueOnce(JSON.stringify({ response, effectReceiptIds: [] }))
			.mockResolvedValueOnce(JSON.stringify({ contextRequest: "full" }))
			.mockResolvedValueOnce(JSON.stringify(approved));
		const runtime = createMockRuntime({ useModel });
		const beforeContextRestore = vi.fn(async () => undefined);
		await expect(
			resolvePlannedReplyEgress({
				runtime,
				message,
				reply: rejectedReply,
				actionResults: [],
				recovery: {
					context: full,
					historySelection: {
						context: selected,
						contextHash: hashString(selected),
						fullContextHash: hashString(full),
					},
					pendingToolCalls: [],
					evaluatorOutputs: [],
					ownerExclusiveDisclosureUsed: false,
				},
				beforeContextRestore,
			}),
		).resolves.toEqual({ text: response, effectReceiptIds: [] });
		expect(beforeContextRestore).toHaveBeenCalledTimes(1);
		expect(useModel).toHaveBeenCalledTimes(3);
		expect(useModel.mock.calls[2][1].prompt).toContain(JSON.stringify(full));
	});
});
