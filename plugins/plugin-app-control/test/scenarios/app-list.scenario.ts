import { scenario } from "@elizaos/scenario-schema";

export default scenario({
	id: "app-list",
	title: "APP action list sub-mode reports installed and running apps",
	domain: "app-control",
	tags: ["app-control", "app", "list"],
	isolation: "per-scenario",
	requires: {
		plugins: ["@elizaos/plugin-app-control"],
	},
	rooms: [
		{
			id: "main",
			source: "telegram",
			title: "App Control List",
		},
	],
	turns: [
		{
			kind: "message",
			name: "user-asks-list",
			text: "show me the apps",
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
			includesAll: [/list/i],
		},
		{
			type: "actionCalled",
			actionName: "APP",
			minCount: 1,
		},
	],
});
