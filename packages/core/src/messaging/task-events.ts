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

export interface TaskEventPage {
	events: TaskEvent[];
	cursor: number;
	hasMore: boolean;
	task: {
		id: string;
		revision: number;
		epoch: number;
		status: TaskStatus;
		hasUnknownOutcome: boolean;
	};
}

/** Admit a complete page against the last accepted history, without losing it on error. */
export function mergeTaskEventPage(
	taskId: string,
	previous: TaskEventPage | null,
	value: unknown,
): TaskEventPage {
	const page = value as TaskEventPage;
	if (
		!page ||
		!Array.isArray(page.events) ||
		page.events.length > 128 ||
		!Number.isSafeInteger(page.cursor) ||
		page.cursor < -1 ||
		typeof page.hasMore !== "boolean" ||
		page.task?.id !== taskId ||
		!Number.isSafeInteger(page.task.revision) ||
		page.task.revision < 0 ||
		!Number.isSafeInteger(page.task.epoch) ||
		page.task.epoch < 0 ||
		![
			"active",
			"paused",
			"waiting",
			"blocked",
			"completed",
			"cancelled",
		].includes(page.task.status) ||
		typeof page.task.hasUnknownOutcome !== "boolean"
	)
		reject("Invalid task event page");
	if (
		previous &&
		(page.task.revision < previous.task.revision ||
			page.task.epoch < previous.task.epoch)
	)
		reject("Task event page moved backwards");
	const events = mergeTaskEvents(taskId, previous?.events ?? [], page.events);
	const cursor = events.at(-1)?.sequence ?? -1;
	if (
		page.cursor !== cursor ||
		cursor > page.task.revision ||
		(page.hasMore && cursor <= (previous?.cursor ?? -1)) ||
		(!page.hasMore && cursor !== page.task.revision)
	)
		reject("Incomplete task event page");
	return {
		events,
		cursor,
		hasMore: page.hasMore,
		task: {
			id: taskId,
			revision: page.task.revision,
			epoch: page.task.epoch,
			status: page.task.status,
			hasUnknownOutcome: page.task.hasUnknownOutcome,
		},
	};
}

export interface TaskEventReaderState {
	page: TaskEventPage | null;
	pending: boolean;
	failed: boolean;
}
export interface TaskEventReaderOptions {
	/** Read only. Implementations must not dispatch or replay task actions. */
	read: (taskId: string, after: number) => Promise<unknown>;
	changed: (state: TaskEventReaderState) => void;
	pollIntervalMs?: number;
}

/** Read-only paged history with single-flight polling and stale-response fencing. */
export class TaskEventReader {
	private readonly options: TaskEventReaderOptions;
	private readonly interval: number;
	private generation = 0;
	private taskId: string | null = null;
	private state: TaskEventReaderState = {
		page: null,
		pending: false,
		failed: false,
	};
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: TaskEventReaderOptions) {
		this.interval = options.pollIntervalMs ?? 2000;
		if (
			!Number.isSafeInteger(this.interval) ||
			this.interval < 1 ||
			this.interval > 2147483647
		)
			throw new Error("Invalid task event polling interval");
		this.options = { ...options };
	}
	private publish() {
		// Observers cannot mutate the admitted history or its cursor.
		this.options.changed(structuredClone(this.state));
	}
	start(taskId: string): Promise<void> {
		if (!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(taskId))
			throw new Error("Invalid task ID");
		this.stop();
		this.taskId = taskId;
		this.state = { page: null, pending: false, failed: false };
		return this.refresh();
	}
	/** Detach without publishing. Safe for unmount and immediately reusable. */
	stop(): void {
		++this.generation;
		clearTimeout(this.timer);
		this.timer = undefined;
		this.taskId = null;
		this.state = { ...this.state, pending: false };
	}
	async refresh(): Promise<void> {
		if (!this.taskId || this.state.pending) return;
		clearTimeout(this.timer);
		this.timer = undefined;
		const taskId = this.taskId;
		const ticket = ++this.generation;
		this.state = { ...this.state, pending: true, failed: false };
		this.publish();
		let again = false;
		try {
			while (ticket === this.generation) {
				const value = await this.options.read(
					taskId,
					this.state.page?.cursor ?? -1,
				);
				if (ticket !== this.generation) return;
				const page = mergeTaskEventPage(taskId, this.state.page, value);
				this.state = { page, pending: true, failed: false };
				this.publish();
				if (ticket !== this.generation) return;
				if (!page.hasMore) {
					again =
						!["completed", "cancelled"].includes(page.task.status) ||
						page.task.hasUnknownOutcome;
					break;
				}
			}
		} catch {
			if (ticket === this.generation)
				this.state = { ...this.state, failed: true };
		} finally {
			if (ticket === this.generation) {
				this.state = { ...this.state, pending: false };
				this.publish();
				if (again && ticket === this.generation)
					this.timer = setTimeout(() => void this.refresh(), this.interval);
			}
		}
	}
}
