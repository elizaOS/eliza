/**
 * @module plugin-app-control/actions/app-relaunch
 *
 * relaunch sub-mode: stop matching runs (or a specific runId), then launch
 * the named app. When `verify: true`, chains into AppVerificationService
 * with the fast profile (typecheck + lint).
 */

import type {
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { AppControlClient } from "../client/api.js";
import { extractLaunchTarget, readStringOption } from "../params.js";
import { formatAppCandidates, resolveInstalledApp } from "../resolve.js";

interface AppVerificationLike {
	verifyApp(opts: {
		workdir: string;
		appName?: string;
		profile?: "fast" | "full";
	}): Promise<{ verdict: "pass" | "fail"; retryablePromptForChild: string }>;
}

export interface RunRelaunchInput {
	runtime: IAgentRuntime;
	client: AppControlClient;
	message: Memory;
	options?: Record<string, unknown>;
	callback?: HandlerCallback;
}

export async function runRelaunch({
	runtime,
	client,
	message,
	options,
	callback,
}: RunRelaunchInput): Promise<ActionResult> {
	const explicitRunId = readStringOption(options, "runId");
	const target =
		readStringOption(options, "app") ??
		readStringOption(options, "name") ??
		extractLaunchTarget(message, options);

	if (!target && !explicitRunId) {
		const text = "Which app should I relaunch?";
		await callback?.({ text });
		// The clarify question is the designed ask the user must answer: verified
		// + turnComplete make it the sole delivery instead of pairing it with a
		// second evaluator reply.
		return {
			success: true,
			text: "No app name in the relaunch request; asked the user which app to relaunch",
			userFacingText: text,
			verifiedUserFacing: true,
			turnComplete: true,
			values: { awaitingAppName: true },
		};
	}

	let appName = target ?? "";
	if (target) {
		const installed = await client.listInstalledApps();
		const resolution = resolveInstalledApp(target, installed);
		if (resolution.kind === "ambiguous") {
			const candidates = resolution.candidates ?? [];
			const text = `"${target}" matches multiple apps:\n${formatAppCandidates(
				candidates,
			)}\nPlease specify which one.`;
			await callback?.({ text });
			return {
				success: true,
				text: `"${target}" matched multiple installed apps; asked the user which one to relaunch`,
				userFacingText: text,
				verifiedUserFacing: true,
				turnComplete: true,
				values: { awaitingSelection: true },
				data: { candidates },
			};
		}
		appName = resolution.match?.name ?? target;
	}

	// Stop the running instance(s) first.
	if (explicitRunId) {
		await client.stopAppRun(explicitRunId).catch((err: unknown) => {
			logger.warn(
				`[plugin-app-control] APP/relaunch stopAppRun ${explicitRunId} failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		});
	} else if (appName) {
		const runs = await client.listAppRuns();
		const matched = runs.filter(
			(r) =>
				r.appName === appName ||
				r.displayName === appName ||
				r.appName.endsWith(appName),
		);
		for (const run of matched) {
			await client.stopAppRun(run.runId).catch((err: unknown) => {
				logger.warn(
					`[plugin-app-control] APP/relaunch stopAppRun ${run.runId} failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		}
	}

	if (!appName) {
		const text = "I stopped that run, but which app should I relaunch?";
		await callback?.({ text });
		return {
			success: true,
			text: `Stopped run ${explicitRunId} but no app name was supplied; asked the user which app to relaunch`,
			userFacingText: text,
			verifiedUserFacing: true,
			turnComplete: true,
			values: { awaitingAppName: true },
		};
	}

	const launch = await client.launchApp(appName);
	const newRunId = launch.run?.runId ?? null;
	const baseText = newRunId
		? `Relaunched ${launch.displayName}. New run ID: ${newRunId}.`
		: `Relaunched ${launch.displayName}.`;

	let verifySection = "";
	let verifyFailDetail: string | undefined;
	const wantsVerify =
		options?.verify === true || readStringOption(options, "verify") === "true";
	if (wantsVerify) {
		const workdir = readStringOption(options, "workdir");
		if (!workdir) {
			verifySection =
				'\n(Skipping verify: no workdir was supplied; pass { workdir: "/abs/path" }.)';
		} else {
			const service = runtime.getService(
				"app-verification",
			) as AppVerificationLike | null;
			if (!service) {
				verifySection =
					"\n(Skipping verify: AppVerificationService is not registered.)";
			} else {
				const verifyResult = await service.verifyApp({
					workdir,
					appName,
					profile: "fast",
				});
				// retryablePromptForChild is written for a child coding agent — it
				// stays planner-facing in the result; the visible line stays human.
				verifySection =
					verifyResult.verdict === "fail"
						? "\nA quick verification check failed after the relaunch — the app may not be fully working yet."
						: "\nA quick verification check passed.";
				if (verifyResult.verdict === "fail") {
					verifyFailDetail = verifyResult.retryablePromptForChild;
				}
			}
		}
	}

	const text = `${baseText}${verifySection}`;
	await callback?.({ text });
	logger.info(
		`[plugin-app-control] APP/relaunch ${appName} newRunId=${newRunId ?? "<none>"} verify=${wantsVerify}`,
	);

	return {
		success: true,
		text: verifyFailDetail ? `${text}\n${verifyFailDetail}` : text,
		values: {
			mode: "relaunch",
			appName,
			displayName: launch.displayName,
			runId: newRunId,
		},
		data: { launch },
	};
}
