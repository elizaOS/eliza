/**
 * Live-model SETTINGS scenario (#14364): a natural "turn off shell access"
 * request must select the semantic SETTINGS action and drive the section's own
 * backend route (PUT /api/permissions/shell { enabled:false }) — never the
 * generic agent-fill synthetic-DOM bridge on a builtin field. The loopback
 * captures the real request the handler issues so the check is on behavior, not
 * on the model's phrasing.
 */

import { scenario } from "@elizaos/scenario-runner/schema";
import {
	jsonResponse,
	readAppControlHttpRequests,
	registerAppControlHttpHandler,
	resetAppControlHttpLoopback,
} from "../../../../packages/scenario-runner/test/scenarios/_helpers/app-control-http-loopback";

function shellWrites() {
	return readAppControlHttpRequests(
		(request) =>
			request.method === "PUT" &&
			request.pathname === "/api/permissions/shell",
	).map((request) => request.body ?? null);
}

export default scenario({
	lane: "live-only",
	id: "settings-shell-toggle",
	title: "SETTINGS action disables shell access via the permissions route",
	domain: "app-control",
	tags: ["app-control", "settings", "set", "permissions"],
	isolation: "per-scenario",
	requires: {
		plugins: ["@elizaos/plugin-app-control"],
	},
	seed: [
		{
			type: "custom",
			name: "register permissions shell loopback API",
			apply: () => {
				resetAppControlHttpLoopback();
				registerAppControlHttpHandler((request) => {
					if (
						request.method === "PUT" &&
						request.pathname === "/api/permissions/shell"
					) {
						return jsonResponse({
							shellEnabled: false,
							permission: { id: "shell", status: "denied" },
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
			title: "Settings Shell Toggle",
		},
	],
	turns: [
		{
			kind: "message",
			name: "user-asks-disable-shell",
			text: "disable shell access for the agent",
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
			name: "SETTINGS drove PUT /api/permissions/shell { enabled:false }",
			predicate: () => {
				const expected = [{ enabled: false }];
				const actual = shellWrites();
				return JSON.stringify(actual) === JSON.stringify(expected)
					? undefined
					: `expected exactly one shell write ${JSON.stringify(expected)}, saw ${JSON.stringify(actual)}`;
			},
		},
		{
			type: "custom",
			name: "cleanup permissions loopback",
			predicate: () => {
				resetAppControlHttpLoopback();
				return undefined;
			},
		},
	],
});
