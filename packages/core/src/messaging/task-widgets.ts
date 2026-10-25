/** Browser-safe task widgets. Rendering a widget grants no execution authority. */
import { ElizaError } from "../errors.ts";
import type { ChoiceInteraction } from "../types/interactions.ts";

export interface TaskChoiceWidget {
	schemaVersion: 1;
	taskId: string;
	epoch: number;
	contextKey: string;
	callbackData: string;
	expiresAt: string;
	state: "pending" | "claimed" | "committed" | "completed";
	block: ChoiceInteraction;
}
export function validateTaskChoiceWidget(
	value: unknown,
): asserts value is TaskChoiceWidget {
	const fail = (): never => {
		throw new ElizaError("Invalid task choice widget", {
			code: "TASK_CHOICE_INVALID",
		});
	};
	if (!value || typeof value !== "object" || Array.isArray(value))
		return fail();
	const widget = value as TaskChoiceWidget;
	const fields = [
		"schemaVersion",
		"taskId",
		"epoch",
		"contextKey",
		"callbackData",
		"expiresAt",
		"state",
		"block",
	];
	if (
		Object.keys(value).length !== fields.length ||
		fields.some((key) => !Object.hasOwn(value, key))
	)
		fail();
	if (
		widget.schemaVersion !== 1 ||
		typeof widget.taskId !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(widget.taskId) ||
		!Number.isSafeInteger(widget.epoch) ||
		widget.epoch < 0 ||
		typeof widget.contextKey !== "string" ||
		!/^[a-f0-9]{64}$/.test(widget.contextKey) ||
		typeof widget.callbackData !== "string" ||
		!/^is1:[a-f0-9]{32}$/.test(widget.callbackData) ||
		!["pending", "claimed", "committed", "completed"].includes(widget.state)
	)
		fail();
	if (
		typeof widget.expiresAt !== "string" ||
		!Number.isFinite(Date.parse(widget.expiresAt)) ||
		new Date(widget.expiresAt).toISOString() !== widget.expiresAt
	)
		fail();
	const block = widget.block;
	if (
		block?.kind !== "choice" ||
		typeof block.id !== "string" ||
		!/^[A-Za-z0-9_.:-]{1,64}$/.test(block.id) ||
		typeof block.scope !== "string" ||
		!/^[A-Za-z0-9_.:-]{1,64}$/.test(block.scope) ||
		(block.allowCustom !== undefined && block.allowCustom !== false) ||
		(block.prompt !== undefined &&
			(typeof block.prompt !== "string" || block.prompt.length > 1000)) ||
		!Array.isArray(block.options) ||
		block.options.length < 1 ||
		block.options.length > 25
	)
		fail();
	if (
		Object.keys(block).some(
			(key) =>
				!["kind", "id", "scope", "prompt", "options", "allowCustom"].includes(
					key,
				),
		)
	)
		fail();
	const seen = new Set<string>();
	for (const option of block.options) {
		if (
			!option ||
			typeof option.value !== "string" ||
			!/^[A-Za-z0-9_.:-]{1,128}$/.test(option.value) ||
			seen.has(option.value) ||
			typeof option.label !== "string" ||
			!option.label.trim() ||
			new TextEncoder().encode(option.label).length > 80 ||
			(option.description !== undefined &&
				(typeof option.description !== "string" ||
					option.description.length > 1000)) ||
			Object.keys(option).some(
				(key) => !["value", "label", "description"].includes(key),
			)
		)
			fail();
		seen.add(option.value);
	}
}

/** Admit a reply's widgets for the task/epoch that requested it. This is a
 * presentation boundary, not execution authority. Hosts choose the count limit. */
export function admitTaskChoiceResponse(
	value: unknown,
	task: { taskId: string; epoch: number } | undefined,
	maxWidgets: number,
): TaskChoiceWidget[] {
	const values = value ?? [];
	if (
		!Number.isSafeInteger(maxWidgets) ||
		maxWidgets < 0 ||
		!Array.isArray(values) ||
		values.length > maxWidgets
	)
		throw new ElizaError("Invalid task choice response", {
			code: "TASK_CHOICES_INVALID",
		});
	let detached: unknown[];
	try {
		detached = structuredClone(values);
	} catch {
		throw new ElizaError("Invalid task choice response", {
			code: "TASK_CHOICES_INVALID",
		});
	}
	return Array.from(detached, (widget) => {
		validateTaskChoiceWidget(widget);
		if (!task || widget.taskId !== task.taskId || widget.epoch !== task.epoch)
			throw new ElizaError("Task choice response does not match its request", {
				code: "TASK_CHOICES_MISMATCH",
			});
		return widget;
	});
}
