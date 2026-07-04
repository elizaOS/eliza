/**
 * Live-only scenario for single-word voice navigation through VIEWS show mode.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
	id: "views-voice-navigate",
	title: "VIEWS action resolves single-word voice input to show mode",
	domain: "app-control",
	tags: ["app-control", "views", "show", "voice", "intent-routing"],
	isolation: "per-scenario",
	requires: {
		plugins: ["@elizaos/plugin-app-control"],
	},
	rooms: [
		{
			id: "main",
			// Voice transcription happens on the device running the app, so the
			// utterance lands in the in-app chat ("dashboard"), never on a remote
			// text connector. On telegram/discord the #8613 gate deliberately
			// removes VIEWS show/open from the planner surface (views are
			// invisible to the asker there), so a telegram room cannot express
			// this contract at all.
			source: "dashboard",
			title: "Views Voice Navigate",
		},
	],
	turns: [
		{
			kind: "message",
			name: "user-says-settings",
			// Single-word utterance as produced by a voice transcription pass.
			// The planner must interpret this as VIEWS show mode → settings view.
			text: "settings",
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
