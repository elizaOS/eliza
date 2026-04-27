/**
 * @module features/plugin-manager/actions/plugin-handlers/reinject
 *
 * `reinject` sub-mode of the unified PLUGIN action. Removes an ejected
 * plugin's local copy so the agent falls back to the npm-installed version.
 */

import type {
	ActionResult,
	HandlerCallback,
} from "../../../../types/components.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import type { PluginManagerService } from "../../services/pluginManagerService.ts";

export interface ReinjectInput {
	runtime: IAgentRuntime;
	name: string;
	callback?: HandlerCallback;
}

export async function runReinject({
	runtime,
	name,
	callback,
}: ReinjectInput): Promise<ActionResult> {
	const service = runtime.getService(
		"plugin_manager",
	) as PluginManagerService | null;
	if (!service) {
		const text = "Plugin manager service not available";
		await callback?.({ text });
		return { success: false, text };
	}

	if (!name) {
		const text = "Specify an ejected plugin name to reinject.";
		await callback?.({ text });
		return { success: false, text };
	}

	const result = await service.reinjectPlugin(name);

	if (!result.success) {
		const text = `Failed to reinject ${name}: ${result.error ?? "unknown error"}`;
		await callback?.({ text });
		return { success: false, text };
	}

	const text =
		`Reinjected ${result.pluginName} (removed ${result.removedPath})` +
		(result.requiresRestart ? "\nRestart required." : "");
	await callback?.({ text });
	return {
		success: true,
		text,
		values: {
			mode: "reinject",
			name: result.pluginName,
			removedPath: result.removedPath,
		},
		data: {
			success: result.success,
			pluginName: result.pluginName,
			removedPath: result.removedPath,
			requiresRestart: result.requiresRestart,
		},
	};
}
