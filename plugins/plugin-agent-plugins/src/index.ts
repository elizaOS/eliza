/**
 * @elizaos/plugin-agent-plugins
 *
 * Eliza client for the Agent Plugins 1.0.0 package format.
 */

export { agentPluginAction } from "./actions/agent-plugin";
export { agentPluginsPlugin, default } from "./plugin";
export { agentPluginsProvider } from "./providers/agent-plugins";
export { AgentPluginsService } from "./services/agent-plugins";
export { parseManifest, parseManifestJson } from "./spec/manifest";
export { parseMcpConfig, parseMcpJsonText } from "./spec/mcp";
export { isValidPluginName } from "./spec/names";
export { loadAgentPlugin } from "./spec/package";
export {
	isInsideRoot,
	isPluginRelativePath,
	resolveContained,
} from "./spec/paths";
export { discoverSkills } from "./spec/skills";
export type {
	AgentPluginManifest,
	DiscoveredSkill,
	LoadAgentPluginResult,
	LoadedAgentPlugin,
	MappedMcpServerConfig,
} from "./types";
export {
	AGENT_PLUGINS_SERVICE_TYPE,
	MCP_SCHEMA_1_0_0,
	PLUGIN_SCHEMA_1_0_0,
} from "./types";
