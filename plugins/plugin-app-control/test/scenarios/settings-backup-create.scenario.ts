/**
 * Live-model SETTINGS scenario (#14620): a natural backup request must select
 * the semantic SETTINGS action and drive the same local-backup route the
 * Advanced settings button uses.
 */

import { scenario } from "@elizaos/scenario-runner/schema";
import {
	jsonResponse,
	readAppControlHttpRequests,
	registerAppControlHttpHandler,
	resetAppControlHttpLoopback,
} from "../../../../packages/scenario-runner/test/scenarios/_helpers/app-control-http-loopback";

function backupWrites() {
	return readAppControlHttpRequests(
		(request) =>
			request.method === "POST" && request.pathname === "/api/backups",
	).map((request) => request.body ?? null);
}

export default scenario({
	lane: "live-only",
	id: "settings-backup-create",
	title: "SETTINGS action creates a local agent backup",
	domain: "app-control",
	tags: ["app-control", "settings", "advanced", "backup"],
	isolation: "per-scenario",
	requires: {
		plugins: ["@elizaos/plugin-app-control"],
	},
	seed: [
		{
			type: "custom",
			name: "register local backup loopback API",
			apply: () => {
				resetAppControlHttpLoopback();
				registerAppControlHttpHandler((request) => {
					if (request.method === "POST" && request.pathname === "/api/backups") {
						return jsonResponse({
							backup: {
								fileName: "agent-2026.agent-backup.json",
								createdAt: "2026-01-01T00:00:00.000Z",
								sizeBytes: 1024,
								stateSha256:
									"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
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
			title: "Settings Backup Create",
		},
	],
	turns: [
		{
			kind: "message",
			name: "user-asks-backup-agent",
			text: "back up my agent",
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
			name: "SETTINGS drove POST /api/backups",
			predicate: () => {
				const expected = [{}];
				const actual = backupWrites();
				return JSON.stringify(actual) === JSON.stringify(expected)
					? undefined
					: `expected exactly one backup write ${JSON.stringify(expected)}, saw ${JSON.stringify(actual)}`;
			},
		},
		{
			type: "custom",
			name: "cleanup backup loopback",
			predicate: () => {
				resetAppControlHttpLoopback();
				return undefined;
			},
		},
	],
});
