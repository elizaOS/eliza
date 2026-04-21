/**
 * @module plugin-app-control/actions/close-app
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
import { extractCloseTarget } from "../params.js";
import { formatRunCandidates, resolveRunByName } from "../resolve.js";

export interface CloseAppActionDeps {
	client?: AppControlClient;
}

export function createCloseAppAction(deps: CloseAppActionDeps = {}): Action {
	const clientFactory = () => deps.client ?? createAppControlClient();

	return {
		name: "CLOSE_APP",
		similes: ["STOP_APP", "EXIT_APP", "KILL_APP", "QUIT_APP", "SHUTDOWN_APP"],
		description:
			"Stop a running Milady app. Accepts either an explicit runId or an app name/slug; when a name resolves to multiple running instances, returns the candidate list.",

		validate: async (
			_runtime: IAgentRuntime,
			message: Memory,
		): Promise<boolean> => {
			const text = (message.content?.text ?? "").toLowerCase();
			const verb =
				text.includes("close") ||
				text.includes("stop") ||
				text.includes("exit") ||
				text.includes("quit") ||
				text.includes("kill") ||
				text.includes("shut down") ||
				text.includes("shutdown");
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
			const { runId: explicitRunId, appName } = extractCloseTarget(
				message,
				options,
			);

			const client = clientFactory();

			if (explicitRunId) {
				const result = await client.stopAppRun(explicitRunId);
				const text = result.message || `Stopped run ${explicitRunId}.`;
				logger.info(
					`[plugin-app-control] CLOSE_APP runId=${explicitRunId} scope=${result.stopScope}`,
				);
				await callback?.({ text });
				return {
					success: true,
					text,
					values: {
						runId: explicitRunId,
						appName: result.appName,
						stopScope: result.stopScope,
					},
					data: { stop: result },
				};
			}

			if (!appName) {
				const text =
					'I need either an app name or a runId to close. Try: "close shopify" or pass { runId: "run_..." }.';
				await callback?.({ text });
				return { success: false, text };
			}

			const runs = await client.listAppRuns();
			const resolution = resolveRunByName(appName, runs);

			if (resolution.kind === "none") {
				const text = `No running app matches "${appName}".`;
				await callback?.({ text });
				return { success: false, text };
			}

			if (resolution.kind === "ambiguous") {
				const candidates = resolution.candidates ?? [];
				const text = `"${appName}" matches multiple running apps:\n${formatRunCandidates(
					candidates,
				)}\nPlease pass an explicit runId.`;
				await callback?.({ text });
				return { success: false, text, data: { candidates } };
			}

			const run = resolution.match;
			if (!run) {
				throw new Error("resolveRunByName returned kind=match without a match");
			}

			const result = await client.stopAppRun(run.runId);
			const text = result.message || `Stopped ${run.displayName}.`;
			logger.info(
				`[plugin-app-control] CLOSE_APP ${run.appName} runId=${run.runId} scope=${result.stopScope}`,
			);
			await callback?.({ text });
			return {
				success: true,
				text,
				values: {
					runId: run.runId,
					appName: run.appName,
					stopScope: result.stopScope,
				},
				data: { stop: result },
			};
		},

		examples: [
			[
				{
					name: "{{user1}}",
					content: { text: "close shopify" },
				},
				{
					name: "{{agentName}}",
					content: { text: "Stopped Shopify." },
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "stop the companion app" },
				},
				{
					name: "{{agentName}}",
					content: { text: "Stopped Companion." },
				},
			],
		],
	};
}

export const closeAppAction: Action = createCloseAppAction();
