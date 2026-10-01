import { describe, expect, it } from "vitest";
import {
	createInteractiveTask,
	type InteractiveTask,
	type TaskActionProposal,
	type TaskTransition,
	transitionInteractiveTask,
	validateInteractiveTask,
} from "./interactive-task.ts";

const owner = {
	actorId: "actor",
	agentId: "agent",
	connector: { source: "test", accountId: "account" },
};
const observation = {
	id: "observation-1",
	pageId: "page-1",
	origin: "https://example.org",
	version: 1,
	inputRevision: 0,
	observedAt: 1000,
};
function initial() {
	return createInteractiveTask({
		id: "task-1",
		goalRef: "goal-1",
		owner,
		now: 1000,
		authorization: {
			decisionId: "grant-1",
			policyRevision: "policy-1",
			decidedAt: new Date(1000).toISOString(),
			state: "active",
			revokedAt: null,
		},
		allowedCapabilities: ["fill"],
		allowedOrigins: [observation.origin],
	});
}
function move(task: InteractiveTask, transition: TaskTransition, now = 1001) {
	return transitionInteractiveTask(
		task,
		{ owner, expectedRevision: task.revision, now },
		transition,
	).task;
}
function proposal(task: InteractiveTask): TaskActionProposal {
	return {
		id: "operation-1",
		taskId: task.id,
		epoch: task.epoch,
		observationId: observation.id,
		observationVersion: observation.version,
		inputRevision: observation.inputRevision,
		targetRef: "target-1",
		valueRef: "value-1",
		capability: "fill",
		authorizationId: "grant-1",
		expiresAt: 2000,
	};
}
function prepared() {
	const observed = move(initial(), { type: "observe", observation });
	return move(observed, { type: "prepare", proposal: proposal(observed) });
}
function dispatched() {
	return move(prepared(), { type: "dispatch", operationId: "operation-1" });
}

describe("interactive task lifecycle", () => {
	it("commits one operation and preserves immutable prior state", () => {
		const before = prepared();
		const waiting = move(before, {
			type: "dispatch",
			operationId: "operation-1",
		});
		expect(before.operations[0].status).toBe("prepared");
		const done = move(waiting, {
			type: "result",
			operationId: "operation-1",
			status: "succeeded",
			evidenceRef: "receipt-1",
		});
		expect(done.status).toBe("active");
		expect(() =>
			move(done, { type: "prepare", proposal: proposal(done) }),
		).toThrow(/replayed/);
		expect(() =>
			move(done, {
				type: "result",
				operationId: "operation-1",
				status: "failed",
				evidenceRef: "receipt-2",
			}),
		).toThrow();
		expect(move(done, { type: "complete" }).status).toBe("completed");
	});
	it("rejects another owner and concurrent revisions", () => {
		const task = initial();
		expect(() =>
			transitionInteractiveTask(
				task,
				{
					owner: {
						...owner,
						connector: { ...owner.connector, accountId: "other" },
					},
					expectedRevision: 0,
					now: 1001,
				},
				{ type: "pause" },
			),
		).toThrow(/another owner/);
		expect(() =>
			transitionInteractiveTask(
				task,
				{ owner, expectedRevision: 1, now: 1001 },
				{ type: "pause" },
			),
		).toThrow(/revision/);
	});
	it("invalidates a prepared action on manual input or navigation", () => {
		const task = prepared();
		const changed = move(task, {
			type: "observe",
			observation: {
				...observation,
				id: "observation-2",
				version: 2,
				inputRevision: 1,
			},
		});
		expect(changed.operations[0].status).toBe("cancelled");
		expect(() =>
			move(changed, { type: "dispatch", operationId: "operation-1" }),
		).toThrow();
		expect(() =>
			move(task, {
				type: "observe",
				observation: {
					...observation,
					version: 2,
					origin: "https://attacker.example",
				},
			}),
		).toThrow(/scope/);
	});
	it("requires a fresh observation after pause and rejects expired or forbidden actions", () => {
		const task = move(prepared(), { type: "pause" });
		expect(() => move(task, { type: "resume", observation })).toThrow(
			/monotonically/,
		);
		const resumed = move(task, {
			type: "resume",
			observation: { ...observation, id: "observation-2", version: 2 },
		});
		expect(() =>
			move(resumed, {
				type: "prepare",
				proposal: { ...proposal(task), id: "operation-2" },
			}),
		).toThrow(/observed task/);
		expect(() =>
			move(prepared(), { type: "dispatch", operationId: "operation-1" }, 2000),
		).toThrow(/expired/);
		const observed = move(initial(), { type: "observe", observation });
		expect(() =>
			move(observed, {
				type: "prepare",
				proposal: { ...proposal(observed), capability: "submit" },
			}),
		).toThrow(/authorization/);
	});
	it.each(["pause", "recover", "cancel", "revoke"] as const)(
		"preserves an unknown dispatched outcome after %s",
		(type) => {
			const task = move(dispatched(), { type });
			expect(task.operations[0].status).toBe("unknown");
			expect(() =>
				move(task, { type: "dispatch", operationId: "operation-1" }),
			).toThrow();
			expect(() =>
				move(task, {
					type: "result",
					operationId: "operation-1",
					status: "succeeded",
					evidenceRef: "late-receipt",
				}),
			).toThrow();
			const reconciled = move(task, {
				type: "reconcile",
				operationId: "operation-1",
				status: "succeeded",
				evidenceRef: "readback-1",
			});
			expect(reconciled.operations[0].evidenceRef).toBe("readback-1");
			expect(reconciled.status).toBe(
				type === "cancel" ? "cancelled" : "paused",
			);
			if (type === "revoke")
				expect(() =>
					move(reconciled, {
						type: "resume",
						observation: { ...observation, version: 2 },
					}),
				).toThrow(/revoked/);
		},
	);
	it("requires evidence for reconciliation and cannot complete an unknown operation", () => {
		const task = move(dispatched(), {
			type: "result",
			operationId: "operation-1",
			status: "unknown",
		});
		expect(task.status).toBe("blocked");
		expect(() => move(task, { type: "complete" })).toThrow(/unresolved/);
		expect(() =>
			move(task, {
				type: "reconcile",
				operationId: "operation-1",
				status: "succeeded",
			}),
		).toThrow(/evidence/);
	});
	it("rejects inconsistent durable operation states", () => {
		const waiting = dispatched();
		expect(() =>
			validateInteractiveTask({ ...waiting, status: "active" }),
		).toThrow(/disagree/);
		expect(() =>
			validateInteractiveTask({ ...initial(), status: "waiting" }),
		).toThrow(/disagree/);
		const done = move(waiting, {
			type: "result",
			operationId: "operation-1",
			status: "succeeded",
			evidenceRef: "receipt",
		});
		delete done.operations[0].evidenceRef;
		expect(() => validateInteractiveTask(done)).toThrow(/evidence/);
	});

	it("rejects malformed persisted records and unexpected content fields", () => {
		for (const value of [
			null,
			{ ...initial(), rawPage: "private content" },
			{ ...initial(), observation: {} },
			{ ...initial(), operations: [null] },
			{ ...initial(), owner: { ...owner, token: "secret" } },
		]) {
			expect(() => validateInteractiveTask(value as InteractiveTask)).toThrow(
				expect.objectContaining({ code: "TASK_INVALID" }),
			);
		}
	});
});
