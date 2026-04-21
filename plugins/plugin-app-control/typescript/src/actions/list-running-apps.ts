/**
 * @module plugin-app-control/actions/list-running-apps
 */

import type {
	Action,
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "@elizaos/core";
import {
	type AppControlClient,
	createAppControlClient,
} from "../client/api.js";
import type { AppRunSummary } from "../types.js";

export interface ListRunningAppsActionDeps {
	client?: AppControlClient;
}

function formatRuns(runs: readonly AppRunSummary[]): string {
	if (runs.length === 0) {
		return "No apps are currently running.";
	}
	const lines = [
		`${runs.length} app${runs.length === 1 ? "" : "s"} running:`,
		...runs.map(
			(run) =>
				`- ${run.displayName} (${run.appName}) [runId: ${run.runId}, status: ${run.status}]`,
		),
	];
	return lines.join("\n");
}

export function createListRunningAppsAction(
	deps: ListRunningAppsActionDeps = {},
): Action {
	const clientFactory = () => deps.client ?? createAppControlClient();

	return {
		name: "LIST_RUNNING_APPS",
		similes: [
			"LIST_APPS",
			"WHATS_OPEN",
			"SHOW_RUNNING_APPS",
			"RUNNING_APPS",
			"ACTIVE_APPS",
		],
		description:
			"List all currently running Milady apps with their display names, runIds, and status. Useful before issuing a CLOSE_APP when there may be ambiguity.",

		validate: async (
			_runtime: IAgentRuntime,
			message: Memory,
		): Promise<boolean> => {
			const text = (message.content?.text ?? "").toLowerCase();
			const verb =
				text.includes("list") ||
				text.includes("show") ||
				text.includes("what") ||
				text.includes("running");
			const noun = text.includes("app");
			return verb && noun;
		},

		handler: async (
			_runtime: IAgentRuntime,
			_message: Memory,
			_state?: State,
			_options?: Record<string, unknown>,
			callback?: HandlerCallback,
		): Promise<ActionResult> => {
			const client = clientFactory();
			const runs = await client.listAppRuns();
			const text = formatRuns(runs);
			await callback?.({ text });
			return {
				success: true,
				text,
				values: { runCount: runs.length },
				data: { runs },
			};
		},

		examples: [
			[
				{
					name: "{{user1}}",
					content: { text: "what apps are open?" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "2 apps running:\n- Shopify (shopify) [runId: run_abc, status: active]\n- Companion (companion) [runId: run_xyz, status: active]",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "list running apps" },
				},
				{
					name: "{{agentName}}",
					content: { text: "No apps are currently running." },
				},
			],
		],
	};
}

export const listRunningAppsAction: Action = createListRunningAppsAction();
