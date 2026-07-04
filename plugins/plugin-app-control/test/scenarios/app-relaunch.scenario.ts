/**
 * Live-only scenario for APP relaunch sub-mode targeting.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
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
			text: "relaunch feed",
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
			includesAll: [/relaunch/i, /feed/i],
		},
		{
			type: "actionCalled",
			actionName: "APP",
			minCount: 1,
		},
	],
});
