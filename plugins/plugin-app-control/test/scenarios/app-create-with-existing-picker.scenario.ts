import { scenario } from "@elizaos/scenario-schema";

/**
 * Multi-turn create flow:
 *   Turn 1 — user asks to "create a 3D scene viewer app". The APP action
 *            should fire in `mode=create` and respond with a [CHOICE:app-create
 *            ...] block listing existing scene/viewer apps for editing.
 *   Turn 2 — user replies "edit-1". The action validates again because the
 *            choice reply matches a pending intent task; mode is still
 *            `create` and the choice is resolved to an edit dispatch.
 */
export default scenario({
	id: "app-create-with-existing-picker",
	title: "APP create — picker shown then edit-1 selected",
	domain: "app-control",
	tags: ["app-control", "app", "create", "multi-turn"],
	isolation: "per-scenario",
	requires: {
		plugins: ["@elizaos/plugin-app-control"],
	},
	rooms: [
		{
			id: "main",
			source: "telegram",
			title: "App Create Picker",
		},
	],
	turns: [
		{
			kind: "message",
			name: "user-asks-create",
			text: "create a 3D scene viewer app",
		},
		{
			kind: "message",
			name: "user-picks-edit-1",
			text: "edit-1",
		},
	],
	finalChecks: [
		{
			type: "selectedAction",
			actionName: "APP",
		},
		{
			type: "selectedActionArguments",
			actionName: "APP",
			includesAny: [/create/i],
		},
		{
			type: "actionCalled",
			actionName: "APP",
			minCount: 2,
		},
		{
			// First turn surfaces the [CHOICE:app-create ...] picker block via the
			// assistant message channel — assert the picker text was delivered.
			type: "messageDelivered",
			channel: "telegram",
		},
	],
});
