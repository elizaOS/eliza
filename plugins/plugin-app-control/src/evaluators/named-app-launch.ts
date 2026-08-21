/** Route explicit named-app launch requests before generic view navigation. */

import type {
	ResponseHandlerEvaluator,
	ResponseHandlerEvaluatorContext,
} from "@elizaos/core";
import { createAppControlClient } from "../client/api.js";
import { userRequestMessageText } from "../params.js";
import { resolveInstalledApp } from "../resolve.js";
import type { InstalledAppInfo } from "../types.js";

const APP_ACTION_NAME = "APP";
const GENERAL_CONTEXT = "general";
const NAMED_LAUNCH =
	/^\s*(?:please\s+)?(?:open|launch|start|run|show)(?:\s+me)?(?:\s+(?:the|my))?(?:\s+(?:app|application))?\s+(.+?)(?:\s+(?:please|now))?[.!?]*\s*$/iu;
const GENERIC_APP_REFERENCE =
	/^(?:it|that|this|(?:the|my)\s+(?:app|application)|app|application)$/iu;

type NamedAppLaunch = {
	appName: string;
	displayName: string;
};

export type InstalledAppLister = () => Promise<InstalledAppInfo[]>;

function hasRegisteredAppAction(
	context: ResponseHandlerEvaluatorContext,
): boolean {
	return (context.runtime.actions ?? []).some(
		(action) => action.name?.toUpperCase() === APP_ACTION_NAME,
	);
}

function namedLaunchTarget(
	context: ResponseHandlerEvaluatorContext,
): string | null {
	if (!hasRegisteredAppAction(context)) return null;
	const text = userRequestMessageText(context.message);
	const match = text.match(NAMED_LAUNCH);
	const target = match?.[1]?.trim().replace(/\s+(?:app|application)$/iu, "");
	return target && !GENERIC_APP_REFERENCE.test(target) ? target : null;
}

export function createNamedAppLaunchEvaluator(
	listInstalledApps: InstalledAppLister = () =>
		createAppControlClient().listInstalledApps(),
): ResponseHandlerEvaluator {
	const resolutions = new WeakMap<object, Promise<NamedAppLaunch | null>>();

	const resolve = (
		context: ResponseHandlerEvaluatorContext,
	): Promise<NamedAppLaunch | null> => {
		const key = context.message as object;
		const cached = resolutions.get(key);
		if (cached) return cached;
		const target = namedLaunchTarget(context);
		if (!target) return Promise.resolve(null);
		const pending = listInstalledApps()
			.then((installed) => {
				const resolution = resolveInstalledApp(target, installed);
				if (resolution.kind === "none") return null;
				if (resolution.kind === "match" && resolution.match) {
					return {
						appName: resolution.match.name,
						displayName: resolution.match.displayName,
					};
				}
				// APP owns the ambiguity menu. Passing the original target preserves
				// its canonical disambiguation behavior without guessing a match.
				return { appName: target, displayName: target };
			})
			.catch((error) => {
				context.runtime.reportError("namedAppLaunchEvaluator.list", error, {
					evaluator: "app-control.named-app-launch",
				});
				return null;
			});
		resolutions.set(key, pending);
		return pending;
	};

	return {
		name: "app-control.named-app-launch",
		description:
			"Routes explicit launch/open requests for an installed app to APP before generic UI-view navigation.",
		priority: 5,
		deterministicActions: [APP_ACTION_NAME],
		shouldRun: async (context) => (await resolve(context)) !== null,
		evaluate: async (context) => {
			const launch = await resolve(context);
			if (!launch) return undefined;
			return {
				requiresTool: true,
				clearReply: true,
				clearCandidateActions: true,
				addCandidateActions: [APP_ACTION_NAME],
				clearParentActionHints: true,
				addParentActionHints: [APP_ACTION_NAME],
				addContexts: [GENERAL_CONTEXT],
				deterministicToolCall: {
					name: APP_ACTION_NAME,
					params: {
						action: "launch",
						mode: "launch",
						app: launch.appName,
						name: launch.appName,
					},
				},
				debug: [`installed app ${launch.appName} owns named launch request`],
			};
		},
	};
}

export const namedAppLaunchEvaluator = createNamedAppLaunchEvaluator();
