/**
 * Exercises the actual planner with scripted model protocol failures and a
 * stateful tool fixture. Recovery remains a model decision; typed failure and
 * existing execution limits determine whether another planning round is safe.
 */
import { describe, expect, it } from "vitest";
import type { ActionFailureProvenance } from "../../types/action-failure";
import type { EffectReceipt } from "../../types/effects";
import { TrajectoryLimitExceeded } from "../limits";
import { runPlannerLoop } from "../planner-loop";
import type { PlannerToolResult } from "../planner-types";

const retryable: ActionFailureProvenance = {
	kind: "handler_error",
	boundary: "handler",
	code: "ACTION_HANDLER_FAILED",
	retryable: true,
};
const key = "authorized-operation";
const tool = {
	name: "OWNER_TODOS",
	description: "Create or inspect the authorized todo",
	parameters: {
		type: "object" as const,
		properties: {
			action: { type: "string" as const },
			idempotencyKey: { type: "string" as const },
		},
		required: ["action"],
	},
};

function createHarness(
	options: {
		pending?: boolean;
		provenance?: ActionFailureProvenance | null;
		persistent?: boolean;
		cancel?: boolean;
		pauseAfterFailure?: boolean;
		reconcileByRead?: boolean;
		maxToolCalls?: number;
		maxRepeatedFailures?: number;
	} = {},
) {
	const calls: string[] = [];
	const records = new Map<string, string>();
	const modelInputs: string[] = [];
	let planningRounds = 0;
	let lastSucceeded = false;
	const failure: PlannerToolResult = {
		success: false,
		error: "declared storage outage",
		...(options.provenance === null
			? {}
			: { failureProvenance: options.provenance ?? retryable }),
	};
	const run = () =>
		runPlannerLoop({
			runtime: {
				useModel: async (type, params) => {
					modelInputs.push(JSON.stringify(params));
					if (type === "ACTION_PLANNER" && params?.tools) {
						planningRounds++;
						if (options.cancel && planningRounds > 1) {
							return {
								text: "",
								toolCalls: [{ id: "cancel", name: "STOP", arguments: {} }],
							};
						}
						return {
							text: "",
							toolCalls: [
								{
									id: `proposal-${planningRounds}`,
									name: "OWNER_TODOS",
									arguments: {
										action:
											options.reconcileByRead && planningRounds > 1
												? "review"
												: "create",
										...(options.reconcileByRead ? {} : { idempotencyKey: key }),
										...(options.pending === false
											? {}
											: { eliza_turn_scope: "more_work_pending" }),
									},
								},
							],
						};
					}
					if (type === "RESPONSE_HANDLER") {
						return lastSucceeded
							? {
									text: JSON.stringify({
										success: !options.reconcileByRead,
										decision: "FINISH",
										thought: "Inspected the actual tool outcomes.",
										messageToUser: options.reconcileByRead
											? "A row is visible, but write acceptance remains uncertain."
											: "Verified the stored todo.",
									}),
									toolCalls: [],
								}
							: {
									text: "<tool_call><function=OWNER_TODOS>retry</function></tool_call>",
									toolCalls: [],
								};
					}
					return {
						text: "The storage operation failed; I cannot claim it completed.",
						toolCalls: [],
					};
				},
			},
			context: {
				id: "retryable-evaluator",
				events: [
					{
						id: "request",
						type: "message",
						source: "user",
						createdAt: 1,
						content:
							"Create one todo. Retry transient failures with the same durable key; reconcile an ambiguous write before repeating it.",
					},
				],
			},
			tools: [tool],
			config: {
				maxToolCalls: options.maxToolCalls ?? 6,
				maxRepeatedFailures: options.maxRepeatedFailures ?? 2,
			},
			executeToolCall: async (call) => {
				const action = String(call.params?.action);
				calls.push(action);
				if (action === "review") {
					lastSucceeded = true;
					return {
						success: true,
						text: JSON.stringify([...records.values()]),
						data: { readOnlyOperation: true },
					};
				}
				if (calls.length === 1 || options.persistent) {
					if (options.reconcileByRead)
						records.set("ambiguous-unkeyed-write", "todo-1");
					lastSucceeded = false;
					return failure;
				}
				if (options.pauseAfterFailure && calls.length === 2) {
					lastSucceeded = false;
					return {
						success: false,
						text: "Which schedule should I use?",
						userFacingText: "Which schedule should I use?",
						verifiedUserFacing: true,
						data: { awaitingUserInput: true },
					};
				}
				expect(call.params?.idempotencyKey).toBe(key);
				records.set(key, "todo-1");
				lastSucceeded = true;
				const observedAt = "2026-09-06T07:56:00.000Z";
				const receipt: EffectReceipt = {
					receiptId: "commit",
					operation: "lifeops.definition.create",
					resource: { kind: "lifeops.definition", id: "todo-1" },
					artifacts: [],
					idempotency: { key, replayed: false },
					observedAt,
					outcome: "applied",
					commit: {
						kind: "durable",
						id: "transaction",
						committedAt: observedAt,
					},
				};
				return {
					success: true,
					text: "Stored todo-1",
					effectReceipts: [receipt],
				};
			},
		});
	return { run, calls, records, modelInputs };
}

describe("pending retryable work after malformed evaluation", () => {
	it("replans from the complete failure instead of forcing a terminal reply", async () => {
		const h = createHarness();
		const result = await h.run();
		expect(h.calls).toEqual(["create", "create"]);
		expect([...h.records.values()]).toEqual(["todo-1"]);
		expect(result.finalMessage).toBe("Verified the stored todo.");
		expect(
			h.modelInputs.some(
				(input) =>
					input.includes("declared storage outage") && input.includes(key),
			),
		).toBe(true);
	});

	it.each([
		{
			name: "nonretryable failure",
			provenance: { ...retryable, retryable: false },
		},
		{
			name: "permission denial",
			provenance: { ...retryable, code: "PERMISSION_DENIED", retryable: false },
		},
		{
			name: "cancellation",
			provenance: { ...retryable, code: "ABORT_ERR", retryable: false },
		},
		{ name: "missing provenance", provenance: null },
	])("retains the failure boundary for $name", async ({ provenance }) => {
		const h = createHarness({ provenance });
		const result = await h.run();
		expect(h.calls).toEqual(["create"]);
		expect(h.records.size).toBe(0);
		expect(result.finalMessage).toContain("cannot claim it completed");
	});

	it("does not infer pending authorization from a retryable failure alone", async () => {
		const h = createHarness({ pending: false });
		await h.run();
		expect(h.calls).toEqual(["create"]);
	});

	it("honors a subsequent STOP without dispatching the failed operation again", async () => {
		const h = createHarness({ cancel: true });
		const result = await h.run();
		expect(h.calls).toEqual(["create"]);
		expect(result.silentTerminalAction).toBe("STOP");
		expect(h.records.size).toBe(0);
	});

	it("lets the model inspect an ambiguous unkeyed effect instead of automatically replaying it", async () => {
		const h = createHarness({ reconcileByRead: true });
		await h.run();
		expect(h.calls).toEqual(["create", "review"]);
		expect(h.records.size).toBe(1);
	});

	it("preserves a later request for missing input after a retryable failure", async () => {
		const h = createHarness({ pauseAfterFailure: true });
		const result = await h.run();
		expect(h.calls).toEqual(["create", "create"]);
		expect(h.records.size).toBe(0);
		expect(result.finalMessage).toBe("Which schedule should I use?");
	});

	it("preserves the explicit tool-call limit during recovery", async () => {
		const h = createHarness({ maxToolCalls: 1 });
		await expect(h.run()).rejects.toMatchObject({ kind: "tool_calls" });
		expect(h.calls).toEqual(["create"]);
		expect(h.records.size).toBe(0);
	});

	it("stops persistent failures at the existing repeated-failure limit", async () => {
		const h = createHarness({ persistent: true, maxRepeatedFailures: 1 });
		await expect(h.run()).rejects.toBeInstanceOf(TrajectoryLimitExceeded);
		expect(h.calls).toEqual(["create", "create"]);
		expect(h.records.size).toBe(0);
	});
});
