/**
 * @module plugin-app-control/actions/app-list
 *
 * list sub-mode: combine installed apps + running runs into structured text,
 * plus structured `data` for clients.
 */

import type { ActionResult, HandlerCallback } from "@elizaos/core";
import type { AppControlClient } from "../client/api.js";
import type { AppRunSummary, InstalledAppInfo } from "../types.js";

function formatTable(
	installed: readonly InstalledAppInfo[],
	runs: readonly AppRunSummary[],
): string {
	if (installed.length === 0 && runs.length === 0) {
		return ["available_apps:", "  installedCount: 0", "  runningCount: 0"].join(
			"\n",
		);
	}

	const runsByApp = new Map<string, AppRunSummary[]>();
	for (const run of runs) {
		const existing = runsByApp.get(run.appName) ?? [];
		existing.push(run);
		runsByApp.set(run.appName, existing);
	}

	const lines: string[] = [];
	lines.push("available_apps:");
	lines.push(`  installedCount: ${installed.length}`);
	lines.push(`  runningCount: ${runs.length}`);
	if (installed.length === 0) {
		lines.push("apps[0]:");
	} else {
		lines.push(`apps[${installed.length}]{name,displayName,runningRunIds}:`);
		for (const app of installed) {
			const live = runsByApp.get(app.name) ?? [];
			lines.push(
				`  ${app.name},${app.displayName},${live.map((r) => r.runId).join("|") || "none"}`,
			);
		}
	}

	const orphanRuns = runs.filter(
		(r) => !installed.some((app) => app.name === r.appName),
	);
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

	return lines.join("\n");
}

export interface RunListInput {
	client: AppControlClient;
	callback?: HandlerCallback;
}

export async function runList({
	client,
	callback,
}: RunListInput): Promise<ActionResult> {
	const [installed, runs] = await Promise.all([
		client.listInstalledApps(),
		client.listAppRuns(),
	]);
	const text = formatTable(installed, runs);
	await callback?.({ text });
	return {
		success: true,
		text,
		values: {
			mode: "list",
			installedCount: installed.length,
			runningCount: runs.length,
		},
		data: { installed, runs },
	};
}
