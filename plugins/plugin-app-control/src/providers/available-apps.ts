/**
 * @module plugin-app-control/providers/available-apps
 *
 * Surfaces installed apps + their running run counts to the planner so
 * APP actions can pick a target without an extra round-trip. Returns an
 * empty string when nothing is installed and nothing is running.
 */

import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "@elizaos/core";
import { createAppControlClient } from "../client/api.js";

const MAX_LISTED = 30;
const MAX_RUNS_RETURNED = 30;
const MAX_ORPHAN_RUNS = 10;

// Stale-while-revalidate snapshot so the planner compose never blocks on the
// two loopback /api/apps calls: a warm turn returns the last snapshot
// immediately and refreshes out-of-band. Install/run state moves on human
// timescales, so a 45s-stale inventory is fine for action targeting.
const SNAPSHOT_TTL_MS = 45_000;
let snapshot: { at: number; result: ProviderResult } | null = null;
let refreshInFlight = false;

async function fetchAvailableApps(): Promise<ProviderResult> {
	try {
		const client = createAppControlClient();
		const [installed, runs] = await Promise.all([
			client.listInstalledApps(),
			client.listAppRuns(),
		]);

		if (installed.length === 0 && runs.length === 0) {
			return { text: "" };
		}

		const runsByApp = new Map<string, number>();
		for (const run of runs) {
			runsByApp.set(run.appName, (runsByApp.get(run.appName) ?? 0) + 1);
		}

		const listedInstalled = installed.slice(0, MAX_LISTED);
		const overflow = installed.length - listedInstalled.length;

		const lines: string[] = [];
		lines.push("available_apps:");
		lines.push(`  installedCount: ${installed.length}`);
		lines.push(`  runningCount: ${runs.length}`);
		lines.push("  actions: APP mode=launch | relaunch | create");
		if (listedInstalled.length > 0) {
			lines.push(
				`apps[${listedInstalled.length}]{name,displayName,pluginName,running}:`,
			);
			for (const app of listedInstalled) {
				const running = runsByApp.get(app.name) ?? 0;
				lines.push(
					`  ${app.name},${app.displayName},${app.pluginName},${running}`,
				);
			}
			if (overflow > 0) {
				lines.push(`truncated: ${overflow}`);
			}
		} else {
			lines.push("apps[0]:");
		}

		const orphanRuns = runs
			.filter((r) => !installed.some((app) => app.name === r.appName))
			.slice(0, MAX_ORPHAN_RUNS);
		if (orphanRuns.length > 0) {
			lines.push(
				`otherRuns[${orphanRuns.length}]{runId,appName,displayName,status}:`,
			);
			for (const run of orphanRuns) {
				lines.push(
					`  ${run.runId},${run.appName},${run.displayName},${run.status}`,
				);
			}
		}

		return {
			text: lines.join("\n"),
			values: {
				installedAppCount: installed.length,
				runningAppCount: runs.length,
			},
			data: {
				installed: listedInstalled,
				runs: runs.slice(0, MAX_RUNS_RETURNED),
				truncated: overflow > 0,
			},
		};
	} catch {
		// error-policy:J4 apps surface degrades to absent context for the
		// planner; a failed loopback call must not fail the message turn.
		return { text: "", values: {}, data: {} };
	}
}

export const availableAppsProvider: Provider = {
	name: "available_apps",
	description:
		"Installed Eliza apps with running-run counts; use this to pick targets for APP launch / relaunch / create. Read-only list/status is exposed here.",
	descriptionCompressed: "Installed apps + running counts for APP action.",
	position: -8,
	contexts: ["settings", "automation"],
	contextGate: { anyOf: ["settings", "automation"] },
	cacheStable: false,
	cacheScope: "turn",
	// Installed-app inventory + running counts are local install state — owner
	// context (#12094 item 3).
	roleGate: { minRole: "OWNER" },
	dynamic: true,

	get: async (
		_runtime: IAgentRuntime,
		_message: Memory,
		_state: State,
	): Promise<ProviderResult> => {
		if (snapshot) {
			if (Date.now() - snapshot.at > SNAPSHOT_TTL_MS && !refreshInFlight) {
				refreshInFlight = true;
				void fetchAvailableApps()
					.then((result) => {
						snapshot = { at: Date.now(), result };
					})
					.finally(() => {
						refreshInFlight = false;
					});
			}
			return snapshot.result;
		}
		const result = await fetchAvailableApps();
		snapshot = { at: Date.now(), result };
		return result;
	},
};

export default availableAppsProvider;
