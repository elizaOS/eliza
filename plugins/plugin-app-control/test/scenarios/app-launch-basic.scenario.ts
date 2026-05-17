import { scenario } from "@elizaos/scenario-schema";

export default scenario({
	id: "app-launch-basic",
	title: "APP action launch sub-mode dispatches with mode=launch",
	domain: "app-control",
	tags: ["app-control", "app", "launch", "smoke"],
	isolation: "per-scenario",
	requires: {
		plugins: ["@elizaos/plugin-app-control"],
	},
	rooms: [
		{
			id: "main",
			source: "telegram",
			title: "App Control Launch",
		},
	],
	turns: [
		{
			kind: "message",
			name: "user-asks-launch",
			text: "launch the babylon app",
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
			includesAll: [/launch/i],
		},
		{
			type: "actionCalled",
			actionName: "APP",
			minCount: 1,
		},
	],
});
