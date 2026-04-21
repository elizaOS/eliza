/**
 * @module plugin-app-control/actions/launch-app
 */

import type {
	Action,
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
	type AppControlClient,
	createAppControlClient,
} from "../client/api.js";
import { extractLaunchTarget } from "../params.js";
import { formatAppCandidates, resolveInstalledApp } from "../resolve.js";

export interface LaunchAppActionDeps {
	client?: AppControlClient;
}

/**
 * Factory so tests can inject a mock HTTP client. Production callers get
 * the default client created per-invocation (stateless).
 */
export function createLaunchAppAction(deps: LaunchAppActionDeps = {}): Action {
	const clientFactory = () => deps.client ?? createAppControlClient();

	return {
		name: "LAUNCH_APP",
		similes: [
			"OPEN_APP",
			"START_APP",
			"RUN_APP",
			"LAUNCH_MINI_APP",
			"LAUNCH_APPLICATION",
		],
		description:
			"Launch a registered Milady app by name, slug, or display name. Starts the underlying run and returns its runId so the caller can close or message it later.",

		validate: async (
			_runtime: IAgentRuntime,
			message: Memory,
		): Promise<boolean> => {
			const text = (message.content?.text ?? "").toLowerCase();
			const verb =
				text.includes("launch") ||
				text.includes("open") ||
				text.includes("start") ||
				text.includes("run") ||
				text.includes("fire up") ||
				text.includes("boot");
			const noun = text.includes("app") || text.includes("mini");
			return verb && noun;
		},

		handler: async (
			_runtime: IAgentRuntime,
			message: Memory,
			_state?: State,
			options?: Record<string, unknown>,
			callback?: HandlerCallback,
		): Promise<ActionResult> => {
			const target = extractLaunchTarget(message, options);
			if (!target) {
				const text =
					'I need the app name to launch. Try: "launch shopify" or pass { app: "companion" }.';
				await callback?.({ text });
				return { success: false, text };
			}

			const client = clientFactory();
			const installed = await client.listInstalledApps();
			const resolution = resolveInstalledApp(target, installed);

			if (resolution.kind === "ambiguous") {
				const candidates = resolution.candidates ?? [];
				const text = `"${target}" matches multiple apps:\n${formatAppCandidates(
					candidates,
				)}\nPlease specify which one.`;
				await callback?.({ text });
				return {
					success: false,
					text,
					data: { candidates },
				};
			}

			// Even if the app isn't in the installed list, hand the raw name to the
			// server — /api/apps/launch can install-and-launch from the registry.
			// We only fail fast when the installed list contains several matches
			// because then we have genuine ambiguity the user must resolve.
			const appName = resolution.match?.name ?? target;
			const result = await client.launchApp(appName);

			const runId = result.run?.runId ?? null;
			const text = runId
				? `Launched ${result.displayName}. Run ID: ${runId}.`
				: `Launched ${result.displayName}.`;

			logger.info(
				`[plugin-app-control] LAUNCH_APP ${appName} runId=${runId ?? "<none>"}`,
			);

			await callback?.({ text });
			return {
				success: true,
				text,
				values: {
					appName,
					displayName: result.displayName,
					runId,
				},
				data: { launch: result },
			};
		},

		examples: [
			[
				{
					name: "{{user1}}",
					content: { text: "launch shopify" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Launched Shopify. Run ID: run_abc123.",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "open the companion app" },
				},
				{
					name: "{{agentName}}",
					content: { text: "Launched Companion. Run ID: run_xyz789." },
				},
			],
		],
	};
}

export const launchAppAction: Action = createLaunchAppAction();
