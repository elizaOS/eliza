/**
 * Exercises the real planner queue with deterministic models and an in-memory
 * domain store. Receipts distinguish observations from committed mutations;
 * assertions inspect stored effects and subsequent model-visible reads.
 */
import { describe, expect, it } from "vitest";
import type { EffectReceipt } from "../../types/effects";
import {
	partitionRedundantSucceededCalls,
	runPlannerLoop,
} from "../planner-loop";
import type { PlannerToolCall, PlannerToolResult } from "../planner-types";

function receipt(outcome: "noop" | "applied", id: string): EffectReceipt {
	const base = {
		receiptId: `${outcome}:${id}`,
		operation: `test.items.${outcome === "noop" ? "review" : "create"}`,
		resource: { kind: "test.item", id },
		artifacts: [],
		idempotency: { key: null, replayed: false },
		observedAt: "2026-09-06T00:00:00.000Z",
	};
	return outcome === "noop"
		? { ...base, outcome, reason: "Read current items." }
		: {
				...base,
				outcome,
				commit: { kind: "durable", id, committedAt: base.observedAt },
			};
}

function proposal(id: string, action: string, key?: string) {
	return {
		id,
		name: "OWNER_TODOS",
		arguments: {
			action,
			...(key ? { key } : {}),
			eliza_turn_scope: "more_work_pending",
		},
	};
}

async function runStorePlan(
	batches: ReturnType<typeof proposal>[][],
	options: {
		failFirst?: boolean;
		externalChange?: boolean;
		protocolFailureAfterWrite?: boolean;
		userRequest?: string;
	} = {},
) {
	const items: string[] = [];
	const reads: string[][] = [];
	const messages: string[] = [];
	let modelCalls = 0;
	let writes = 0;
	let attempts = 0;
	const result = await runPlannerLoop({
		runtime: {
			useModel: async (_type, params) => {
				messages.push(JSON.stringify(params));
				const toolCalls = batches[modelCalls++];
				if (!toolCalls) throw new Error("Unexpected extra planner round");
				return {
					text: "",
					toolCalls: toolCalls.map((call) => ({
						...call,
						arguments: {
							...call.arguments,
							eliza_turn_scope:
								modelCalls === batches.length ? "final" : "more_work_pending",
						},
					})),
				};
			},
		},
		context: {
			id: "freshness",
			events: options.userRequest
				? [
						{
							id: "request",
							type: "message",
							source: "user",
							createdAt: Date.now(),
							content: options.userRequest,
						},
					]
				: [],
		},
		tools: [{ name: "OWNER_TODOS", description: "Review or create items." }],
		executeToolCall: async (
			call: PlannerToolCall,
		): Promise<PlannerToolResult> => {
			if (call.params?.action === "review") {
				reads.push([...items]);
				const read = {
					success: true,
					text: JSON.stringify(items),
					effectReceipts: [receipt("noop", "list")],
					turnComplete: false,
				};
				if (options.externalChange && reads.length === 1)
					items.push("external-item");
				return read;
			}
			attempts++;
			if (options.failFirst && attempts === 1)
				return {
					success: false,
					text: "Rejected before mutation",
					data: { retryable: true },
				};
			const id = `item-${++writes}`;
			items.push(id);
			return {
				success: true,
				text: id,
				...(options.protocolFailureAfterWrite
					? {
							userFacingText: `Saved ${id}`,
							verifiedUserFacing: true,
							userFacingEffectReceiptIds: [receipt("applied", id).receiptId],
						}
					: {}),
				effectReceipts: [receipt("applied", id)],
				turnComplete: false,
			};
		},
		evaluate: async ({ trajectory }) => ({
			...(options.protocolFailureAfterWrite && reads.length === 0
				? {
						protocolFailure: true,
						parseError: "response is not a single JSON object",
					}
				: {}),
			success: true,
			decision:
				trajectory.plannedQueue.length > 0
					? "NEXT_RECOMMENDED"
					: modelCalls === batches.length
						? "FINISH"
						: "CONTINUE",
			recommendedToolCallId: trajectory.plannedQueue[0]?.id,
			messageToUser: `Stored: ${items.join(", ")}`,
		}),
	});
	return { result, items, reads, messages, writes, attempts };
}

describe("planner effect freshness and deliberate queued multiplicity", () => {
	it("keeps applied and replayed receipts settled despite a contradictory read-only flag", () => {
		const call = { name: "OWNER_TODOS", params: { action: "create" } };
		for (const effect of [
			receipt("applied", "item-1"),
			{
				...receipt("noop", "item-1"),
				idempotency: { key: "authorized-create", replayed: true },
			},
		]) {
			const partition = partitionRedundantSucceededCalls([call], {
				context: { id: "receipt-precedence" },
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
				steps: [
					{
						iteration: 1,
						toolCall: call,
						result: {
							success: true,
							data: { readOnlyOperation: true },
							effectReceipts: [effect],
						},
					},
				],
			});
			expect(partition.fresh).toEqual([]);
			expect(partition.redundant).toEqual([call]);
		}
	});

	it("reads actual post-write state with identical read arguments", async () => {
		const run = await runStorePlan([
			[proposal("r1", "review")],
			[proposal("w1", "create")],
			[proposal("r2", "review")],
		]);
		expect(run.reads).toEqual([[], ["item-1"]]);
		expect(run.writes).toBe(1);
		expect(run.result.finalMessage).toContain("item-1");
		expect(run.messages[2]).toContain("item-1");
	});

	it("continues explicitly pending verification after a malformed evaluator reply", async () => {
		const run = await runStorePlan(
			[[proposal("write", "create")], [proposal("verify", "review")]],
			{ protocolFailureAfterWrite: true },
		);
		expect(run.items).toEqual(["item-1"]);
		expect(run.reads).toEqual([["item-1"]]);
		expect(run.result.finalMessage).toContain("item-1");
	});

	it("re-observes external state without requiring a local write", async () => {
		const run = await runStorePlan(
			[[proposal("r1", "review")], [proposal("r2", "review")]],
			{ externalChange: true },
		);
		expect(run.reads).toEqual([[], ["external-item"]]);
		expect(run.result.finalMessage).toContain("external-item");
	});

	it("preserves separate unkeyed operations with identical arguments in one response", async () => {
		const run = await runStorePlan(
			[
				[
					proposal("first-requested-record", "create"),
					proposal("second-requested-record", "create"),
				],
				[proposal("r1", "review")],
			],
			{
				userRequest:
					"Create exactly two separate identical records. Both are intentional, not retries.",
			},
		);
		expect(run.items).toEqual(["item-1", "item-2"]);
		expect(run.reads).toEqual([["item-1", "item-2"]]);
		expect(
			run.result.trajectory.steps.filter(
				(step) => step.toolCall?.id === "second-requested-record",
			),
		).toHaveLength(1);
	});

	it("does not treat a rejected pre-write attempt as a successful mutation", async () => {
		const run = await runStorePlan(
			[
				[proposal("w1", "create"), proposal("retry", "create")],
				[proposal("r1", "review")],
			],
			{ failFirst: true },
		);
		expect(run.attempts).toBe(2);
		expect(run.items).toEqual(["item-1"]);
		expect(run.reads).toEqual([["item-1"]]);
	});
});
