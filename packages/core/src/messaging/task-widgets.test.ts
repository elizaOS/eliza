import { expect, it } from "vitest";
import {
	admitTaskChoiceResponse,
	validateTaskChoiceWidget,
} from "./task-widgets.ts";

const widget = {
	schemaVersion: 1,
	taskId: "task",
	epoch: 0,
	contextKey: "a".repeat(64),
	callbackData: `is1:${"b".repeat(32)}`,
	expiresAt: new Date(10000).toISOString(),
	state: "pending",
	block: {
		kind: "choice",
		id: "method",
		scope: "review",
		options: [{ value: "existing", label: "Use existing method" }],
	},
};
it("accepts the typed choice and rejects executable, duplicate, custom or unbound inputs", () => {
	expect(() => validateTaskChoiceWidget(widget)).not.toThrow();
	for (const value of [
		null,
		{},
		{ ...widget, callbackData: "javascript:alert(1)" },
		{ ...widget, epoch: -1 },
		{ ...widget, contextKey: "" },
		{ ...widget, execute: "click" },
		{ ...widget, block: { ...widget.block, allowCustom: true } },
		{
			...widget,
			block: {
				...widget.block,
				options: [...widget.block.options, ...widget.block.options],
			},
		},
	])
		expect(() => validateTaskChoiceWidget(value)).toThrow();
});

it("admits absent or empty widgets without requiring a task and enforces host count policy", () => {
	for (const value of [undefined, null, []])
		expect(admitTaskChoiceResponse(value, undefined, 1)).toEqual([]);
	for (const value of [{}, "bad", [widget, widget]])
		expect(() =>
			admitTaskChoiceResponse(value, { taskId: "task", epoch: 0 }, 1),
		).toThrow(expect.objectContaining({ code: "TASK_CHOICES_INVALID" }));
	for (const limit of [-1, NaN, 1.5, Infinity])
		expect(() => admitTaskChoiceResponse([], undefined, limit)).toThrow(
			expect.objectContaining({ code: "TASK_CHOICES_INVALID" }),
		);
	expect(() =>
		admitTaskChoiceResponse([widget], { taskId: "task", epoch: 0 }, 0),
	).toThrow();
});
it("rejects foreign, stale or unbound task choices without admitting a partial list", () => {
	for (const task of [
		undefined,
		{ taskId: "other", epoch: 0 },
		{ taskId: "task", epoch: 1 },
	])
		expect(() => admitTaskChoiceResponse([widget], task, 1)).toThrow(
			expect.objectContaining({ code: "TASK_CHOICES_MISMATCH" }),
		);
	expect(() =>
		admitTaskChoiceResponse(
			[widget, { ...widget, taskId: "other" }],
			{ taskId: "task", epoch: 0 },
			2,
		),
	).toThrow(expect.objectContaining({ code: "TASK_CHOICES_MISMATCH" }));
});
it("retains canonical widget validation and returns detached nested data", () => {
	expect(() =>
		admitTaskChoiceResponse(
			[{ ...widget, callbackData: "javascript:bad" }],
			{ taskId: "task", epoch: 0 },
			1,
		),
	).toThrow(expect.objectContaining({ code: "TASK_CHOICE_INVALID" }));
	const source = structuredClone(widget);
	const admitted = admitTaskChoiceResponse(
		[source],
		{ taskId: "task", epoch: 0 },
		1,
	);
	source.block.options[0].label = "changed";
	expect(admitted[0].block.options[0].label).toBe("Use existing method");
	admitted[0].block.options[0].label = "changed again";
	expect(source.block.options[0].label).toBe("changed");
});
it("rejects uncloneable reply data before exposing widgets", () => {
	expect(() =>
		admitTaskChoiceResponse(
			[{ ...widget, extra: () => {} }],
			{ taskId: "task", epoch: 0 },
			1,
		),
	).toThrow(expect.objectContaining({ code: "TASK_CHOICES_INVALID" }));
});

it("rejects sparse widget arrays rather than skipping empty entries", () => {
	expect(() =>
		admitTaskChoiceResponse(new Array(1), { taskId: "task", epoch: 0 }, 1),
	).toThrow(expect.objectContaining({ code: "TASK_CHOICE_INVALID" }));
});
