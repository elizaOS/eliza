import { afterEach, describe, expect, it, vi } from "vitest";
import {
	mergeTaskEventPage,
	type TaskEvent,
	type TaskEventPage,
	TaskEventReader,
	type TaskEventReaderState,
} from "./task-events.ts";

const event = (sequence: number, taskId = "task"): TaskEvent => ({
	schemaVersion: 1,
	taskId,
	eventId: `${taskId}#${sequence}`,
	sequence,
	epoch: 0,
	kind: sequence ? "observe" : "create",
	at: sequence,
	status: "active",
});
const page = (
	events: TaskEvent[],
	overrides: Partial<TaskEventPage> = {},
): TaskEventPage => ({
	events,
	cursor: events.at(-1)?.sequence ?? -1,
	hasMore: false,
	task: {
		id: "task",
		revision: events.at(-1)?.sequence ?? 0,
		epoch: 0,
		status: "active",
		hasUnknownOutcome: false,
	},
	...overrides,
});
function deferred() {
	let resolve!: (value: unknown) => void;
	const promise = new Promise<unknown>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
afterEach(() => vi.useRealTimers());
describe("task event reader", () => {
	it("traverses every page once, deduplicates repeated events, and isolates observer mutation", async () => {
		const calls: number[] = [];
		const states: TaskEventReaderState[] = [];
		const first = page([event(0)], {
			hasMore: true,
			task: { ...page([]).task, revision: 2 },
		});
		const reader = new TaskEventReader({
			read: async (_, after) => {
				calls.push(after);
				return after === -1
					? first
					: page([event(0), event(1), event(2)], {
							task: { ...first.task, status: "completed" },
						});
			},
			changed: (s) => {
				states.push(structuredClone(s));
				if (s.page) s.page.events.length = 0;
			},
		});
		await reader.start("task");
		expect(calls).toEqual([-1, 0]);
		expect(states.at(-1)?.page?.events).toEqual([event(0), event(1), event(2)]);
		expect(states.at(-1)?.pending).toBe(false);
		reader.stop();
	});
	it("retains last admitted page on malformed continuation, then retries from its cursor", async () => {
		let malformed = true;
		let state!: TaskEventReaderState;
		const calls: number[] = [];
		const reader = new TaskEventReader({
			read: async (_, after) => {
				calls.push(after);
				if (after === -1)
					return page([event(0)], {
						hasMore: true,
						task: { ...page([]).task, revision: 1 },
					});
				return page([event(1, malformed ? "other" : "task")]);
			},
			changed: (s) => {
				state = s;
			},
		});
		await reader.start("task");
		expect(state.failed).toBe(true);
		expect(state.page?.events).toEqual([event(0)]);
		malformed = false;
		await reader.refresh();
		expect(calls).toEqual([-1, 0, 0]);
		expect(state.failed).toBe(false);
		expect(state.page?.events).toHaveLength(2);
		reader.stop();
	});
	it("rejects regressions, false cursors, oversized pages, and non-progressing continuations", () => {
		const previous = mergeTaskEventPage(
			"task",
			null,
			page([event(0), event(1)], {
				task: { ...page([]).task, revision: 1, epoch: 1 },
			}),
		);
		for (const bad of [
			page([event(0)]),
			page([event(0), event(1)]),
			{ ...previous, cursor: 0 },
			{ ...previous, hasMore: true },
			{ ...previous, events: Array(129).fill(event(1)) },
			{ ...previous, task: { ...previous.task, revision: 2 } },
			{ ...previous, task: { ...previous.task, id: "other" } },
		])
			expect(() => mergeTaskEventPage("task", previous, bad)).toThrow();
		expect(previous.events).toHaveLength(2);
	});
	it("fences stale pages and finalizers across task switches, with single-flight reads", async () => {
		const old = deferred(),
			current = deferred();
		const states: TaskEventReaderState[] = [];
		const read = vi.fn((id: string) =>
			id === "task" ? old.promise : current.promise,
		);
		const reader = new TaskEventReader({
			read,
			changed: (s) => states.push(s),
		});
		const a = reader.start("task");
		await reader.refresh();
		const b = reader.start("new");
		old.resolve({ invalid: true });
		await a;
		expect(states.at(-1)?.pending).toBe(true);
		expect(states.at(-1)?.failed).toBe(false);
		current.resolve(
			page([event(0, "new")], {
				task: { ...page([]).task, id: "new", status: "completed" },
			}),
		);
		await b;
		expect(read).toHaveBeenCalledTimes(2);
		expect(states.at(-1)?.page?.task.id).toBe("new");
		reader.stop();
	});
	it("polls unresolved terminal outcomes, stops resolved terminal tasks and stops on read failure", async () => {
		vi.useFakeTimers();
		let unresolved = true,
			fail = false;
		const read = vi.fn(async () => {
			if (fail) throw new Error("offline");
			return page([event(0)], {
				task: {
					...page([]).task,
					status: "cancelled",
					hasUnknownOutcome: unresolved,
				},
			});
		});
		const reader = new TaskEventReader({
			read,
			changed: () => {},
			pollIntervalMs: 100,
		});
		await reader.start("task");
		await vi.advanceTimersByTimeAsync(100);
		expect(read).toHaveBeenCalledTimes(2);
		unresolved = false;
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(1000);
		expect(read).toHaveBeenCalledTimes(3);
		unresolved = true;
		await reader.refresh();
		fail = true;
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(1000);
		expect(read).toHaveBeenCalledTimes(5);
		reader.stop();
	});
	it("stop suppresses late publication and timers, including reentrant observer stop", async () => {
		vi.useFakeTimers();
		const delayed = deferred();
		const changed = vi.fn();
		const reader = new TaskEventReader({
			read: () => delayed.promise,
			changed,
		});
		const pending = reader.start("task");
		reader.stop();
		delayed.resolve(page([event(0)]));
		await pending;
		await vi.advanceTimersByTimeAsync(10000);
		expect(changed).toHaveBeenCalledTimes(1);
		let calls = 0;
		const other = new TaskEventReader({
			read: async () => {
				calls++;
				return page([event(0)]);
			},
			changed: (s) => {
				if (s.page) other.stop();
			},
		});
		await other.start("task");
		await vi.advanceTimersByTimeAsync(10000);
		expect(calls).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
