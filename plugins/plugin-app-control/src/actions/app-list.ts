/**
 * @module plugin-app-control/actions/app-list
 *
 * list sub-mode: combine installed apps + running runs into structured text,
 * plus structured `data` for clients.
 */

import { type ActionResult, isElizaError } from "@elizaos/core";
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
}

// Loopback transport failures are an expected class on this read path (the
// installed-apps route can run a slow cold registry scan). They must become
// typed failures because planner-loop failure authority surfaces only a failed
// step's `userFacingText`; a bare throw reaches the user as the generic
// failed-tool fallback instead of this tool's own prose.
function transportFailureCode(
	err: unknown,
): "LOOPBACK_TIMEOUT" | "LOOPBACK_UNREACHABLE" | null {
	if (!isElizaError(err)) return null;
	if (err.code === "LOOPBACK_TIMEOUT") return "LOOPBACK_TIMEOUT";
	if (err.code === "LOOPBACK_UNREACHABLE") return "LOOPBACK_UNREACHABLE";
	return null;
}

// Read-only query: deliberately no visible callback (the silent read-only
// contract of #16589). The structured table reaches the model via the
// ActionResult and the user via the planner's single prose reply; posting
// the raw dump made chat connectors double-post (raw "available_apps:"
// block + the planner's prose in the same turn).
export async function runList({ client }: RunListInput): Promise<ActionResult> {
	let installed: InstalledAppInfo[];
	let runs: AppRunSummary[];
	try {
		[installed, runs] = await Promise.all([
			client.listInstalledApps(),
			client.listAppRuns(),
		]);
	} catch (err) {
		// error-policy:J1 translate ONLY thrown transport errors into a typed
		// failure the planner can act on; caller aborts (turn cancellation) and
		// malformed payloads still fail fast so they stay observable.
		const code = transportFailureCode(err);
		if (!code) throw err;
		const reason =
			code === "LOOPBACK_TIMEOUT"
				? "did not answer the app-list routes within the read deadline"
				: "is not reachable";
		return {
			success: false,
			text: `The local dashboard ${reason}; the installed-app list is temporarily unavailable. Do not call APP again this turn — tell the user and answer anything else from context.`,
			userFacingText:
				code === "LOOPBACK_TIMEOUT"
					? "Couldn't read the app list — the local app registry didn't answer in time. Try again in a moment."
					: "Couldn't read the app list — the local app service isn't reachable right now.",
			data: { actionName: "APP", mode: "list", error: code },
		};
	}
	const text = formatTable(installed, runs);
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
