/** Browser-safe, host-neutral task activity protocol. No page text or credentials. */
import { ElizaError } from "../errors.ts";

export type TaskStatus =
	| "active"
	| "paused"
	| "blocked"
	| "waiting"
	| "completed"
	| "cancelled";
export type TaskOperationStatus =
	| "prepared"
	| "dispatched"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "unknown";
export interface TaskEvent {
	schemaVersion: 1;
	eventId: string;
	taskId: string;
	sequence: number;
	epoch: number;
	kind:
		| "create"
		| "checkpoint"
		| "observe"
		| "resume"
		| "pause"
		| "cancel"
		| "recover"
		| "revoke"
		| "complete"
		| "prepare"
		| "dispatch"
		| "result"
		| "reconcile";
	at: number;
	status: TaskStatus;
	operationId?: string;
	operationStatus?: TaskOperationStatus;
}
function reject(message: string): never {
	throw new ElizaError(message, { code: "TASK_EVENT_INVALID" });
}
const fields = [
	"schemaVersion",
	"eventId",
	"taskId",
	"sequence",
	"epoch",
	"kind",
	"at",
	"status",
];
const optional = ["operationId", "operationStatus"];
export function validateTaskEvent(value: unknown): asserts value is TaskEvent {
	if (!value || typeof value !== "object" || Array.isArray(value))
		reject("Expected a task event");
	const event = value as TaskEvent;
	if (
		fields.some((key) => !(key in value)) ||
		Object.keys(value).some(
			(key) => !fields.includes(key) && !optional.includes(key),
		)
	)
		reject("Unexpected task event fields");
	if (
		event.schemaVersion !== 1 ||
		typeof event.taskId !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(event.taskId) ||
		[event.sequence, event.epoch, event.at].some(
			(n) => !Number.isSafeInteger(n) || n < 0,
		) ||
		event.eventId !== `${event.taskId}#${event.sequence}`
	)
		reject("Invalid task event identity");
	if (
		![
			"create",
			"checkpoint",
			"observe",
			"resume",
			"pause",
			"cancel",
			"recover",
			"revoke",
			"complete",
			"prepare",
			"dispatch",
			"result",
			"reconcile",
		].includes(event.kind) ||
		![
			"active",
			"paused",
			"blocked",
			"waiting",
			"completed",
			"cancelled",
		].includes(event.status)
	)
		reject("Invalid task event state");
	if (
		event.operationId !== undefined &&
		(typeof event.operationId !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(event.operationId))
	)
		reject("Invalid event operation");
	if (
		event.operationStatus !== undefined &&
		(!event.operationId ||
			![
				"prepared",
				"dispatched",
				"succeeded",
				"failed",
				"cancelled",
				"unknown",
			].includes(event.operationStatus))
	)
		reject("Invalid event operation status");
	if (
		event.kind === "create" &&
		(event.sequence !== 0 || event.epoch !== 0 || event.status !== "active")
	)
		reject("Invalid task creation event");
}

/** Replayed pages are harmless; conflicting duplicates, wrong tasks and gaps reject. */
export function mergeTaskEvents(
	taskId: string,
	previous: readonly TaskEvent[],
	incoming: readonly unknown[],
): TaskEvent[] {
	const merged: TaskEvent[] = [];
	const known = new Map<number, TaskEvent>();
	for (const value of [...previous, ...incoming]) {
		validateTaskEvent(value);
		if (value.taskId !== taskId)
			reject("Task event belongs to a different task");
		const duplicate = known.get(value.sequence);
		if (duplicate) {
			if (
				[...fields, ...optional].some(
					(key) =>
						duplicate[key as keyof TaskEvent] !== value[key as keyof TaskEvent],
				)
			)
				reject("Conflicting task event replay");
			continue;
		}
		const last = merged.at(-1);
		if (
			(!last &&
				value.kind !== "checkpoint" &&
				(value.kind !== "create" || value.sequence !== 0)) ||
			(last &&
				(value.sequence !== last.sequence + 1 || value.epoch < last.epoch))
		)
			reject("Task event history has a gap or moved backwards");
		const event = structuredClone(value);
		known.set(event.sequence, event);
		merged.push(event);
	}
	return merged;
}
