/**
 * Agent Plugins client for elizaOS.
 *
 * Discovers and validates Agent Plugins 1.0.0 packages (plugin.json +
 * skills/ + mcp.json) and optionally bridges them into
 * @elizaos/plugin-agent-skills and @elizaos/plugin-mcp when those services
 * are present.
 */

import type { Action, Plugin, Provider } from "@elizaos/core";
import { promoteSubactionsToActions } from "@elizaos/core";
import { agentPluginAction } from "./actions/agent-plugin";
import { agentPluginsProvider } from "./providers/agent-plugins";
import { AgentPluginsService } from "./services/agent-plugins";

type PluginServiceClass = NonNullable<Plugin["services"]>[number];

const ALL_SERVICES: PluginServiceClass[] = [
	AgentPluginsService as PluginServiceClass,
];

const ALL_ACTIONS: Action[] = [
	...promoteSubactionsToActions(agentPluginAction),
];

const ALL_PROVIDERS: Provider[] = [agentPluginsProvider];

export const agentPluginsPlugin: Plugin = {
	name: "agent-plugins",
	description:
		"Agent Plugins 1.0.0 client — load plugin.json packages and bridge skills/MCP",

	services: ALL_SERVICES,
	actions: ALL_ACTIONS,
	providers: ALL_PROVIDERS,

	autoEnable: {
		shouldEnable: (_env, config) => {
			const f = (config.features as Record<string, unknown> | undefined)
				?.agentPlugins;
			return (
				f === true ||
				(typeof f === "object" &&
					f !== null &&
					(f as { enabled?: unknown }).enabled !== false)
			);
		},
	},

	routes: [],
};

export default agentPluginsPlugin;
