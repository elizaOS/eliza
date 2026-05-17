import { scenario } from "@elizaos/scenario-schema";

export default scenario({
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
			source: "telegram",
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
