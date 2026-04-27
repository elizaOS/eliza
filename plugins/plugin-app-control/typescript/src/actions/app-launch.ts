/**
 * @module plugin-app-control/actions/app-launch
 *
 * launch sub-mode of the unified APP action. Wraps the canonical
 * AppControlClient.launchApp call with name-resolution / disambiguation.
 */

import type { ActionResult, HandlerCallback, Memory } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { AppControlClient } from "../client/api.js";
import { extractLaunchTarget, readStringOption } from "../params.js";
import { formatAppCandidates, resolveInstalledApp } from "../resolve.js";

export interface RunLaunchInput {
	client: AppControlClient;
	message: Memory;
	options?: Record<string, unknown>;
	callback?: HandlerCallback;
}

export async function runLaunch({
	client,
	message,
	options,
	callback,
}: RunLaunchInput): Promise<ActionResult> {
	const target = extractLaunchTarget(message, options);
	if (!target) {
		const text =
			'I need the app name to launch. Try: "launch shopify" or pass { app: "companion" }.';
		await callback?.({ text });
		return { success: false, text };
	}

	const installed = await client.listInstalledApps();
	const resolution = resolveInstalledApp(target, installed);

	if (resolution.kind === "ambiguous") {
		const candidates = resolution.candidates ?? [];
		const text = `"${target}" matches multiple apps:\n${formatAppCandidates(
			candidates,
		)}\nPlease specify which one.`;
		await callback?.({ text });
		return { success: false, text, data: { candidates } };
	}

	if (resolution.kind === "none") {
		const text = `No installed app matches "${target}". Try \`mode=list\` to see what's available, or \`mode=create\` to scaffold a new one.`;
		await callback?.({ text });
		return { success: false, text, data: { target } };
	}

	const appName = resolution.match?.name ?? target;
	let result: Awaited<ReturnType<AppControlClient["launchApp"]>>;
	try {
		result = await client.launchApp(appName);
	} catch (err) {
		// Don't propagate — a thrown launch (HTTP 4xx/5xx, network error,
		// race with concurrent uninstall) must not crash the planner turn.
		const message = err instanceof Error ? err.message : String(err);
		const text = `Failed to launch ${appName}: ${message}`;
		logger.warn(
			`[plugin-app-control] APP/launch ${appName} failed: ${message}`,
		);
		await callback?.({ text });
		return { success: false, text, error: message };
	}
	const runId = result.run?.runId ?? null;
	const text = runId
		? `Launched ${result.displayName}. Run ID: ${runId}.`
		: `Launched ${result.displayName}.`;

	logger.info(
		`[plugin-app-control] APP/launch ${appName} runId=${runId ?? "<none>"}`,
	);

	await callback?.({ text });
	return {
		success: true,
		text,
		values: {
			mode: "launch",
			appName,
			displayName: result.displayName,
			runId,
		},
		data: { launch: result },
	};
}

/**
 * Re-export so the dispatcher can read an explicit `app` option without
 * pulling params helpers into app.ts.
 */
export { extractLaunchTarget, readStringOption };
