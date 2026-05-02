import { scenario } from "@elizaos/scenario-schema";

export default scenario({
	id: "app-load-from-directory",
	title: "APP action load_from_directory sub-mode scans the named folder",
	domain: "app-control",
	tags: ["app-control", "app", "load"],
	isolation: "per-scenario",
	requires: {
		plugins: ["@elizaos/plugin-app-control"],
	},
	rooms: [
		{
			id: "main",
			source: "telegram",
			title: "App Control Load From Directory",
		},
	],
	turns: [
		{
			kind: "message",
			name: "user-asks-load",
			text: "load apps from /tmp/test-apps directory",
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
			includesAll: [/load_from_directory/i, /\/tmp\/test-apps/],
		},
		{
			type: "actionCalled",
			actionName: "APP",
			minCount: 1,
		},
	],
});
