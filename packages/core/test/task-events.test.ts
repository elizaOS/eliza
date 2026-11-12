import { describe, expect, it } from "vitest";
import {
	createInteractiveTask,
	type InteractiveTask,
	type TaskTransition,
	transitionInteractiveTask,
} from "../src/messaging/interactive-task";
import {
	TASK_EVENT_KINDS,
	type TaskEventKind,
	validateTaskEvent,
} from "../src/messaging/task-events";

const ORIGIN = "https://example.org";
const owner = {
	actorId: "actor",
	agentId: "agent",
	connector: { source: "browser", accountId: "account" },
};

function event(kind: string, extra: Record<string, unknown> = {}) {
	return {
		schemaVersion: 1,
		eventId: kind === "create" ? "task-1#0" : "task-1#3",
		taskId: "task-1",
		sequence: kind === "create" ? 0 : 3,
		epoch: kind === "create" ? 0 : 1,
		kind,
		at: 1000,
		status: "active",
		...extra,
	};
}

/** The smallest event each kind of the table admits. */
function minimal(kind: TaskEventKind) {
	const shape = TASK_EVENT_KINDS[kind];
	return event(kind, {
		...(shape.operation && {
			operationId: "op-1",
			operationStatus: shape.operation[0],
		}),
		...(shape.origin === "required" && { origin: ORIGIN }),
	});
}

describe("task event kinds", () => {
	it("admits every kind in the table with the fields it declares", () => {
		for (const kind of Object.keys(TASK_EVENT_KINDS) as TaskEventKind[]) {
			expect(() => validateTaskEvent(minimal(kind)), kind).not.toThrow();
			for (const status of TASK_EVENT_KINDS[kind].operation ?? [])
				expect(() =>
					validateTaskEvent({ ...minimal(kind), operationStatus: status }),
				).not.toThrow();
		}
		expect(() => validateTaskEvent(event("unknown-kind"))).toThrow(
			/Invalid task event state/,
		);
	});

	it("rejects an operation event without its operation", () => {
		for (const kind of ["prepare", "dispatch", "result", "reconcile"]) {
			expect(() => validateTaskEvent(event(kind)), kind).toThrow(
				/Invalid event operation/,
			);
			expect(() =>
				validateTaskEvent(event(kind, { operationId: "op-1" })),
			).toThrow(/Invalid event operation status/);
		}
		expect(() =>
			validateTaskEvent(
				event("dispatch", {
					operationId: "op-1",
					operationStatus: "succeeded",
				}),
			),
		).toThrow(/Invalid event operation status/);
		expect(() =>
			validateTaskEvent(
				event("pause", { operationId: "op-1", operationStatus: "succeeded" }),
			),
		).toThrow(/its kind does not have/);
	});
});

describe("task event producers", () => {
	it("records the operation and its status on every operation event", () => {
		let task: InteractiveTask = createInteractiveTask({
			id: "task-1",
			goalRef: "goal-1",
			owner,
			now: 1000,
			authorization: {
				decisionId: "grant",
				policyRevision: "policy",
				state: "active",
				decidedAt: new Date(1000).toISOString(),
				revokedAt: null,
			},
			allowedCapabilities: ["fill"],
			allowedOrigins: [ORIGIN],
		});
		let now = 1000;
		const events: ReturnType<typeof transitionInteractiveTask>["event"][] = [];
		const step = (transition: TaskTransition) => {
			now++;
			const next = transitionInteractiveTask(
				task,
				{ owner, expectedRevision: task.revision, now },
				transition,
			);
			task = next.task;
			events.push(next.event);
		};
		const observe = (id: string): TaskTransition => ({
			type: "observe",
			observation: {
				id,
				pageId: "page-1",
				version: 1,
				inputRevision: 0,
				origin: ORIGIN,
				observedAt: now + 1,
			},
		});
		const prepare = (id: string, observationId: string): TaskTransition => ({
			type: "prepare",
			proposal: {
				id,
				taskId: task.id,
				epoch: task.epoch,
				observationId,
				observationVersion: 1,
				inputRevision: 0,
				targetRef: "field-1",
				capability: "fill",
				authorizationId: "grant",
				expiresAt: 9000,
			},
		});
		step(observe("view-1"));
		step(prepare("op-1", "view-1"));
		step({ type: "dispatch", operationId: "op-1" });
		step({
			type: "result",
			operationId: "op-1",
			status: "succeeded",
			evidenceRef: "evidence-1",
		});
		step(prepare("op-2", "view-1"));
		step({ type: "dispatch", operationId: "op-2" });
		step({ type: "pause" });
		step({
			type: "reconcile",
			operationId: "op-2",
			status: "failed",
			evidenceRef: "readback-1",
		});
		expect(
			events.map(({ kind, operationId, operationStatus }) => [
				kind,
				operationId,
				operationStatus,
			]),
		).toEqual([
			["observe", undefined, undefined],
			["prepare", "op-1", "prepared"],
			["dispatch", "op-1", "dispatched"],
			["result", "op-1", "succeeded"],
			["prepare", "op-2", "prepared"],
			["dispatch", "op-2", "dispatched"],
			["pause", undefined, undefined],
			["reconcile", "op-2", "failed"],
		]);
	});
});
