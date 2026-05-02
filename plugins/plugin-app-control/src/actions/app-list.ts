/**
 * @module plugin-app-control/actions/app-list
 *
 * list sub-mode: combine installed apps + running runs into a single
 * markdown-table report for the LLM, plus structured `data` for clients.
 */

import type { ActionResult, HandlerCallback } from "@elizaos/core";
import type { AppControlClient } from "../client/api.js";
import type { AppRunSummary, InstalledAppInfo } from "../types.js";

function formatTable(
	installed: readonly InstalledAppInfo[],
	runs: readonly AppRunSummary[],
): string {
	if (installed.length === 0 && runs.length === 0) {
		return "No apps are installed and nothing is running.";
	}

	const runsByApp = new Map<string, AppRunSummary[]>();
	for (const run of runs) {
		const existing = runsByApp.get(run.appName) ?? [];
		existing.push(run);
		runsByApp.set(run.appName, existing);
	}

	const lines: string[] = [];
	lines.push(`Installed apps (${installed.length}):`);
	if (installed.length === 0) {
		lines.push("  (none)");
	} else {
		for (const app of installed) {
			const live = runsByApp.get(app.name) ?? [];
			const running =
				live.length === 0
					? ""
					: ` — running x${live.length} [${live.map((r) => r.runId).join(", ")}]`;
			lines.push(`  - ${app.displayName} (${app.name})${running}`);
		}
	}

	const orphanRuns = runs.filter(
		(r) => !installed.some((app) => app.name === r.appName),
	);
	if (orphanRuns.length > 0) {
		lines.push("");
		lines.push(`Other running runs (${orphanRuns.length}):`);
		for (const run of orphanRuns) {
			lines.push(
				`  - ${run.displayName} (${run.appName}) [runId: ${run.runId}, status: ${run.status}]`,
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
