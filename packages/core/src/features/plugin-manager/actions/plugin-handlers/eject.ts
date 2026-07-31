/**
 * @module features/plugin-manager/actions/plugin-handlers/eject
 *
 * `eject` sub-mode of the PLUGIN action. Clones a registry plugin
 * into the local ejected directory so the user can edit + sync against
 * upstream.
 */

import type {
	ActionResult,
	HandlerCallback,
} from "../../../../types/components.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import type { PluginManagerService } from "../../services/pluginManagerService.ts";

export interface EjectInput {
	runtime: IAgentRuntime;
	name: string;
	callback?: HandlerCallback;
}

export async function runEject({
	runtime,
	name,
	callback,
}: EjectInput): Promise<ActionResult> {
	const service = runtime.getService(
		"plugin_manager",
	) as PluginManagerService | null;
	if (!service) {
		const text = "Plugin manager service not available";
		await callback?.({ text });
		return { success: false, text };
	}

	if (!name) {
		const text = "Specify a plugin name to eject.";
		await callback?.({ text });
		return { success: false, text };
	}

	const result = await service.ejectPlugin(name);

	if (!result.success) {
		const text = `Failed to eject ${name}: ${result.error ?? "unknown error"}`;
		await callback?.({ text });
		return { success: false, text };
	}

	// Human wording, no raw path or commit hash (those stay in values/data);
	// verified + turnComplete make the confirmation the sole delivery.
	const text =
		`Ejected ${result.pluginName} — the local copy is ready to edit.` +
		(result.requiresRestart
			? " A restart is needed to load the local copy."
			: "");
	await callback?.({ text });
	return {
		success: true,
		text,
		userFacingText: text,
		verifiedUserFacing: true,
		turnComplete: true,
		values: {
			mode: "eject",
			name: result.pluginName,
			ejectedPath: result.ejectedPath,
			upstreamCommit: result.upstreamCommit,
		},
		data: {
			success: result.success,
			pluginName: result.pluginName,
			ejectedPath: result.ejectedPath,
			upstreamCommit: result.upstreamCommit,
			requiresRestart: result.requiresRestart,
		},
	};
}
