/**
 * agent_plugins provider — compact list of loaded Agent Plugin packages.
 */

import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "@elizaos/core";
import type { AgentPluginsService } from "../services/agent-plugins";
import { AGENT_PLUGINS_SERVICE_TYPE } from "../types";

export const agentPluginsProvider: Provider = {
	name: "agent_plugins",
	description: "Loaded Agent Plugin packages (name, version, skills, MCP, warnings)",
	descriptionCompressed: "Loaded Agent Plugin packages.",
	contexts: ["settings", "agent_internal"],
	contextGate: { anyOf: ["settings", "agent_internal"] },
	cacheStable: false,
	cacheScope: "turn",
	dynamic: true,

	get: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state: State,
	): Promise<ProviderResult> => {
		const service = runtime.getService<AgentPluginsService>(
			AGENT_PLUGINS_SERVICE_TYPE,
		);
		if (!service) return { text: "" };

		const plugins = service.list();
		if (plugins.length === 0) {
			return { text: "" };
		}

		const lines = plugins.map((plugin) => {
			const version = plugin.manifest.version ?? "unversioned";
			const warningCount =
				plugin.warnings.length + plugin.mcp.invalidServers.length;
			const warningText =
				warningCount > 0 ? `; warnings=${warningCount}` : "";
			return `- ${plugin.manifest.name}@${version} skills=${plugin.skills.length} mcp=${plugin.mcp.servers.length}${warningText}`;
		});

		return {
			text: `## Agent Plugins\n${lines.join("\n")}`,
			data: {
				plugins: plugins.map((plugin) => ({
					name: plugin.manifest.name,
					version: plugin.manifest.version,
					skillCount: plugin.skills.length,
					mcpServerCount: plugin.mcp.servers.length,
					warnings: [
						...plugin.warnings,
						...plugin.mcp.invalidServers.map(
							(server) => `${server.name}: ${server.reason}`,
						),
					],
				})),
			},
		};
	},
};
