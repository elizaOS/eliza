/**
 * Proves nested-operation digests stay process-local while model/evaluator
 * projections derive rollback-aware operation status across live and archived
 * planner windows.
 */
import { describe, expect, it } from "vitest";
import type { EffectReceipt } from "../../types/effects";
import {
	plannerToolCallDigest,
	projectEvaluatorVisibleTrajectory,
	projectModelVisibleTrajectory,
	resolvePlannerSubstepAuthority,
} from "../planner-trajectory";
import type { PlannerSubstepDigest, PlannerTrajectory } from "../planner-types";

const observedAt = "2026-08-12T12:00:00.000Z";

function appliedReceipt(): EffectReceipt {
	return {
		receiptId: "receipt-3f2504e0-4f89-11d3-a0c9-0305e82c3301",
		operation: "agent-orchestrator.tasks.provision_workspace",
		resource: { kind: "coding.workspace", id: "/private/SECRET/workspace" },
		artifacts: [],
		idempotency: { key: "Bearer PRIVATE_TOKEN", replayed: false },
		observedAt,
		outcome: "applied",
		commit: {
			kind: "durable",
			id: "commit-deadbeef",
			committedAt: observedAt,
		},
	};
}

function digest(
	effect: PlannerSubstepDigest["effect"],
	nominalSuccess = true,
): PlannerSubstepDigest {
	return {
		operation: "PROVISION_WORKSPACE",
		callDigest: plannerToolCallDigest({
			name: "PROVISION_WORKSPACE",
			params: { cwd: "/private/SECRET", token: "PRIVATE_TOKEN" },
		}),
		nominalSuccess,
		effect,
		retryable: true,
	};
}

function trajectory(
	step: PlannerTrajectory["steps"][number],
	archived: boolean,
): PlannerTrajectory {
	return {
		context: { id: "ctx", events: [] },
		steps: archived ? [] : [step],
		archivedSteps: archived ? [step] : [],
		plannedQueue: [],
		evaluatorOutputs: [],
	};
}

describe("planner nested-operation digest", () => {
	it("shares one stable call identity across key order while separating arguments", () => {
		expect(
			plannerToolCallDigest({ name: "TASK", params: { b: 2, a: 1 } }),
		).toBe(plannerToolCallDigest({ name: "TASK", params: { a: 1, b: 2 } }));
		expect(plannerToolCallDigest({ name: "TASK", params: { a: 1 } })).not.toBe(
			plannerToolCallDigest({ name: "TASK", params: { a: 2 } }),
		);
	});

	it("distinguishes completed, failed, and unknown authority", () => {
		const applied = appliedReceipt();
		expect(
			resolvePlannerSubstepAuthority(
				digest({ kind: "receipts", receiptIds: [applied.receiptId] }),
				[applied],
			).status,
		).toBe("completed");
		expect(
			resolvePlannerSubstepAuthority(digest({ kind: "none" }), []).status,
		).toBe("completed");
		expect(
			resolvePlannerSubstepAuthority(digest({ kind: "unproven" }), []).status,
		).toBe("unknown");
		expect(
			resolvePlannerSubstepAuthority(
				digest({ kind: "receipts", receiptIds: ["missing"] }),
				[applied],
			).status,
		).toBe("unknown");
		expect(
			resolvePlannerSubstepAuthority(
				digest({ kind: "receipts", receiptIds: [] }),
				[applied],
			).status,
		).toBe("unknown");
		expect(
			resolvePlannerSubstepAuthority(digest({ kind: "none" }, false), [])
				.status,
		).toBe("failed");

		const rollback: EffectReceipt = {
			receiptId: "rollback-receipt",
			operation: "agent-orchestrator.tasks.rollback",
			resource: applied.resource,
			artifacts: [],
			idempotency: { key: "rollback-key", replayed: false },
			observedAt,
			outcome: "rolled_back",
			rollback: {
				receiptId: "rollback-commit",
				revertedReceiptIds: [applied.receiptId],
				rolledBackAt: observedAt,
			},
		};
		expect(
			resolvePlannerSubstepAuthority(
				digest({ kind: "receipts", receiptIds: [applied.receiptId] }),
				[applied, rollback],
			).status,
		).toBe("failed");
	});

	it("projects byte-identical safe status before and after keepSteps=0 archival", () => {
		const applied = appliedReceipt();
		const nested = digest({
			kind: "receipts",
			receiptIds: [applied.receiptId],
		});
		const step: PlannerTrajectory["steps"][number] = {
			iteration: 1,
			thought: "PRIVATE_THOUGHT",
			toolCall: {
				name: "TASKS",
				params: { cwd: "/private/SECRET", token: "PRIVATE_TOKEN" },
			},
			result: {
				success: true,
				text: "RAW_PRIVATE_TEXT",
				data: { workspaceId: "3f2504e0-4f89-11d3-a0c9-0305e82c3301" },
				error: undefined,
				effectReceipts: [applied],
				subSteps: [nested],
			},
		};
		const live = trajectory(step, false);
		const archived = trajectory(step, true);

		expect(projectModelVisibleTrajectory(live)).toEqual(
			projectModelVisibleTrajectory(archived),
		);
		expect(projectEvaluatorVisibleTrajectory(live)).toEqual(
			projectEvaluatorVisibleTrajectory(archived),
		);
		const projected = JSON.stringify({
			planner: projectModelVisibleTrajectory(live),
			evaluator: projectEvaluatorVisibleTrajectory(live),
		});
		expect(projected).toContain("PROVISION_WORKSPACE");
		expect(projected).toContain("completed");
		for (const forbidden of [
			"PRIVATE_THOUGHT",
			"RAW_PRIVATE_TEXT",
			"/private/SECRET",
			"PRIVATE_TOKEN",
			"3f2504e0-4f89-11d3-a0c9-0305e82c3301",
			"deadbeef",
			nested.callDigest,
			applied.receiptId,
		]) {
			expect(projected).not.toContain(forbidden);
		}
	});
});
