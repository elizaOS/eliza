import { logger } from "../../../logger.ts";
import type { Action, HandlerOptions } from "../../../types/components.ts";
import type { Memory } from "../../../types/memory.ts";
import type { IAgentRuntime } from "../../../types/runtime.ts";
import type { State } from "../../../types/state.ts";
import {
	getPluginDetails,
	searchPluginsByContent,
} from "../services/pluginRegistryService.ts";

function hasSearchPluginIntent(text: string): boolean {
	const searchPatterns = [
		/search.*plugins?/i,
		/find.*plugins?/i,
		/look.*for.*plugins?/i,
		/discover.*plugins?/i,
		/plugins?.*(for|that|to)/i,
		/need.*plugins?/i,
		/show.*plugins?/i,
		/list.*plugins?/i,
	];

	return searchPatterns.some((pattern) => pattern.test(text));
}

function hasPluginDetailsIntent(text: string): boolean {
	return (
		/tell\s+me\s+more|show\s+details|plugin\s+info|more\s+about/.test(text) &&
		/@?[\w-]+\/plugin-[\w-]+|plugin-[\w-]+/.test(text)
	);
}

export const searchPluginAction: Action = {
	name: "SEARCH_PLUGINS",
	similes: [
		"search for plugins",
		"find plugins",
		"look for plugins",
		"discover plugins",
		"search registry",
	],

	description:
		"Search for plugins in the ElizaOS registry by functionality, features, and natural language descriptions.",

	examples: [
		[
			{
				name: "{{user1}}",
				content: {
					text: "Search for plugins that can handle blockchain transactions",
					actions: ["SEARCH_PLUGINS"],
				},
			},
			{
				name: "{{agentName}}",
				content: {
					text: "I'll search for blockchain-related plugins that can handle transactions.",
					actions: ["SEARCH_PLUGINS"],
				},
			},
		],
	],

	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: HandlerOptions,
	): Promise<boolean> => {
		const text = message.content?.text?.toLowerCase() ?? "";
		return hasSearchPluginIntent(text);
	},

	handler: async (_runtime, message, _state, _options, callback) => {
		logger.info("[searchPluginAction] Starting plugin search");

		const query = extractSearchQuery(message.content?.text || "");

		if (!query) {
			if (callback) {
				await callback({
					text: 'Please specify what kind of functionality or features you\'re looking for in a plugin.\n\nFor example:\n- "Search for plugins that handle blockchain transactions"\n- "Find plugins for social media integration"\n- "Look for plugins that can process images"',
					actions: ["SEARCH_PLUGINS"],
				});
			}
			return undefined;
		}

		logger.info(`[searchPluginAction] Searching for: "${query}"`);

		const results = await searchPluginsByContent(query);

		if (results.length === 0) {
			if (callback) {
				await callback({
					text: `No plugins found matching "${query}".\n\nTry different keywords like: "database", "api", "blockchain", "twitter", "discord", "solana"`,
					actions: ["SEARCH_PLUGINS"],
				});
			}
			return undefined;
		}

		let responseText = `Found ${results.length} plugin${results.length > 1 ? "s" : ""} matching "${query}":\n\n`;

		results.forEach((plugin, index) => {
			const score = plugin.score ? (plugin.score * 100).toFixed(0) : "";

			responseText += `${index + 1}. **${plugin.name}**${score ? ` (Match: ${score}%)` : ""}\n`;

			if (plugin.description) {
				responseText += `   ${plugin.description}\n`;
			}

			if (plugin.tags && plugin.tags.length > 0) {
				const displayTags = plugin.tags.slice(0, 5);
				responseText += `   Tags: ${displayTags.join(", ")}\n`;
			}

			if (plugin.version) {
				responseText += `   Version: ${plugin.version}\n`;
			}

			const supported: string[] = [];
			if (plugin.supports.v0) supported.push("v0");
			if (plugin.supports.v1) supported.push("v1");
			if (plugin.supports.v2) supported.push("v2");
			if (supported.length > 0) {
				responseText += `   Supports: ${supported.join(", ")}\n`;
			}

			if (plugin.stars > 0) {
				responseText += `   Stars: ${plugin.stars}\n`;
			}

			responseText += "\n";
		});

		responseText += "**Next steps:**\n";
		responseText +=
			'- Say "tell me more about [plugin-name]" for detailed info\n';
		responseText +=
			'- Say "search for plugins for [use-case]" to refine results\n';
		responseText +=
			'- Ask for another capability area (e.g. "plugins for wallets")';

		if (callback) {
			await callback({
				text: responseText,
				actions: ["SEARCH_PLUGINS"],
			});
		}

		return undefined;
	},
};

function extractSearchQuery(text: string): string | null {
	const patterns = [
		/search\s+for\s+plugins?\s+(?:that\s+)?(?:can\s+)?(.+)/i,
		/find\s+plugins?\s+(?:for|that|to)\s+(.+)/i,
		/look\s+for\s+plugins?\s+(?:that\s+)?(.+)/i,
		/discover\s+plugins?\s+(?:for|that)\s+(.+)/i,
		/show\s+me\s+plugins?\s+(?:for|that)\s+(.+)/i,
		/need\s+(?:a\s+)?plugins?\s+(?:for|that|to)\s+(.+)/i,
		/want\s+(?:a\s+)?plugins?\s+(?:for|that|to)\s+(.+)/i,
		/plugins?\s+(?:for|that\s+can|to)\s+(.+)/i,
		/what\s+plugins?\s+(?:can|do|handle)\s+(.+)/i,
		/plugins?\s+(.+)/i,
	];

	for (const pattern of patterns) {
		const match = text.match(pattern);
		if (match?.[1]) {
			let query = match[1].trim();
			query = query.replace(/\?+$/, "");
			query = query.replace(/^(do|handle|manage|work\s+with)\s+/i, "");
			query = query.replace(/\s+/g, " ");

			if (query.length > 2) {
				return query;
			}
		}
	}

	// Extract technology/domain keywords as fallback
	const techKeywords = text.match(
		/\b(blockchain|ai|database|api|social|twitter|discord|telegram|solana|ethereum|trading|defi|nft|authentication|security|monitoring|analytics|file|image|video|audio|email|sms|payment|voice|tts|mcp|github|slack|whatsapp|signal)\b/gi,
	);

	if (techKeywords && techKeywords.length > 0) {
		return techKeywords.join(" ");
	}

	return null;
}

export const getPluginDetailsAction: Action = {
	name: "GET_PLUGIN_DETAILS",
	similes: [
		"tell me more about",
		"show details for",
		"plugin info",
		"plugin details",
	],
	description:
		"Get detailed information about a specific plugin including features, dependencies, and usage.",

	examples: [
		[
			{
				name: "{{user1}}",
				content: {
					text: "Tell me more about @elizaos/plugin-solana",
				},
			},
			{
				name: "{{agentName}}",
				content: {
					text: "**@elizaos/plugin-solana** Details:\n\nDescription: Comprehensive Solana blockchain integration\n\nTags: blockchain, solana, defi, transaction\n\nVersion: 2.0.0-alpha.3\nRepository: https://github.com/elizaos-plugins/plugin-solana",
				},
			},
		],
	],

	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: HandlerOptions,
	): Promise<boolean> => {
		const text = message.content?.text?.toLowerCase() ?? "";
		return hasPluginDetailsIntent(text);
	},

	handler: async (_runtime, message, _state, _options, callback) => {
		const text = message.content?.text || "";
		const pluginMatch = text.match(/@?([\w-]+\/plugin-[\w-]+|plugin-[\w-]+)/i);

		if (!pluginMatch) {
			if (callback) {
				await callback({
					text: 'Please specify which plugin you\'d like to know more about.\n\nExample: "Tell me more about @elizaos/plugin-solana"',
				});
			}
			return undefined;
		}

		let pluginName = pluginMatch[1];
		if (!pluginName.startsWith("@") && !pluginName.includes("/")) {
			pluginName = `@elizaos/${pluginName}`;
		}

		const details = await getPluginDetails(pluginName);

		if (!details) {
			if (callback) {
				await callback({
					text: `Plugin "${pluginName}" not found in the registry.\n\nTry searching for plugins first: "search for [functionality]"`,
				});
			}
			return undefined;
		}

		let responseText = `**${details.name}** Details:\n\n`;

		if (details.description) {
			responseText += `**Description:** ${details.description}\n\n`;
		}

		if (details.tags && details.tags.length > 0) {
			responseText += `**Tags:** ${details.tags.join(", ")}\n\n`;
		}

		if (details.latestVersion) {
			responseText += `**Version:** ${details.latestVersion}\n`;
		}
		if (details.runtimeVersion) {
			responseText += `**Runtime:** ${details.runtimeVersion}\n`;
		}
		if (details.repository) {
			responseText += `**Repository:** ${details.repository}\n`;
		}
		if (details.maintainer) {
			responseText += `**Maintainer:** ${details.maintainer}\n`;
		}

		responseText += `\n\nAsk for another plugin or say: "search for plugins for [use-case]".`;

		if (callback) {
			await callback({
				text: responseText,
			});
		}

		return undefined;
	},
};
