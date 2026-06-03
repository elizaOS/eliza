/**
 * Browser Entry Point for Discord Plugin
 *
 * IMPORTANT: This file provides a browser-compatible export for the Discord plugin.
 * The Discord.js library requires Node.js APIs (WebSocket, Buffer, etc.) that are
 * not available in browser environments.
 *
 * LIMITATIONS:
 * - No direct Discord Gateway connection (WebSocket unavailable)
 * - No bot token authentication
 * - No event handling or message processing
 * - No slash command registration
 *
 * RECOMMENDED ALTERNATIVES:
 * 1. Server Proxy: Run the full Discord plugin on a Node.js server and communicate
 *    via API endpoints from your browser application.
 * 2. OAuth Flow: For user-facing apps, implement Discord OAuth2 in the browser
 *    and handle bot operations server-side.
 * 3. Webhooks: For simple message sending, Discord webhooks work from browsers
 *    (though they're one-way communication only).
 *
 * @module plugin-discord/browser
 */

import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";

const pluginName = "discord";

/**
 * Browser compatibility export for the Discord plugin.
 *
 * This export provides the same plugin interface but no Discord gateway
 * lifecycle. It prevents build errors when the package is bundled for browser
 * targets.
 */
export const discordPlugin: Plugin = {
	name: pluginName,
	description:
		"Discord plugin (browser compatibility export; use a server proxy)",
	async init(_config, _runtime: IAgentRuntime): Promise<void> {
		logger.warn(
			`[plugin-${pluginName}] Browser environment detected. Discord plugin requires Node.js. ` +
				`To use Discord features, run the plugin on a server and proxy requests from the browser.`,
		);
	},
};

export default discordPlugin;
