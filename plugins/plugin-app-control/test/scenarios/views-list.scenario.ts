import { scenario } from "@elizaos/scenario-schema";

export default scenario({
	id: "views-list",
	title: "VIEWS action list mode reports available views by name",
	domain: "app-control",
	tags: ["app-control", "views", "list"],
	isolation: "per-scenario",
	requires: {
		plugins: ["@elizaos/plugin-app-control"],
	},
	rooms: [
		{
			id: "main",
			source: "telegram",
			title: "Views List",
		},
	],
	turns: [
		{
			kind: "message",
			name: "user-asks-list",
			text: "what views are available?",
		},
	],
	finalChecks: [
		{
			type: "selectedAction",
			actionName: "VIEWS",
		},
		{
			type: "selectedActionArguments",
			actionName: "VIEWS",
			includesAll: [/list/i],
		},
		{
			type: "actionCalled",
			actionName: "VIEWS",
			minCount: 1,
		},
	],
});
