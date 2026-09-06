/**
 * Exercises real planner final-reply arbitration with deterministic model and owner
 * responses. Receipt shapes follow the live owner/PGlite preview-to-commit failure;
 * these tests prove causal reply selection, not provider or persistence behavior.
 */
import { describe, expect, it } from "vitest";
import type { EffectReceipt } from "../../types/effects";
import {
	runPlannerLoop,
	singleVerifiedUserFacingToolResultText,
} from "../planner-loop";
import type { PlannerToolResult } from "../planner-types";

const question = "When should it happen?";
const finalText = "Both authorized todos are saved without a schedule.";
const observedAt = "2026-09-06T07:23:19.518Z";
function receipt(
	outcome: "preview" | "applied",
	key: string | null,
): EffectReceipt {
	const base = {
		receiptId: `${outcome}-${key}`,
		operation: "lifeops.definition.create",
		resource: { kind: "lifeops.definition", id: `${outcome}-${key}` },
		artifacts: [],
		idempotency: { key, replayed: false },
		observedAt,
	};
	return outcome === "preview"
		? { ...base, outcome }
		: {
				...base,
				outcome,
				commit: {
					kind: "durable",
					id: `transaction-${key}`,
					committedAt: observedAt,
				},
			};
}
type BoundResult = PlannerToolResult & {
	effectReceipts: EffectReceipt[];
	userFacingEffectReceiptIds: string[];
};
function result(effect: EffectReceipt): BoundResult {
	return {
		success: effect.outcome !== "preview",
		text: "Complete owner diagnostic output",
		userFacingText:
			effect.outcome === "preview" ? question : "Saved the requested todo.",
		verifiedUserFacing: true,
		effectReceipts: [effect],
		userFacingEffectReceiptIds: [effect.receiptId],
		...(effect.outcome === "preview"
			? { data: { requiresConfirmation: true } }
			: {}),
	};
}
type Scenario = {
	name: string;
	clears?: boolean;
	expected?: string;
	tool?: string;
	change?: (results: BoundResult[]) => void;
};
const scenarios: Scenario[] = [
	{
		name: "failed receipt cannot prove completion",
		change: (rows) => {
			const effect = rows[2].effectReceipts[0];
			rows[2] = result({
				...effect,
				outcome: "failed",
				failure: {
					code: "WRITE_REJECTED",
					retryable: true,
					acceptance: "rejected",
				},
			});
		},
	},
	{
		name: "unverified text cannot bind completion",
		change: (rows) => {
			rows[2].verifiedUserFacing = false;
		},
	},
	{ name: "later matching durable commit", clears: true },
	{
		name: "later verified completed replay",
		clears: true,
		change: (rows) => {
			const effect = rows[2].effectReceipts[0];
			rows[2] = result({
				...effect,
				outcome: "noop",
				reason: "Earlier commit verified",
				idempotency: { ...effect.idempotency, replayed: true },
			});
		},
	},
	{
		name: "foreign operation key",
		change: (rows) => {
			rows[2] = result(receipt("applied", "foreign"));
		},
	},
	{
		name: "different operation",
		change: (rows) => {
			const effect = rows[2].effectReceipts[0];
			rows[2] = result({ ...effect, operation: "lifeops.definition.update" });
		},
	},
	{ name: "different tool", tool: "OTHER_OWNER" },
	{
		name: "unkeyed preview preserves compatibility",
		change: (rows) => {
			rows[0] = result(receipt("preview", null));
		},
	},
	{
		name: "unkeyed commit",
		change: (rows) => {
			rows[2] = result(receipt("applied", null));
		},
	},
	{
		name: "failed action with applied receipt",
		expected: "Could not save the requested todo.",
		change: (rows) => {
			rows[2].success = false;
			rows[2].userFacingText = "Could not save the requested todo.";
		},
	},
	{
		name: "unbound applied receipt",
		change: (rows) => {
			rows[2].userFacingEffectReceiptIds = [];
		},
	},
	{
		name: "incomplete commit receipt list",
		change: (rows) => {
			rows[2].effectReceipts = [];
		},
	},
	{
		name: "ordinary noop",
		change: (rows) => {
			const effect = rows[2].effectReceipts[0];
			rows[2] = result({
				...effect,
				outcome: "noop",
				reason: "Nothing changed",
			});
		},
	},
	{
		name: "later rollback invalidates proof",
		change: (rows) => {
			const effect = rows[2].effectReceipts[0];
			rows[2].effectReceipts = [
				effect,
				{
					...effect,
					receiptId: "rollback",
					outcome: "rolled_back",
					rollback: {
						receiptId: "compensation",
						revertedReceiptIds: [effect.receiptId],
						rolledBackAt: observedAt,
					},
				},
			];
		},
	},
	{
		name: "commit before preview is not causal",
		change: (rows) => {
			rows.reverse();
		},
	},
	{
		name: "borrowed earlier receipt is not a later commit",
		change: (rows) => {
			rows[1] = rows[0];
			rows[0] = result(receipt("applied", "requested"));
			rows[2].effectReceipts = [];
		},
	},
	{
		name: "all preview operations need completion",
		change: (rows) => {
			const another = receipt("preview", "still-pending");
			rows[0].effectReceipts = [...rows[0].effectReceipts, another];
			rows[0].userFacingEffectReceiptIds = [
				...rows[0].userFacingEffectReceiptIds,
				another.receiptId,
			];
		},
	},
];
describe("planner confirmation preview causal completion", () => {
	for (const scenario of scenarios)
		it(scenario.name, async () => {
			const rows = [
				result(receipt("preview", "requested")),
				result(receipt("applied", "separate")),
				result(receipt("applied", "requested")),
			];
			scenario.change?.(rows);
			let index = 0;
			const outcome = await runPlannerLoop({
				runtime: {
					useModel: async () => {
						const current = index++;
						return {
							text: "",
							toolCalls: [
								{
									name:
										current === 2 && scenario.tool
											? scenario.tool
											: "OWNER_TODOS",
									arguments: {
										step: current,
										eliza_turn_scope:
											current === 2 ? "final" : "more_work_pending",
									},
								},
							],
						};
					},
				},
				context: {
					id: "preview-recovery",
					events: [
						{
							id: "request",
							type: "message",
							source: "user",
							createdAt: 1,
							content:
								"Create both authorized todos without a deadline, resolving the pending schedule first.",
						},
					],
				},
				tools: [
					{ name: "OWNER_TODOS", description: "Owner todos" },
					{ name: "OTHER_OWNER", description: "Other owner" },
				],
				executeToolCall: async () => rows[index - 1],
				evaluate: async () => ({
					success: true,
					decision: index === 3 ? "FINISH" : "CONTINUE",
					...(index === 3 ? { messageToUser: finalText } : {}),
				}),
			});
			expect(outcome.finalMessage).toBe(
				scenario.expected ?? (scenario.clears ? finalText : question),
			);
			expect(
				outcome.trajectory.steps.filter((step) => step.toolCall),
			).toHaveLength(3);
			expect(outcome.trajectory.steps[0].result).toEqual(rows[0]);
			if (!scenario.clears)
				expect(singleVerifiedUserFacingToolResultText(outcome.trajectory)).toBe(
					question,
				);
		});
});
