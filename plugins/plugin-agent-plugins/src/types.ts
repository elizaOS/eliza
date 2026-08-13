/**
 * Domain types for the Agent Plugins 1.0.0 package format and Eliza client.
 */

export const PLUGIN_SCHEMA_1_0_0 =
	"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

export const MCP_SCHEMA_1_0_0 =
	"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

export const CLOSED_MANIFEST_FIELDS = [
	"$schema",
	"name",
	"version",
	"description",
	"author",
	"homepage",
	"repository",
	"license",
	"keywords",
	"extensions",
] as const;

export type ClosedManifestField = (typeof CLOSED_MANIFEST_FIELDS)[number];

export interface AgentPluginAuthor {
	name?: string;
	email?: string;
	url?: string;
}

export interface AgentPluginManifest {
	$schema: typeof PLUGIN_SCHEMA_1_0_0 | string;
	name: string;
	version?: string;
	description?: string;
	author?: AgentPluginAuthor;
	homepage?: string;
	repository?: string;
	license?: string;
	keywords?: string[];
	extensions?: Record<string, Record<string, unknown>>;
}

export interface DiscoveredSkill {
	directoryName: string;
	skillDir: string;
	skillMdPath: string;
}

export type McpTransportType = "stdio" | "http" | "sse" | "streamable-http";

export interface MappedStdioMcpConfig {
	type: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

export interface MappedHttpMcpConfig {
	type: "http" | "sse" | "streamable-http";
	url: string;
}

export type MappedMcpServerConfig = MappedStdioMcpConfig | MappedHttpMcpConfig;

export interface ValidatedMcpServer {
	name: string;
	type: McpTransportType;
	mappedConfig: MappedMcpServerConfig;
}

export interface InvalidMcpServer {
	name: string;
	reason: string;
}

export interface LoadedMcpState {
	present: boolean;
	configValid: boolean;
	servers: ValidatedMcpServer[];
	invalidServers: InvalidMcpServer[];
	errors: string[];
}

export type PluginSource = "installed" | "path";

export interface LoadedAgentPlugin {
	root: string;
	manifest: AgentPluginManifest;
	skills: DiscoveredSkill[];
	skillsLocationInvalid: boolean;
	mcp: LoadedMcpState;
	warnings: string[];
	source: PluginSource;
}

export type LoadAgentPluginResult =
	| { ok: true; plugin: LoadedAgentPlugin }
	| { ok: false; root: string; errors: string[] };

export interface ManifestParseSuccess {
	ok: true;
	manifest: AgentPluginManifest;
	warnings: string[];
}

export interface ManifestParseFailure {
	ok: false;
	errors: string[];
}

export type ManifestParseResult = ManifestParseSuccess | ManifestParseFailure;

export const AGENT_PLUGINS_SERVICE_TYPE = "agent-plugins";

export const AGENT_SKILLS_SERVICE_TYPE = "AGENT_SKILLS_SERVICE";

export const MCP_SERVICE_TYPE = "mcp";
