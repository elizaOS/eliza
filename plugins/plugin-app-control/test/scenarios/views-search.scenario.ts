import { scenario } from "@elizaos/scenario-schema";

export default scenario({
	id: "views-search",
	title: "VIEWS action search mode returns matching views with descriptions",
	domain: "app-control",
	tags: ["app-control", "views", "search"],
	isolation: "per-scenario",
	requires: {
		plugins: ["@elizaos/plugin-app-control"],
	},
	rooms: [
		{
			id: "main",
			source: "telegram",
			title: "Views Search",
		},
	],
	turns: [
		{
			kind: "message",
			name: "user-searches-views",
			text: "find a view for managing my crypto",
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
			includesAll: [/search/i],
		},
		{
			type: "actionCalled",
			actionName: "VIEWS",
			minCount: 1,
		},
	],
});
