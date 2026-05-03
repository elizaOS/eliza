/**
 * @module features/plugin-manager/actions/plugin-handlers/install
 *
 * `install` sub-mode of the unified PLUGIN action. Installs a plugin from
 * the registry by canonical name. The underlying service handles the
 * npm/git source selection internally — `source: "git"` simply forces a
 * clone via the `PLUGIN_MANAGER_LOCAL_CLONE` env override on this call.
 */

import { logger } from "../../../../logger.ts";
import type {
	ActionResult,
	HandlerCallback,
} from "../../../../types/components.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import type { PluginManagerService } from "../../services/pluginManagerService.ts";

export interface InstallInput {
	runtime: IAgentRuntime;
	name: string;
	source?: "npm" | "git";
	callback?: HandlerCallback;
}

export async function runInstall({
	runtime,
	name,
	source,
	callback,
}: InstallInput): Promise<ActionResult> {
	const service = runtime.getService(
		"plugin_manager",
	) as PluginManagerService | null;
	if (!service) {
		const text = "Plugin manager service not available";
		await callback?.({ text });
		return { success: false, text };
	}

	if (!name) {
		const text =
			"Specify a plugin name to install (e.g. @elizaos/plugin-discord).";
		await callback?.({ text });
		return { success: false, text };
	}

	const prevClone = process.env.PLUGIN_MANAGER_LOCAL_CLONE;
	if (source === "git") process.env.PLUGIN_MANAGER_LOCAL_CLONE = "true";

	const result = await service.installPlugin(name, (progress) => {
		logger.info(
			`[plugin-manager] install ${name} ${progress.phase}: ${progress.message}`,
		);
	});

	if (source === "git") {
		if (prevClone === undefined) delete process.env.PLUGIN_MANAGER_LOCAL_CLONE;
		else process.env.PLUGIN_MANAGER_LOCAL_CLONE = prevClone;
	}

	if (!result.success) {
		const text = `Failed to install ${name}: ${result.error ?? "unknown error"}`;
		await callback?.({ text });
		return { success: false, text };
	}

	const text =
		`Installed ${result.pluginName}@${result.version} at ${result.installPath}` +
		(result.requiresRestart ? "\nRestart required to activate." : "");
	await callback?.({ text });
	return {
		success: true,
		text,
		values: {
			mode: "install",
			name: result.pluginName,
			version: result.version,
			installPath: result.installPath,
		},
		data: {
			success: result.success,
			pluginName: result.pluginName,
			version: result.version,
			installPath: result.installPath,
			requiresRestart: result.requiresRestart,
		},
	};
}
