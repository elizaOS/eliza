/**
 * Live-only scenario for dashboard-visible VIEWS show navigation.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
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
			// View navigation is a first-party-surface contract: on viewless text
			// connectors (telegram/discord/…) the #8613 gate deliberately removes
			// the desktop-only VIEWS modes (show/open) from the planner surface —
			// navigating a desktop view the asker cannot see is a silent
			// non-answer there. "dashboard" is the in-app chat where views render
			// for the asker, so it is the surface this contract exists on.
			source: "dashboard",
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
