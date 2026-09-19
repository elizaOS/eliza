/** Real evaluator requests and final egress with controlled model responses.
 * Restrict proof choices without dropping receipts or accepting invalid output. */
import { describe, expect, it, vi } from "vitest";
import { evaluatorSchema } from "../../../../../plugins/plugin-assistant/src/prompts/evaluator.ts";
import { runEvaluator } from "../../../../../plugins/plugin-assistant/src/runtime/evaluator.ts";
import { evaluatePlannedReplyEgress } from "../../../../../plugins/plugin-assistant/src/services/message/egress-policy.ts";
import type { EffectReceipt } from "../../types/effects";
import type { JSONSchema } from "../../types/model";
import type { EvaluatorRuntime, PlannerTrajectory } from "../planner-types";

const observedAt = "2026-09-15T06:00:00.000Z";
function receipt(
	id: string,
	outcome: "applied" | "noop",
	replayed = false,
): EffectReceipt {
	const common = {
		receiptId: id,
		operation: outcome === "applied" ? "notes.create" : "calendar.feed.read",
		resource: { kind: "record", id },
		artifacts: [],
		idempotency: { key: replayed ? "original-request" : null, replayed },
		observedAt,
	};
	return outcome === "applied"
		? {
				...common,
				outcome,
				commit: {
					kind: "durable",
					id: `commit-${id}`,
					committedAt: observedAt,
				},
			}
		: {
				...common,
				outcome,
				reason: replayed ? "Earlier commit re-observed" : "Read-only snapshot",
			};
}
function rollback(id: string): EffectReceipt {
	return {
		receiptId: "rollback",
		operation: "notes.rollback",
		resource: { kind: "note", id },
		artifacts: [],
		idempotency: { key: null, replayed: false },
		observedAt,
		outcome: "rolled_back",
		rollback: {
			receiptId: "rollback-commit",
			revertedReceiptIds: [id],
			rolledBackAt: observedAt,
		},
	};
}
function trajectory(receipts: EffectReceipt[]): PlannerTrajectory {
	return {
		context: { id: "receipt-turn", events: [] },
		steps: [
			{
				iteration: 1,
				toolCall: { id: "read", name: "READ", params: {} },
				result: { success: true, effectReceipts: receipts },
			},
		],
		archivedSteps: [],
		plannedQueue: [],
		evaluatorOutputs: [],
	};
}
async function evaluate(
	t: PlannerTrajectory,
	ids: string[] = [],
	redactSecrets?: (text: string) => string,
) {
	const useModel = vi.fn<EvaluatorRuntime["useModel"]>(async () =>
		JSON.stringify({
			thought: "The requested outcomes are recorded.",
			decision: "FINISH",
			success: true,
			messageToUser: "I created the note.",
			effectReceiptIds: ids,
		}),
	);
	const result = await runEvaluator({
		runtime: { useModel, ...(redactSecrets ? { redactSecrets } : {}) },
		context: t.context,
		trajectory: t,
	});
	const request = useModel.mock.calls[0]?.[1] as {
		responseSchema: JSONSchema;
		messages: unknown;
	};
	return { result, request, useModel };
}

describe("evaluator current-turn committed receipt choices", () => {
	it("offers active commits and replayed no-ops including archived steps, excluding reads and rolled-back commits", async () => {
		const archived = receipt("archived-note", "applied");
		const undone = receipt("undone-note", "applied");
		const t = trajectory([
			receipt("calendar-read", "noop"),
			receipt("replayed-note", "noop", true),
			rollback(undone.receiptId),
		]);
		t.archivedSteps = [
			{
				iteration: 0,
				result: { success: true, effectReceipts: [archived, undone] },
			},
		];
		const before = structuredClone(t);
		const { request } = await evaluate(t, [archived.receiptId]);
		expect(request.responseSchema.properties?.effectReceiptIds).toMatchObject({
			type: "array",
			items: { type: "string", enum: ["archived-note", "replayed-note"] },
		});
		expect(JSON.stringify(request.messages)).toContain("calendar-read");
		expect(JSON.stringify(request.messages)).toContain("rollback");
		expect(t).toEqual(before);
		expect(evaluatorSchema.properties?.effectReceiptIds?.items).toEqual({
			type: "string",
		});
	});
	it("offers only the empty list for a read-only turn", async () => {
		const { request } = await evaluate(
			trajectory([receipt("calendar-read", "noop")]),
		);
		expect(request.responseSchema.properties?.effectReceiptIds).toMatchObject({
			type: "array",
			enum: [[]],
		});
	});
	it("recomputes choices after a later rollback instead of reusing another evaluation's schema", async () => {
		const applied = receipt("note-proof", "applied");
		const t = trajectory([applied]);
		const first = await evaluate(t, [applied.receiptId]);
		t.steps.push({
			iteration: 2,
			result: { success: true, effectReceipts: [rollback(applied.receiptId)] },
		});
		const second = await evaluate(t);
		expect(
			first.request.responseSchema.properties?.effectReceiptIds?.items,
		).toMatchObject({ enum: [applied.receiptId] });
		expect(
			second.request.responseSchema.properties?.effectReceiptIds,
		).toMatchObject({ enum: [[]] });
	});
	it("does not expose a receipt identifier redacted from model diagnostics", async () => {
		const { request } = await evaluate(
			trajectory([receipt("private-proof", "applied")]),
			[],
			(text) => text.replaceAll("private-proof", "[REDACTED]"),
		);
		expect(request.responseSchema.properties?.effectReceiptIds).toMatchObject({
			enum: [[]],
		});
		expect(JSON.stringify(request)).not.toContain("private-proof");
	});
	it("still rejects a model that selects a read receipt despite the schema", async () => {
		const applied = receipt("note-proof", "applied");
		const read = receipt("calendar-read", "noop");
		const t = trajectory([applied, read]);
		const { request, result } = await evaluate(t, [
			applied.receiptId,
			read.receiptId,
		]);
		expect(
			request.responseSchema.properties?.effectReceiptIds?.items,
		).toMatchObject({ enum: [applied.receiptId] });
		expect(result.effectReceiptIds).toEqual([
			applied.receiptId,
			read.receiptId,
		]);
		expect(
			evaluatePlannedReplyEgress({
				reply: result.messageToUser ?? "",
				actionResults: [{ success: true, effectReceipts: [applied, read] }],
				actions: [],
				evaluator: result,
			}),
		).toEqual({ verdict: "reject", kind: "completed_side_effect" });
	});
});
