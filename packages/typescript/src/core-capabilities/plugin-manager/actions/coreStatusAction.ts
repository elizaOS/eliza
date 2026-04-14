import type { Action, HandlerOptions } from "../../../types/components.ts";
import type { Memory } from "../../../types/memory.ts";
import type { IAgentRuntime } from "../../../types/runtime.ts";
import type { State } from "../../../types/state.ts";
import type {
	CoreManagerService,
	CoreStatus,
} from "../services/coreManagerService.ts";

export const coreStatusAction: Action = {
	name: "CORE_STATUS",
	description: "Check thestatus of the @elizaos/core package (ejected or npm)",
	similes: ["core status", "check core", "is core ejected", "elizaos status"],

	examples: [
		[
			{
				name: "{{user1}}",
				content: {
					text: "core status",
					action: "CORE_STATUS",
				},
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Core is currently ejected at ...",
					action: "CORE_STATUS",
				},
			},
		],
	],

	async handler(runtime, _message, _state, _options, callback) {
		const coreManagerService = runtime.getService(
			"core_manager",
		) as CoreManagerService;

		if (!coreManagerService) {
			if (callback)
				await callback({ text: "Core manager service not available" });
			return undefined;
		}

		try {
			const status: CoreStatus = await coreManagerService.getCoreStatus();

			let msg = "";
			if (status.ejected) {
				msg =
					`Core is EJECTED at ${status.ejectedPath}.\n` +
					`Version: ${status.version}\n` +
					`Commit: ${status.commitHash || "unknown"}\n` +
					`Local changes: ${status.localChanges ? "Yes" : "No"}\n`;

				if (status.upstream) {
					msg +=
						`Upstream: ${status.upstream.gitUrl}#${status.upstream.branch}\n` +
						`Last sync: ${status.upstream.lastSyncAt || "never"}`;
				}
			} else {
				msg = `Core is using NPM package (v${status.npmVersion}). Not ejected.`;
			}

			if (callback) await callback({ text: msg });
		} catch (error) {
			if (callback)
				await callback({
					text: `Error checking core status: ${error instanceof Error ? error.message : String(error)}`,
				});
		}
		return undefined;
	},

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: HandlerOptions,
	): Promise<boolean> => {
		const text = message.content?.text?.toLowerCase() ?? "";
		return (
			text.includes("core") &&
			text.includes("status") &&
			Boolean(runtime.getService("core_manager"))
		);
	},
};
