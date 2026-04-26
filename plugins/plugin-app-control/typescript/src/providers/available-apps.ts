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

export const availableAppsProvider: Provider = {
	name: "available_apps",
	description:
		"Installed Milady apps with running-run counts; use this to pick targets for APP launch / relaunch / list / create.",
	descriptionCompressed: "Installed apps + running counts for APP action.",
	position: -8,
	dynamic: true,

	get: async (
		_runtime: IAgentRuntime,
		_message: Memory,
		_state: State,
	): Promise<ProviderResult> => {
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
		lines.push("## Available apps");
		lines.push("Use APP with mode=launch / relaunch / list / create.");
		if (listedInstalled.length > 0) {
			for (const app of listedInstalled) {
				const running = runsByApp.get(app.name) ?? 0;
				const tail = running > 0 ? ` — running x${running}` : "";
				lines.push(`- **${app.displayName}** (\`${app.name}\`)${tail}`);
			}
			if (overflow > 0) {
				lines.push(`…and ${overflow} more.`);
			}
		} else {
			lines.push("- (none installed)");
		}

		const orphanRuns = runs.filter(
			(r) => !installed.some((app) => app.name === r.appName),
		);
		if (orphanRuns.length > 0) {
			lines.push("");
			lines.push("### Other running runs");
			for (const run of orphanRuns) {
				lines.push(
					`- ${run.displayName} (\`${run.appName}\`) [runId: ${run.runId}]`,
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
				runs,
				truncated: overflow > 0,
			},
		};
	},
};

export default availableAppsProvider;
