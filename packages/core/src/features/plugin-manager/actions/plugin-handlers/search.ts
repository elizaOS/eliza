/**
 * @module features/plugin-manager/actions/plugin-handlers/search
 *
 * `search` sub-mode of the unified PLUGIN action. Searches the elizaOS
 * plugin registry by free-form query.
 */

import { logger } from "../../../../logger.ts";
import type {
	ActionResult,
	HandlerCallback,
} from "../../../../types/components.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import type { PluginManagerService } from "../../services/pluginManagerService.ts";

export interface SearchInput {
	runtime: IAgentRuntime;
	query: string;
	callback?: HandlerCallback;
}

export async function runSearch({
	runtime,
	query,
	callback,
}: SearchInput): Promise<ActionResult> {
	const service = runtime.getService(
		"plugin_manager",
	) as PluginManagerService | null;
	if (!service) {
		const text = "Plugin manager service not available";
		await callback?.({ text });
		return { success: false, text };
	}

	if (!query) {
		const text =
			'Specify a search query (e.g. "plugins for blockchain transactions").';
		await callback?.({ text });
		return { success: false, text };
	}

	logger.info(`[plugin-manager] search query="${query}"`);
	const results = await service.searchRegistry(query);

	if (results.length === 0) {
		const text = `No plugins found matching "${query}". Try keywords like database, twitter, solana, voice.`;
		await callback?.({ text });
		return { success: true, text, values: { mode: "search", count: 0 } };
	}

	const lines: string[] = [
		`Found ${results.length} plugin(s) matching "${query}":`,
		"",
	];
	results.forEach((plugin, idx) => {
		const score = plugin.score
			? ` (match: ${(plugin.score * 100).toFixed(0)}%)`
			: "";
		lines.push(`${idx + 1}. ${plugin.name}${score}`);
		if (plugin.description) lines.push(`   ${plugin.description}`);
		if (plugin.tags && plugin.tags.length > 0) {
			lines.push(`   tags: ${plugin.tags.slice(0, 5).join(", ")}`);
		}
		if (plugin.version) lines.push(`   version: ${plugin.version}`);
	});

	const text = lines.join("\n");
	await callback?.({ text });
	return {
		success: true,
		text,
		values: { mode: "search", count: results.length, query },
		data: { results },
	};
}
