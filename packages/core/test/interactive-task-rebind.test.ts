import { describe, expect, it } from "vitest";
import {
	createInteractiveTask,
	type InteractiveTask,
	type TaskTransition,
	transitionInteractiveTask,
} from "../src/messaging/interactive-task";

const ORIGIN = "https://example.org";
const owner = {
	actorId: "actor",
	agentId: "agent",
	connector: { source: "browser", accountId: "account" },
};

/** A task driven through the reducer, one transition at a time. */
function task() {
	let now = 1000;
	let current: InteractiveTask = createInteractiveTask({
		id: "task-1",
		goalRef: "goal-1",
		owner,
		now,
		authorization: {
			decisionId: "grant",
			policyRevision: "policy",
			state: "active",
			decidedAt: new Date(now).toISOString(),
			revokedAt: null,
		},
		allowedCapabilities: ["fill"],
		allowedOrigins: [ORIGIN],
	});
	const step = (transition: TaskTransition) => {
		now++;
		current = transitionInteractiveTask(
			current,
			{ owner, expectedRevision: current.revision, now },
			transition,
		).task;
		return current;
	};
	return {
		get: () => current,
		step,
		observe: () =>
			step({
				type: "observe",
				observation: {
					id: `view-${now}`,
					pageId: "page-1",
					version: (current.observation?.version ?? 0) + 1,
					inputRevision: 0,
					origin: ORIGIN,
					observedAt: now + 1,
				},
			}),
		prepare: (id: string) =>
			step({
				type: "prepare",
				proposal: {
					id,
					taskId: current.id,
					epoch: current.epoch,
					observationId: current.observation?.id ?? "",
					observationVersion: current.observation?.version ?? 0,
					inputRevision: 0,
					targetRef: "field-1",
					capability: "fill",
					authorizationId: "grant",
					expiresAt: 9000,
				},
			}),
	};
}

describe("a new binding (rebind)", () => {
	it("keeps the task active, starts an epoch and needs a fresh observation", () => {
		const t = task();
		t.observe();
		t.prepare("op-1");
		const before = t.get();
		const after = t.step({ type: "rebind" });
		expect(after).toMatchObject({
			status: "active",
			epoch: before.epoch + 1,
			observation: null,
		});
		expect(after.operations.map((op) => op.status)).toEqual(["cancelled"]);
	});

	it("is refused while a dispatched press has no answer", () => {
		const t = task();
		t.observe();
		t.prepare("op-1");
		t.step({ type: "dispatch", operationId: "op-1" });
		const before = t.get();
		expect(() => t.step({ type: "rebind" })).toThrow(
			expect.objectContaining({ code: "TASK_NOT_ACTIVE" }),
		);
		expect(t.get()).toBe(before);
	});

	it("is refused while a press has an unknown outcome", () => {
		const t = task();
		t.observe();
		t.prepare("op-1");
		t.step({ type: "dispatch", operationId: "op-1" });
		t.step({ type: "result", operationId: "op-1", status: "unknown" });
		const before = t.get();
		expect(() => t.step({ type: "rebind" })).toThrow(
			expect.objectContaining({ code: "TASK_NOT_ACTIVE" }),
		);
		expect(t.get()).toBe(before);
	});

	it("is refused once the task's authorization is revoked", () => {
		const t = task();
		t.observe();
		t.step({ type: "revoke" });
		expect(() => t.step({ type: "rebind" })).toThrow(
			expect.objectContaining({ code: "TASK_NOT_ACTIVE" }),
		);
	});
});
