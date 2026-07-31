/**
 * Stops a registered app through the same name-based route used by the app
 * management UI. Name resolution stays in the action so ambiguous planner
 * targets never reach the state-changing HTTP boundary.
 */

import type { ActionResult, HandlerCallback, Memory } from "@elizaos/core";
import type { AppControlClient } from "../client/api.js";
import { extractCloseTarget } from "../params.js";
import { formatAppCandidates, resolveInstalledApp } from "../resolve.js";

export interface RunStopInput {
	client: AppControlClient;
	message: Memory;
	options?: Record<string, unknown>;
	callback?: HandlerCallback;
}

export async function runStop({
	client,
	message,
	options,
	callback,
}: RunStopInput): Promise<ActionResult> {
	const { runId, appName: target } = extractCloseTarget(message, options);

	if (runId) {
		const result = await client.stopAppRun(runId);
		await callback?.({ text: result.message });
		return {
			success: result.success,
			text: result.message,
			values: {
				mode: "stop",
				appName: result.appName,
				runId: result.runId,
				stopScope: result.stopScope,
			},
			data: { stop: result },
		};
	}

	if (!target) {
		const text =
			'I need an app name or runId to stop. Try: "stop the feed app".';
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
		const text = `No installed app matches "${target}". Try \`mode=list\` to see what's available.`;
		await callback?.({ text });
		return { success: false, text, data: { target } };
	}

	const appName = resolution.match?.name ?? target;
	const result = await client.stopApp(appName);
	await callback?.({ text: result.message });
	return {
		success: result.success,
		text: result.message,
		values: {
			mode: "stop",
			appName: result.appName,
			runId: result.runId,
			stopScope: result.stopScope,
		},
		data: { stop: result },
	};
}
