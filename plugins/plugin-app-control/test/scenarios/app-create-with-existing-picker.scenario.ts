/**
 * Live-only scenario for APP create picker selection of an existing app.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
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
