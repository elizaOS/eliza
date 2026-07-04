/**
 * Live-only scenario for the app-create picker cancellation path.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
	id: "app-create-cancel",
	title: "APP create — user cancels at the picker",
	domain: "app-control",
	tags: ["app-control", "app", "create", "cancel"],
	isolation: "per-scenario",
	requires: {
		plugins: ["@elizaos/plugin-app-control"],
	},
	rooms: [
		{
			id: "main",
			source: "telegram",
			title: "App Create Cancel",
		},
	],
	turns: [
		{
			kind: "message",
			name: "user-asks-create",
			text: "build a calculator app",
		},
		{
			kind: "message",
			name: "user-cancels",
			text: "cancel",
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
			type: "judgeRubric",
			name: "cancel-confirmation",
			rubric:
				"After turn 2, the assistant must acknowledge the cancellation with text such as 'canceled', 'no changes', or 'no app changes made'. It must NOT claim it scaffolded, created, or dispatched a coding agent.",
			minimumScore: 0.7,
		},
	],
});
