import { scenario } from "@elizaos/scenario-schema";

export default scenario({
	id: "app-relaunch",
	title: "APP action relaunch sub-mode targets the named app",
	domain: "app-control",
	tags: ["app-control", "app", "relaunch"],
	isolation: "per-scenario",
	requires: {
		plugins: ["@elizaos/plugin-app-control"],
	},
	rooms: [
		{
			id: "main",
			source: "telegram",
			title: "App Control Relaunch",
		},
	],
	turns: [
		{
			kind: "message",
			name: "user-asks-relaunch",
			text: "relaunch babylon",
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
			includesAll: [/relaunch/i, /babylon/i],
		},
		{
			type: "actionCalled",
			actionName: "APP",
			minCount: 1,
		},
	],
});
