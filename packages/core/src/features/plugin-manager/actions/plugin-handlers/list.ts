/**
 * @module features/plugin-manager/actions/plugin-handlers/list
 *
 * `list` sub-mode of the unified PLUGIN action. Reports the loaded
 * plugins in the runtime as tracked by PluginManagerService.
 */

import type {
	ActionResult,
	HandlerCallback,
} from "../../../../types/components.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import type { PluginManagerService } from "../../services/pluginManagerService.ts";

export interface ListInput {
	runtime: IAgentRuntime;
	callback?: HandlerCallback;
}

export async function runList({
	runtime,
	callback,
}: ListInput): Promise<ActionResult> {
	const service = runtime.getService(
		"plugin_manager",
	) as PluginManagerService | null;
	if (!service) {
		const text = "Plugin manager service not available";
		await callback?.({ text });
		return { success: false, text };
	}

	const all = service.getAllPlugins();
	const installed = await service.listInstalledPlugins();

	const lines: string[] = [];
	if (all.length === 0 && installed.length === 0) {
		const text = "No plugins are loaded or installed.";
		await callback?.({ text });
		return { success: true, text, values: { mode: "list", count: 0 } };
	}

	if (all.length > 0) {
		lines.push(`Loaded plugins (${all.length}):`);
		for (const p of all) {
			lines.push(`  - ${p.name} [${p.status}]`);
		}
	}

	if (installed.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(`Installed via registry (${installed.length}):`);
		for (const p of installed) {
			lines.push(`  - ${p.name} (v${p.version}) at ${p.path}`);
		}
	}

	const text = lines.join("\n");
	await callback?.({ text });
	return {
		success: true,
		text,
		values: {
			mode: "list",
			loadedCount: all.length,
			installedCount: installed.length,
		},
		data: {
			loaded: all.map((p) => ({ name: p.name, status: p.status })),
			installed,
		},
	};
}
