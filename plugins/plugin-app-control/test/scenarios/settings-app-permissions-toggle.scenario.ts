/**
 * Live-model SETTINGS scenario (#14622): a natural app-permission revoke
 * request must select the semantic SETTINGS action and drive the same
 * read-modify-write route sequence the Settings toggle uses.
 */

import { scenario } from "@elizaos/scenario-runner/schema";
import {
	jsonResponse,
	readAppControlHttpRequests,
	registerAppControlHttpHandler,
	resetAppControlHttpLoopback,
} from "../../../../packages/scenario-runner/test/scenarios/_helpers/app-control-http-loopback";

const APP_SLUG = "weather";

function appPermissionWrites() {
	return readAppControlHttpRequests(
		(request) =>
			request.method === "PUT" &&
			request.pathname === `/api/apps/permissions/${APP_SLUG}`,
	).map((request) => request.body ?? null);
}

export default scenario({
	lane: "live-only",
	id: "settings-app-permissions-toggle",
	title: "SETTINGS action revokes an app permission namespace",
	domain: "app-control",
	tags: ["app-control", "settings", "set", "app-permissions"],
	isolation: "per-scenario",
	requires: {
		plugins: ["@elizaos/plugin-app-control"],
	},
	seed: [
		{
			type: "custom",
			name: "register app-permissions loopback API",
			apply: () => {
				resetAppControlHttpLoopback();
				registerAppControlHttpHandler((request) => {
					if (
						request.method === "GET" &&
						request.pathname === `/api/apps/permissions/${APP_SLUG}`
					) {
						return jsonResponse({
							slug: APP_SLUG,
							trust: "external",
							isolation: "worker",
							requestedPermissions: {
								fs: { read: ["state/weather/**"] },
								net: { outbound: ["https://api.weather.test"] },
							},
							recognisedNamespaces: ["fs", "net"],
							grantedNamespaces: ["fs", "net"],
							grantedAt: "2026-01-01T00:00:00.000Z",
						});
					}
					if (
						request.method === "PUT" &&
						request.pathname === `/api/apps/permissions/${APP_SLUG}`
					) {
						return jsonResponse({
							slug: APP_SLUG,
							trust: "external",
							isolation: "worker",
							requestedPermissions: {
								fs: { read: ["state/weather/**"] },
								net: { outbound: ["https://api.weather.test"] },
							},
							recognisedNamespaces: ["fs", "net"],
							grantedNamespaces: ["fs"],
							grantedAt: "2026-01-01T00:00:00.000Z",
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
			title: "Settings App Permissions Toggle",
		},
	],
	turns: [
		{
			kind: "message",
			name: "user-asks-revoke-network",
			text: `revoke network access for the ${APP_SLUG} app`,
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
			name: "SETTINGS drove PUT /api/apps/permissions/weather { namespaces:[fs] }",
			predicate: () => {
				const expected = [{ namespaces: ["fs"] }];
				const actual = appPermissionWrites();
				return JSON.stringify(actual) === JSON.stringify(expected)
					? undefined
					: `expected exactly one app permission write ${JSON.stringify(expected)}, saw ${JSON.stringify(actual)}`;
			},
		},
		{
			type: "custom",
			name: "cleanup app-permissions loopback",
			predicate: () => {
				resetAppControlHttpLoopback();
				return undefined;
			},
		},
	],
});
