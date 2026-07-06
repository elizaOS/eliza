/**
 * Live-model SETTINGS scenario (#14624): a natural "turn on auto-training"
 * request must select the semantic SETTINGS action and drive the Capabilities
 * section's own backend route (POST /api/training/auto/config
 * { autoTrain:true }) — the same endpoint the visible toggle uses.
 */

import { scenario } from "@elizaos/scenario-runner/schema";
import {
	jsonResponse,
	readAppControlHttpRequests,
	registerAppControlHttpHandler,
	resetAppControlHttpLoopback,
} from "../../../../packages/scenario-runner/test/scenarios/_helpers/app-control-http-loopback";

function autoTrainingWrites() {
	return readAppControlHttpRequests(
		(request) =>
			request.method === "POST" &&
			request.pathname === "/api/training/auto/config",
	).map((request) => request.body ?? null);
}

export default scenario({
	lane: "live-only",
	id: "settings-auto-training-toggle",
	title: "SETTINGS action enables auto-training via the capabilities route",
	domain: "app-control",
	tags: ["app-control", "settings", "set", "capabilities", "training"],
	isolation: "per-scenario",
	requires: {
		plugins: ["@elizaos/plugin-app-control"],
	},
	seed: [
		{
			type: "custom",
			name: "register auto-training loopback API",
			apply: () => {
				resetAppControlHttpLoopback();
				registerAppControlHttpHandler((request) => {
					if (
						request.method === "POST" &&
						request.pathname === "/api/training/auto/config"
					) {
						return jsonResponse({
							config: {
								autoTrain: true,
								threshold: 50,
								cooldownHours: 24,
							},
						});
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
			title: "Settings Auto-training Toggle",
		},
	],
	turns: [
		{
			kind: "message",
			name: "user-asks-enable-auto-training",
			text: "turn on auto-training",
		},
	],
	finalChecks: [
		{
			type: "selectedAction",
			actionName: "SETTINGS",
		},
		{
			type: "actionCalled",
			actionName: "SETTINGS",
			status: "success",
			minCount: 1,
		},
		{
			type: "custom",
			name: "SETTINGS drove POST /api/training/auto/config { autoTrain:true }",
			predicate: () => {
				const expected = [{ autoTrain: true }];
				const actual = autoTrainingWrites();
				return JSON.stringify(actual) === JSON.stringify(expected)
					? undefined
					: `expected exactly one auto-training write ${JSON.stringify(expected)}, saw ${JSON.stringify(actual)}`;
			},
		},
		{
			type: "custom",
			name: "cleanup auto-training loopback",
			predicate: () => {
				resetAppControlHttpLoopback();
				return undefined;
			},
		},
	],
});
