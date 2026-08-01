/**
 * @module features/plugin-manager/actions/plugin-handlers/sync
 *
 * `sync` sub-mode of the PLUGIN action. Pulls upstream changes
 * for an ejected plugin.
 */

import type {
	ActionResult,
	HandlerCallback,
} from "../../../../types/components.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import type { PluginManagerService } from "../../services/pluginManagerService.ts";

export interface SyncInput {
	runtime: IAgentRuntime;
	name: string;
	callback?: HandlerCallback;
}

export async function runSync({
	runtime,
	name,
	callback,
}: SyncInput): Promise<ActionResult> {
	const service = runtime.getService(
		"plugin_manager",
	) as PluginManagerService | null;
	if (!service) {
		const text = "Plugin manager service not available";
		await callback?.({ text });
		return { success: false, text };
	}

	if (!name) {
		const text = "Specify an ejected plugin name to sync.";
		await callback?.({ text });
		return { success: false, text };
	}

	const result = await service.syncPlugin(name);

	if (!result.success) {
		const text = `Failed to sync ${name}: ${result.error ?? "unknown error"}`;
		await callback?.({ text });
		return { success: false, text };
	}

	// Human wording, no commit-hash git-jargon (it stays in values/data);
	// verified + turnComplete make the confirmation the sole delivery.
	const text =
		`Synced ${result.pluginName} with ${result.upstreamCommits} new upstream update(s).` +
		(result.requiresRestart ? " A restart is needed to pick them up." : "");
	await callback?.({ text });
	return {
		success: true,
		text,
		userFacingText: text,
		verifiedUserFacing: true,
		turnComplete: true,
		values: {
			mode: "sync",
			name: result.pluginName,
			upstreamCommits: result.upstreamCommits,
			commitHash: result.commitHash,
		},
		data: {
			success: result.success,
			pluginName: result.pluginName,
			ejectedPath: result.ejectedPath,
			upstreamCommits: result.upstreamCommits,
			localChanges: result.localChanges,
			conflicts: result.conflicts,
			commitHash: result.commitHash,
			requiresRestart: result.requiresRestart,
		},
	};
}
