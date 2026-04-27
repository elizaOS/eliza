/**
 * @module features/plugin-manager/actions/plugin-handlers/eject
 *
 * `eject` sub-mode of the unified PLUGIN action. Clones a registry plugin
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

	const text =
		`Ejected ${result.pluginName} to ${result.ejectedPath} ` +
		`(commit ${result.upstreamCommit.slice(0, 8)})` +
		(result.requiresRestart
			? "\nRestart required to load the local copy."
			: "");
	await callback?.({ text });
	return {
		success: true,
		text,
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
