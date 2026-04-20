/**
 * @module create-issue
 * @description Opens an issue in the target repo. Gated on confirmed:true
 * so the agent cannot file issues without explicit approval.
 */

import type {
	Action,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
	buildResolvedClient,
	isConfirmed,
	optionalStringArray,
	requireString,
	resolveIdentity,
	splitRepo,
} from "../action-helpers.js";
import {
	errorMessage,
	formatRateLimitMessage,
	inspectRateLimit,
} from "../rate-limit.js";
import { GitHubActions, type GitHubActionResult } from "../types.js";

export const createIssueAction: Action = {
	name: GitHubActions.CREATE_ISSUE,
	similes: ["OPEN_ISSUE", "FILE_ISSUE", "GITHUB_CREATE_ISSUE"],
	description:
		"Creates a GitHub issue in the target repo. Requires confirmed:true.",

	validate: async (
		runtime: IAgentRuntime,
		_message: Memory,
	): Promise<boolean> => {
		const r = buildResolvedClient(runtime, "agent");
		return !("error" in r);
	},

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: Record<string, unknown>,
		callback?: HandlerCallback,
	): Promise<GitHubActionResult<{ number: number; url: string }>> => {
		const identity = resolveIdentity(options, "agent");
		const repo = requireString(options, "repo");
		const title = requireString(options, "title");
		const body = requireString(options, "body");
		const labels = optionalStringArray(options, "labels");
		const assignees = optionalStringArray(options, "assignees");

		if (!repo || !title) {
			const err = "CREATE_ISSUE requires repo (owner/name) and title";
			await callback?.({ text: err });
			return { success: false, error: err };
		}
		const parts = splitRepo(repo);
		if (!parts) {
			const err = `Invalid repo "${repo}" — expected "owner/name"`;
			await callback?.({ text: err });
			return { success: false, error: err };
		}

		if (!isConfirmed(options)) {
			const preview =
				`About to create issue in ${repo}: "${title}"` +
				(labels ? ` [labels: ${labels.join(", ")}]` : "") +
				(assignees ? ` [assignees: ${assignees.join(", ")}]` : "") +
				` as ${identity}. Re-invoke with confirmed: true to proceed.`;
			await callback?.({ text: preview });
			return { success: false, requiresConfirmation: true, preview };
		}

		const resolved = buildResolvedClient(runtime, identity);
		if ("error" in resolved) {
			await callback?.({ text: resolved.error });
			return { success: false, error: resolved.error };
		}

		try {
			const resp = await resolved.client.issues.create({
				owner: parts.owner,
				repo: parts.name,
				title,
				body: body ?? undefined,
				labels,
				assignees,
			});
			await callback?.({
				text: `Created issue ${repo}#${resp.data.number}: ${resp.data.html_url}`,
			});
			return {
				success: true,
				data: { number: resp.data.number, url: resp.data.html_url },
			};
		} catch (err) {
			const rl = inspectRateLimit(err);
			const message = rl.isRateLimited
				? formatRateLimitMessage(rl)
				: `CREATE_ISSUE failed: ${errorMessage(err)}`;
			logger.warn({ message }, "[GitHub:CREATE_ISSUE]");
			await callback?.({ text: message });
			return { success: false, error: message };
		}
	},

	examples: [
		[
			{
				name: "{{user1}}",
				content: {
					text: "Open an issue in elizaOS/eliza titled 'Docs gap'",
				},
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Created issue elizaOS/eliza#101",
				},
			},
		],
	],
};
