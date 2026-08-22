/**
 * Surfaces installed apps and running counts to the planner without putting
 * loopback or registry initialization on the message path. Each runtime owns
 * an isolated stale-while-revalidate snapshot; cold and failed refreshes are
 * explicit states rather than fabricated healthy-empty context.
 */

import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "@elizaos/core";
import { createAppControlClient } from "../client/api.js";

const SNAPSHOT_TTL_MS = 45_000;

interface AvailableAppsSnapshot {
	at: number;
	result: ProviderResult;
}

interface AvailableAppsCache {
	snapshot: AvailableAppsSnapshot | null;
	refresh: Promise<void> | null;
}

const cacheByRuntime = new WeakMap<IAgentRuntime, AvailableAppsCache>();

function unavailableResult(status: "loading" | "error"): ProviderResult {
	return {
		text: [
			"available_apps:",
			`  status: ${status === "loading" ? "loading" : "unavailable"}`,
			"  guidance: use the APP action for a live inventory when needed",
		].join("\n"),
		values: {
			availableAppsStatus: status,
		},
		data: {
			status,
		},
	};
}

function cacheFor(runtime: IAgentRuntime): AvailableAppsCache {
	const existing = cacheByRuntime.get(runtime);
	if (existing) return existing;
	const created: AvailableAppsCache = { snapshot: null, refresh: null };
	cacheByRuntime.set(runtime, created);
	return created;
}

async function fetchAvailableApps(): Promise<ProviderResult> {
	const client = createAppControlClient();
	const [installed, runs] = await Promise.all([
		client.listInstalledApps(),
		client.listAppRuns(),
	]);

	if (installed.length === 0 && runs.length === 0) {
		return {
			text: "",
			values: {
				availableAppsStatus: "ready",
				installedAppCount: 0,
				runningAppCount: 0,
			},
			data: {
				status: "ready",
				installed: [],
				runs: [],
				truncated: false,
			},
		};
	}

	const runsByApp = new Map<string, number>();
	for (const run of runs) {
		runsByApp.set(run.appName, (runsByApp.get(run.appName) ?? 0) + 1);
	}

	const listedInstalled = installed;

	const lines: string[] = [];
	lines.push("available_apps:");
	lines.push("  status: ready");
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
	} else {
		lines.push("apps[0]:");
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

	return {
		text: lines.join("\n"),
		values: {
			availableAppsStatus: "ready",
			installedAppCount: installed.length,
			runningAppCount: runs.length,
		},
		data: {
			status: "ready",
			installed: listedInstalled,
			runs,
			truncated: false,
		},
	};
}

function refreshAvailableApps(
	runtime: IAgentRuntime,
	cache: AvailableAppsCache,
): void {
	if (cache.refresh) return;
	cache.refresh = fetchAvailableApps()
		.then((result) => {
			cache.snapshot = { at: Date.now(), result };
		})
		.catch((error) => {
			// error-policy:J4 the planner receives an explicit unavailable state
			// while the runtime error channel preserves the loopback failure.
			runtime.reportError("availableAppsProvider.refresh", error, {
				provider: "available_apps",
			});
			cache.snapshot = {
				at: Date.now(),
				result: unavailableResult("error"),
			};
		})
		.finally(() => {
			cache.refresh = null;
		});
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
		runtime: IAgentRuntime,
		_message: Memory,
		_state: State,
	): Promise<ProviderResult> => {
		const cache = cacheFor(runtime);
		if (!cache.snapshot) {
			refreshAvailableApps(runtime, cache);
			return unavailableResult("loading");
		}
		if (Date.now() - cache.snapshot.at > SNAPSHOT_TTL_MS) {
			refreshAvailableApps(runtime, cache);
		}
		return cache.snapshot.result;
	},
};

export default availableAppsProvider;
