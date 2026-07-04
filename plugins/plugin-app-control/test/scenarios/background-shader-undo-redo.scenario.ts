/**
 * Live-model BACKGROUND scenario for shader set, undo, redo, and reset routing.
 */

import { scenario } from "@elizaos/scenario-runner/schema";
import {
	jsonResponse,
	readAppControlHttpRequests,
	registerAppControlHttpHandler,
	resetAppControlHttpLoopback,
} from "../../../../packages/scenario-runner/test/scenarios/_helpers/app-control-http-loopback";

function normalizedBackgroundBroadcasts() {
	return readAppControlHttpRequests(
		(request) =>
			request.method === "POST" &&
			request.pathname === "/api/views/events/broadcast",
	).map((request) => request.body ?? null);
}

export default scenario({
	lane: "live-only",
	id: "background-shader-undo-redo",
	title: "BACKGROUND shader set, undo, redo, reset round trip",
	domain: "app-control",
	tags: ["app-control", "background", "shader", "undo", "redo", "reset"],
	isolation: "per-scenario",
	requires: {
		plugins: ["@elizaos/plugin-app-control"],
	},
	seed: [
		{
			type: "custom",
			name: "register background broadcast loopback API",
			apply: () => {
				resetAppControlHttpLoopback();
				registerAppControlHttpHandler((request) => {
					if (
						request.method === "POST" &&
						request.pathname === "/api/views/events/broadcast"
					) {
						return jsonResponse({ ok: true, delivered: 1 });
					}
					return undefined;
				});
				return undefined;
			},
		},
	],
	rooms: [
		{
			id: "main",
			source: "chat",
			title: "Background Shader Undo Redo",
		},
	],
	turns: [
		{
			kind: "message",
			name: "user-asks-lava-lamp-shader",
			text: "give me a slow lava-lamp style animated background",
		},
		{
			kind: "message",
			name: "user-undoes-background",
			text: "undo that background change",
		},
		{
			kind: "message",
			name: "user-redoes-background",
			text: "redo the background change",
		},
		{
			kind: "message",
			name: "user-resets-background",
			text: "reset the background to the default look",
		},
	],
	finalChecks: [
		{
			type: "selectedAction",
			actionName: "BACKGROUND",
		},
		{
			type: "actionCalled",
			actionName: "BACKGROUND",
			status: "success",
			minCount: 4,
		},
		{
			type: "custom",
			name: "background:apply ledger is the exact glsl/undo/redo/reset sequence",
			predicate: () => {
				const expected = [
					{
						type: "background:apply",
						payload: { op: "set", mode: "glsl", presetId: "lava" },
					},
					{ type: "background:apply", payload: { op: "undo" } },
					{ type: "background:apply", payload: { op: "redo" } },
					{ type: "background:apply", payload: { op: "reset" } },
				];
				const actual = normalizedBackgroundBroadcasts();
				return JSON.stringify(actual) === JSON.stringify(expected)
					? undefined
					: `expected exact background:apply op sequence ${JSON.stringify(expected)}, saw ${JSON.stringify(actual)}`;
			},
		},
		{
			type: "judgeRubric",
			name: "background-shader-round-trip",
			rubric:
				"The trajectory must show the assistant driving the app background through the BACKGROUND action four times in order: applying an animated lava shader for the lava-lamp request, reverting it on the undo request, re-applying it on the redo request, and restoring the default on the reset request — each acknowledged without claiming failure and without routing to an unrelated action.",
			minimumScore: 0.7,
		},
		{
			type: "custom",
			name: "cleanup background broadcast loopback",
			predicate: () => {
				resetAppControlHttpLoopback();
				return undefined;
			},
		},
	],
});
