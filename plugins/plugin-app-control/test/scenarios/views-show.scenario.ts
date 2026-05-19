import { scenario } from "@elizaos/scenario-schema";

export default scenario({
	id: "views-show",
	title: "VIEWS action show mode navigates to a named view",
	domain: "app-control",
	tags: ["app-control", "views", "show", "navigate"],
	isolation: "per-scenario",
	requires: {
		plugins: ["@elizaos/plugin-app-control"],
	},
	rooms: [
		{
			id: "main",
			source: "telegram",
			title: "Views Show",
		},
	],
	turns: [
		{
			kind: "message",
			name: "user-opens-wallet",
			text: "open the wallet view",
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
			includesAll: [/show|open/i],
		},
		{
			type: "actionCalled",
			actionName: "VIEWS",
			minCount: 1,
		},
	],
});
