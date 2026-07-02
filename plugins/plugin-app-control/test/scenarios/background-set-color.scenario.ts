import { scenario } from "@elizaos/scenario-runner/schema";
import {
	jsonResponse,
	readAppControlHttpRequests,
	registerAppControlHttpHandler,
	resetAppControlHttpLoopback,
} from "../../../../packages/scenario-runner/test/scenarios/_helpers/app-control-http-loopback";

/**
 * Live-model BACKGROUND coverage (#10694): the model must choose the
 * BACKGROUND action from natural phrasing, and the handler must broadcast the
 * exact `background:apply` payload the renderer consumes ("teal" resolves to
 * the curated #0891b2 hex). The loopback handler stands in for the dashboard
 * broadcast route only — routing and payload both come from the real pipeline.
 */

function normalizedBackgroundBroadcasts() {
	return readAppControlHttpRequests(
		(request) =>
			request.method === "POST" &&
			request.pathname === "/api/views/events/broadcast",
	).map((request) => request.body ?? null);
}

export default scenario({
	lane: "live-only",
	id: "background-set-color",
	title: "BACKGROUND action sets a named color from natural phrasing",
	domain: "app-control",
	tags: ["app-control", "background", "set", "color"],
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
			title: "Background Set Color",
		},
	],
	turns: [
		{
			kind: "message",
			name: "user-asks-teal-background",
			text: "make the background teal",
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
			minCount: 1,
		},
		{
			// The model's own arguments must reference the requested color — as
			// the name ("teal") or an explicit hex. The exact curated #0891b2
			// resolution is pinned below by the broadcast-ledger check (that is
			// the handler's contract); requiring the internal hex in the MODEL's
			// tool-call arguments made this check pass only when the model
			// happened to emit the resolved hex itself (#11360).
			type: "selectedActionArguments",
			actionName: "BACKGROUND",
			includesAll: [/teal|#0891b2/i],
		},
		{
			type: "custom",
			name: "background:apply broadcast carries the resolved teal hex",
			predicate: () => {
				const expected = [
					{
						type: "background:apply",
						payload: { op: "set", mode: "shader", color: "#0891b2" },
					},
				];
				const actual = normalizedBackgroundBroadcasts();
				return JSON.stringify(actual) === JSON.stringify(expected)
					? undefined
					: `expected exactly one background:apply broadcast ${JSON.stringify(expected)}, saw ${JSON.stringify(actual)}`;
			},
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
