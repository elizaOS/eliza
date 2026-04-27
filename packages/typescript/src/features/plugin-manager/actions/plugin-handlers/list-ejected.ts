/**
 * @module features/plugin-manager/actions/plugin-handlers/list-ejected
 *
 * `list_ejected` sub-mode of the unified PLUGIN action. Lists plugins
 * currently ejected to the local managed directory.
 */

import type {
	ActionResult,
	HandlerCallback,
} from "../../../../types/components.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import type { PluginManagerService } from "../../services/pluginManagerService.ts";

export interface ListEjectedInput {
	runtime: IAgentRuntime;
	callback?: HandlerCallback;
}

export async function runListEjected({
	runtime,
	callback,
}: ListEjectedInput): Promise<ActionResult> {
	const service = runtime.getService(
		"plugin_manager",
	) as PluginManagerService | null;
	if (!service) {
		const text = "Plugin manager service not available";
		await callback?.({ text });
		return { success: false, text };
	}

	const plugins = await service.listEjectedPlugins();

	if (plugins.length === 0) {
		const text = "No ejected plugins found.";
		await callback?.({ text });
		return { success: true, text, values: { mode: "list_ejected", count: 0 } };
	}

	const list = plugins
		.map((p) => `  - ${p.name} (v${p.version}) at ${p.path}`)
		.join("\n");
	const text = `Ejected plugins (${plugins.length}):\n${list}`;
	await callback?.({ text });
	return {
		success: true,
		text,
		values: { mode: "list_ejected", count: plugins.length },
		data: { plugins },
	};
}
