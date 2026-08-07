/** Searches the elizaOS plugin registry from a free-form query. */

import { logger } from "../../../../logger.ts";
import type {
	ActionResult,
	HandlerCallback,
} from "../../../../types/components.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import {
	describeUserReference,
	userReferenceLogView as queryLogView,
} from "../../../../utils/reference-echo.ts";
import type { PluginManagerService } from "../../services/pluginManagerService.ts";

export interface SearchInput {
	runtime: IAgentRuntime;
	query: string;
	callback?: HandlerCallback;
}

// Blob-safe rendering rationale lives in utils/reference-echo.ts.
const describeQuery = (query: string): string =>
	describeUserReference(query, "that request");

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

	logger.info(`[plugin-manager] search query="${queryLogView(query)}"`);
	const results = await service.searchRegistry(query);

	if (results.length === 0) {
		const text = `No plugins found matching ${describeQuery(query)}. Try keywords like database, twitter, solana, voice.`;
		await callback?.({ text });
		// The empty-result message is the complete answer: verified +
		// turnComplete make it the sole delivery instead of double-messaging
		// with the evaluator.
		return {
			success: true,
			text,
			userFacingText: text,
			verifiedUserFacing: true,
			turnComplete: true,
			values: { mode: "search", count: 0 },
		};
	}

	const lines: string[] = [
		`Found ${results.length} plugin(s) matching ${describeQuery(query)}:`,
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
	// The results listing IS the complete answer: verified + turnComplete
	// make it the sole delivery.
	return {
		success: true,
		text,
		userFacingText: text,
		verifiedUserFacing: true,
		turnComplete: true,
		values: {
			mode: "search",
			count: results.length,
			query: queryLogView(query),
		},
		data: { results },
	};
}
