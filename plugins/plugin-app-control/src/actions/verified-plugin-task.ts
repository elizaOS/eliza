/**
 * Shared coding-task parameters for plugin create and edit operations.
 * Verification is the handoff that rebuilds and live-loads the finished plugin;
 * omitting it leaves successful source edits invisible to the running app.
 */

import type { HandlerOptions } from "@elizaos/core";

export function buildVerifiedPluginTaskParameters({
	task,
	label,
	workdir,
	pluginName,
	originRoomId,
}: {
	task: string;
	label: string;
	workdir: string;
	pluginName: string;
	originRoomId: string;
}): NonNullable<HandlerOptions["parameters"]> {
	return {
		task,
		label,
		workdir,
		lockWorkdir: true,
		keepAliveAfterComplete: true,
		approvalPreset: "permissive",
		validator: {
			service: "app-verification",
			method: "verifyPlugin",
			params: { workdir, pluginName, profile: "full" },
		},
		maxRetries: 2,
		onVerificationFail: "retry",
		metadata: { originRoomId },
	};
}
