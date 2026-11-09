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

	it("accepts a view stamped at task time while the clock is behind", () => {
		const view = (version: number, observedAt: number) => ({
			id: `view-${version}`,
			pageId: "page",
			origin: A,
			version,
			inputRevision: 0,
			observedAt,
		});
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
			observation: view(1, T + 20),
		}).task;
		task = run(task, T + 1, {
			type: "observe",
			observation: view(2, T + 20),
		}).task;
		expect(task.observation?.version).toBe(2);
		task = run(task, T + 1, { type: "pause" }).task;
		task = run(task, T + 1, {
			type: "resume",
			observation: view(3, T + 20),
		}).task;
		expect(task.status).toBe("active");
		expect(task.updatedAt).toBe(T + 20);
		// Still later than task time is still from the future.
		expect(() =>
			run(task, T + 1, { type: "observe", observation: view(4, T + 21) }),
		).toThrow("Observation is from the future");
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

	it("after a forward clock jump is corrected, still stops but cannot act until real time catches up", () => {
		const YEAR = 365 * 24 * 60 * 60 * 1000;
		const view = (version: number, observedAt: number) => ({
			id: `view-${version}`,
			pageId: "page",
			origin: A,
			version,
			inputRevision: 0,
			observedAt,
		});
		const proposal = (task: InteractiveTask, version: number, now: number) => ({
			id: `op-${version}`,
			taskId: task.id,
			epoch: task.epoch,
			observationId: `view-${version}`,
			observationVersion: version,
			inputRevision: 0,
			targetRef: "button",
			capability: "click",
			authorizationId: "grant",
			// The actuator leases from its own clock.
			expiresAt: now + 30_000,
		});
		const start = (id: string, now: number) =>
			createInteractiveTask({
				id,
				owner,
				goalRef: "goal",
				now,
				authorization: {
					decisionId: "grant",
					policyRevision: "policy",
					decidedAt: new Date(now).toISOString(),
					state: "active",
					revokedAt: null,
				},
				allowedCapabilities: ["click"],
				allowedOrigins: [A],
			});
		let task = start("task-1", T);
		// The clock jumps a year ahead while a view is recorded, then NTP fixes it.
		task = run(task, T + YEAR, {
			type: "observe",
			observation: view(1, T + YEAR),
		}).task;
		expect(task.updatedAt).toBe(T + YEAR);
		const now = T + 5;
		task = run(task, now, { type: "observe", observation: view(2, now) }).task;
		expect(task.updatedAt).toBe(T + YEAR);
		expect(() =>
			run(task, now, { type: "prepare", proposal: proposal(task, 2, now) }),
		).toThrow(
			expect.objectContaining({
				code: "TASK_STALE_ACTION",
				message: expect.stringContaining("ahead of this clock"),
			}),
		);
		// A stop still works, and a new task acts on the corrected clock.
		expect(run(task, now, { type: "cancel" }).task.status).toBe("cancelled");
		let next = start("task-2", now + 1);
		next = run(next, now + 2, {
			type: "observe",
			observation: view(1, now + 2),
		}).task;
		next = run(next, now + 3, {
			type: "prepare",
			proposal: proposal(next, 1, now + 3),
		}).task;
		expect(next.operations[0].status).toBe("prepared");
	});
});
