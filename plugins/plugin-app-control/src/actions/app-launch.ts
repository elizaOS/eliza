/**
 * @module plugin-app-control/actions/app-launch
 *
 * launch sub-mode of the unified APP action. Wraps the canonical
 * AppControlClient.launchApp call with name-resolution / disambiguation.
 */

import type { ActionResult, HandlerCallback, Memory } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { AppControlClient } from "../client/api.js";
import {
	describeTargetReference,
	extractLaunchTarget,
	readStringOption,
	targetReferenceLogView,
} from "../params.js";
import { formatAppCandidates, resolveInstalledApp } from "../resolve.js";
import { openLaunchUrlInBrowserView } from "../services/browser-view-navigation.js";

export interface RunLaunchInput {
	client: AppControlClient;
	message: Memory;
	options?: Record<string, unknown>;
	callback?: HandlerCallback;
	openBrowserView?: (launchUrl: string) => Promise<boolean>;
}

export async function runLaunch({
	client,
	message,
	options,
	callback,
	openBrowserView = openLaunchUrlInBrowserView,
}: RunLaunchInput): Promise<ActionResult> {
	const target = extractLaunchTarget(message, options);
	if (!target) {
		// The clarification IS the designed ask the user must answer: verified +
		// turnComplete make it the turn's sole delivery instead of pairing it
		// with a second evaluator reply.
		const text = 'Which app should I launch? For example: "launch shopify".';
		await callback?.({ text });
		return {
			success: true,
			text: "No app name found in the launch request; asked the user which app to launch",
			userFacingText: text,
			verifiedUserFacing: true,
			turnComplete: true,
			values: { awaitingAppName: true },
		};
	}

	const installed = await client.listInstalledApps();
	const resolution = resolveInstalledApp(target, installed);

	if (resolution.kind === "ambiguous") {
		// Same contract as the missing-name clarify: the candidate menu is the
		// complete answer the user must pick from.
		const candidates = resolution.candidates ?? [];
		const text = `${describeTargetReference(target, "that app")} matches multiple apps:\n${formatAppCandidates(
			candidates,
		)}\nPlease specify which one.`;
		await callback?.({ text });
		return {
			success: true,
			text: `"${targetReferenceLogView(target)}" matched multiple installed apps; asked the user to pick one`,
			userFacingText: text,
			verifiedUserFacing: true,
			turnComplete: true,
			values: { awaitingAppChoice: true },
			data: { candidates },
		};
	}

	if (resolution.kind === "none") {
		const text = `No installed app matches ${describeTargetReference(target, "that app")}. Try \`mode=list\` to see what's available, or \`mode=create\` to scaffold a new one.`;
		await callback?.({ text });
		return {
			success: false,
			text,
			userFacingText: text,
			verifiedUserFacing: true,
			turnComplete: true,
			data: { target: targetReferenceLogView(target) },
		};
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
		return {
			success: false,
			text,
			userFacingText: text,
			verifiedUserFacing: true,
			turnComplete: true,
			error: message,
		};
	}
	const runId = result.run?.runId ?? null;
	const launchUrl = result.launchUrl?.trim() || null;
	const opened = launchUrl ? await openBrowserView(launchUrl) : false;
	const text = launchUrl
		? opened
			? `${result.displayName} is open in Browser. [Open ${result.displayName}](${launchUrl})`
			: `${result.displayName} is running. [Open ${result.displayName}](${launchUrl})`
		: `${result.displayName} is running.`;

	logger.info(
		`[plugin-app-control] APP/launch ${appName} runId=${runId ?? "<none>"}`,
	);

	await callback?.({ text });
	return {
		success: true,
		text,
		userFacingText: text,
		verifiedUserFacing: true,
		turnComplete: true,
		values: {
			mode: "launch",
			appName,
			displayName: result.displayName,
			runId,
			openedInBrowser: opened,
		},
		data: { launch: result },
	};
}

/**
 * Re-export so the dispatcher can read an explicit `app` option without
 * pulling params helpers into app.ts.
 */
export { extractLaunchTarget, readStringOption };
