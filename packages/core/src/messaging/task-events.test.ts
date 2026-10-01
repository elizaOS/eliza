import { describe, expect, it } from "vitest";
import {
	mergeTaskEvents,
	type TaskEvent,
	validateTaskEvent,
} from "./task-events.ts";

const created: TaskEvent = {
	schemaVersion: 1,
	eventId: "task#0",
	taskId: "task",
	sequence: 0,
	epoch: 0,
	kind: "create",
	at: 1000,
	status: "active",
};
const paused: TaskEvent = {
	...created,
	eventId: "task#1",
	sequence: 1,
	epoch: 1,
	kind: "pause",
	status: "paused",
	at: 1001,
};
describe("task event projection", () => {
	it("merges repeated pages without duplicates or mutating old state", () => {
		const original = mergeTaskEvents("task", [], [created]);
		const next = mergeTaskEvents("task", original, [created, paused]);
		expect(original).toEqual([created]);
		expect(next).toEqual([created, paused]);
		expect(() =>
			mergeTaskEvents("task", next, [{ ...paused, kind: "cancel" }]),
		).toThrow(/Conflicting/);
		expect(() => mergeTaskEvents("other", [], [created])).toThrow(
			/different task/,
		);
		expect(() =>
			mergeTaskEvents("task", original, [
				{ ...paused, eventId: "task#3", sequence: 3 },
			]),
		).toThrow(/gap/);
		expect(() =>
			validateTaskEvent({ ...created, rawPageText: "secret" }),
		).toThrow(/Unexpected/);
	});
	it("allows an explicit historical checkpoint but rejects an undisclosed gap or old epoch", () => {
		const checkpoint: TaskEvent = {
			...paused,
			eventId: "task#20",
			sequence: 20,
			kind: "checkpoint",
		};
		expect(mergeTaskEvents("task", [], [checkpoint])).toEqual([checkpoint]);
		expect(() => mergeTaskEvents("task", [], [paused])).toThrow(/gap/);
		expect(() =>
			mergeTaskEvents(
				"task",
				[checkpoint],
				[{ ...created, eventId: "task#21", sequence: 21, kind: "observe" }],
			),
		).toThrow(/backwards/);
	});
});
