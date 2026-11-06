import { describe, expect, it } from "vitest";
import {
	createInteractiveTask,
	type InteractiveTask,
	type TaskTransition,
	transitionInteractiveTask,
	validateInteractiveTask,
} from "../src/messaging/interactive-task";

const T = Date.parse("2026-11-05T12:00:00.000Z");
const A = "https://a.example";
const B = "https://b.example";
const owner = {
	actorId: "actor",
	agentId: "agent",
	connector: { source: "browser", accountId: "account" },
};

function run(task: InteractiveTask, now: number, transition: TaskTransition) {
	return transitionInteractiveTask(
		task,
		{ owner, expectedRevision: task.revision, now },
		transition,
	);
}

/** A task waiting on a dispatched action at T; extended to B when asked. */
function dispatched(extended = false): InteractiveTask {
	let task = createInteractiveTask({
		id: "task-1",
		owner,
		goalRef: "goal",
		now: T - 10,
		authorization: {
			decisionId: "grant",
			policyRevision: "policy",
			decidedAt: new Date(T - 10).toISOString(),
			state: "active",
			revokedAt: null,
		},
		allowedCapabilities: ["click"],
		allowedOrigins: [A],
	});
	if (extended)
		task = run(task, T - 9, {
			type: "extend-origin",
			origin: B,
			checkRef: "check",
		}).task;
	task = run(task, T - 8, {
		type: "observe",
		observation: {
			id: "view-1",
			pageId: "page",
			origin: A,
			version: 1,
			inputRevision: 0,
			observedAt: T - 8,
		},
	}).task;
	task = run(task, T - 5, {
		type: "prepare",
		proposal: {
			id: "op-1",
			taskId: task.id,
			epoch: task.epoch,
			observationId: "view-1",
			observationVersion: 1,
			inputRevision: 0,
			targetRef: "button",
			capability: "click",
			authorizationId: "grant",
			expiresAt: T + 60_000,
		},
	}).task;
	return run(task, T, { type: "dispatch", operationId: "op-1" }).task;
}

const STEPS_BACK = [1, 60_000, 30 * 24 * 60 * 60_000];
const STOPS: TaskTransition["type"][] = [
	"pause",
	"cancel",
	"revoke",
	"recover",
	"retract-origin",
];

describe("interactive task clock", () => {
	for (const back of STEPS_BACK) {
		it(`stops a dispatched action when the clock is ${back} ms behind`, () => {
			for (const type of STOPS) {
				const previous = dispatched(type === "retract-origin");
				const transition = (
					type === "retract-origin" ? { type, origin: B } : { type }
				) as TaskTransition;
				const { task, event } = run(
					previous,
					previous.updatedAt - back,
					transition,
				);
				validateInteractiveTask(task);
				expect(task.updatedAt).toBe(previous.updatedAt);
				expect(event.at).toBe(task.updatedAt);
				expect(task.epoch).toBe(previous.epoch + 1);
				expect(task.operations[0].status).toBe("unknown");
				expect(task.status).toBe(type === "cancel" ? "cancelled" : "paused");
				if (type === "revoke")
					expect(task.authorization.revokedAt).toBe(
						new Date(previous.updatedAt).toISOString(),
					);
			}
		});

		it(`records a result when the clock is ${back} ms behind`, () => {
			const previous = dispatched();
			const { task, event } = run(previous, previous.updatedAt - back, {
				type: "result",
				operationId: "op-1",
				status: "succeeded",
				evidenceRef: "receipt",
			});
			expect(task.status).toBe("active");
			expect(task.operations[0].status).toBe("succeeded");
			expect(event.at).toBe(previous.updatedAt);
		});
	}

	it("keeps task time where it was, and moves on once the clock catches up", () => {
		const previous = dispatched();
		const paused = run(previous, T - 1, { type: "pause" }).task;
		expect(paused.updatedAt).toBe(T);
		expect(run(paused, T + 7, { type: "cancel" }).task.updatedAt).toBe(T + 7);
	});

	it("never revives an action that expired against the stored time", () => {
		let task = createInteractiveTask({
			id: "task-1",
			owner,
			goalRef: "goal",
			now: T,
			authorization: {
				decisionId: "grant",
				policyRevision: "policy",
				decidedAt: new Date(T).toISOString(),
				state: "active",
				revokedAt: null,
			},
			allowedCapabilities: ["click"],
			allowedOrigins: [A],
		});
		task = run(task, T + 20, {
			type: "observe",
			observation: {
				id: "view-1",
				pageId: "page",
				origin: A,
				version: 1,
				inputRevision: 0,
				observedAt: T + 20,
			},
		}).task;
		expect(() =>
			run(task, T + 1, {
				type: "prepare",
				proposal: {
					id: "op-1",
					taskId: task.id,
					epoch: task.epoch,
					observationId: "view-1",
					observationVersion: 1,
					inputRevision: 0,
					targetRef: "button",
					capability: "click",
					authorizationId: "grant",
					expiresAt: T + 15,
				},
			}),
		).toThrow(expect.objectContaining({ code: "TASK_STALE_ACTION" }));
	});
});
