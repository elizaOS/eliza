import { expect, it } from "vitest";
import { validateTaskChoiceWidget } from "./task-widgets.ts";

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
