/** Browser-safe, host-neutral task activity protocol. No page text or credentials. */
import { ElizaError } from "../errors.ts";

/**
 * A task id as hosts mint and accept it: a letter or digit, then up to 255
 * letters, digits or `_ . : @ -`. `packages/agent/native-host/task-id.mjs`
 * holds the same rule for staged hosts that cannot import this package.
 */
export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;
/** An opaque journal reference: the task id rule, also admitting `/`. */
const OPAQUE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;

const TASK_STATUSES = [
	"active",
	"paused",
	"blocked",
	"waiting",
	"completed",
	"cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
const TASK_OPERATION_STATUSES = [
	"prepared",
	"dispatched",
	"succeeded",
	"failed",
	"cancelled",
	"unknown",
] as const;
export type TaskOperationStatus = (typeof TASK_OPERATION_STATUSES)[number];

interface TaskEventShape {
	/** The operation statuses this kind records, or null when it names no operation. */
	operation: readonly TaskOperationStatus[] | null;
	origin: "none" | "optional" | "required";
}
/**
 * Every event kind and the fields it carries: the one list the type and the
 * validator read. Operation kinds always name their operation and the status
 * the reducer left it in.
 */
export const TASK_EVENT_KINDS = {
	create: { operation: null, origin: "none" },
	checkpoint: { operation: null, origin: "none" },
	observe: { operation: null, origin: "optional" },
	resume: { operation: null, origin: "optional" },
	rebind: { operation: null, origin: "none" },
	pause: { operation: null, origin: "none" },
	cancel: { operation: null, origin: "none" },
	recover: { operation: null, origin: "none" },
	revoke: { operation: null, origin: "none" },
	complete: { operation: null, origin: "none" },
	prepare: { operation: ["prepared"], origin: "none" },
	dispatch: { operation: ["dispatched"], origin: "none" },
	result: { operation: ["succeeded", "failed", "unknown"], origin: "none" },
	reconcile: { operation: ["succeeded", "failed", "unknown"], origin: "none" },
	"extend-origin": { operation: null, origin: "required" },
	"retract-origin": { operation: null, origin: "required" },
} as const satisfies Record<string, TaskEventShape>;
export type TaskEventKind = keyof typeof TASK_EVENT_KINDS;

interface TaskEventBase {
	schemaVersion: 1;
	eventId: string;
	taskId: string;
	sequence: number;
	epoch: number;
	at: number;
	status: TaskStatus;
}
type OperationFields<S extends TaskEventShape> =
	S["operation"] extends readonly TaskOperationStatus[]
		? { operationId: string; operationStatus: S["operation"][number] }
		: { operationId?: never; operationStatus?: never };
/**
 * Extended tasks: the origin granted or retracted, or the observed page's
 * origin. Never a path or query.
 */
type OriginFields<S extends TaskEventShape> = S["origin"] extends "required"
	? { origin: string }
	: S["origin"] extends "optional"
		? { origin?: string }
		: { origin?: never };
export type TaskEvent = {
	[K in TaskEventKind]: TaskEventBase & { kind: K } & OperationFields<
			(typeof TASK_EVENT_KINDS)[K]
		> &
		OriginFields<(typeof TASK_EVENT_KINDS)[K]>;
}[TaskEventKind];

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
const optional = ["operationId", "operationStatus", "origin"];
const eventKeys = [...fields, ...optional] as (keyof TaskEvent)[];
function includes<T extends string>(
	list: readonly T[],
	value: unknown,
): value is T {
	return (list as readonly unknown[]).includes(value);
}
export function validateTaskEvent(value: unknown): asserts value is TaskEvent {
	if (!value || typeof value !== "object" || Array.isArray(value))
		reject("Expected a task event");
	const event = value as Record<string, unknown>;
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
		!OPAQUE_REF_PATTERN.test(event.taskId) ||
		[event.sequence, event.epoch, event.at].some(
			(n) => !Number.isSafeInteger(n) || Number(n) < 0,
		) ||
		event.eventId !== `${event.taskId}#${event.sequence}`
	)
		reject("Invalid task event identity");
	if (
		typeof event.kind !== "string" ||
		!Object.hasOwn(TASK_EVENT_KINDS, event.kind) ||
		!includes(TASK_STATUSES, event.status)
	)
		reject("Invalid task event state");
	const shape: TaskEventShape = TASK_EVENT_KINDS[event.kind as TaskEventKind];
	if (shape.operation === null) {
		if (event.operationId !== undefined || event.operationStatus !== undefined)
			reject("Task event names an operation its kind does not have");
	} else {
		if (
			typeof event.operationId !== "string" ||
			!OPAQUE_REF_PATTERN.test(event.operationId)
		)
			reject("Invalid event operation");
		if (!includes(shape.operation, event.operationStatus))
			reject("Invalid event operation status");
	}
	if (event.origin !== undefined) {
		let parsed: URL | undefined;
		try {
			parsed = new URL(String(event.origin));
		} catch {
			parsed = undefined;
		}
		if (
			shape.origin === "none" ||
			parsed?.protocol !== "https:" ||
			parsed.origin !== event.origin
		)
			reject("Invalid event origin");
	} else if (shape.origin === "required")
		reject("Origin scope event is missing its origin");
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
	for (const values of [previous, incoming]) {
		for (const value of values) {
			validateTaskEvent(value);
			if (value.taskId !== taskId)
				reject("Task event belongs to a different task");
			const duplicate = known.get(value.sequence);
			if (duplicate) {
				if (eventKeys.some((key) => duplicate[key] !== value[key]))
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
		!includes(TASK_STATUSES, page.task.status) ||
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
		if (!OPAQUE_REF_PATTERN.test(taskId)) throw new Error("Invalid task ID");
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
