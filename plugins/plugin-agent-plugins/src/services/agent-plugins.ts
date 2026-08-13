/**
 * AgentPluginsService — discover, validate, install, and unload Agent Plugin packages.
 */

import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
	type IAgentRuntime,
	Service,
	logger,
} from "@elizaos/core";
import { loadAgentPlugin } from "../spec/package";
import { isDirectory } from "../spec/paths";
import {
	AGENT_PLUGINS_SERVICE_TYPE,
	AGENT_SKILLS_SERVICE_TYPE,
	MCP_SERVICE_TYPE,
	type LoadedAgentPlugin,
	type MappedMcpServerConfig,
} from "../types";

export const DEFAULT_AGENT_PLUGINS_DIR = "./agent-plugins";

interface AgentSkillsBridge {
	addPluginSkillsDir?(dir: string): Promise<void>;
}

interface McpBridge {
	connectServer?(name: string, config: MappedMcpServerConfig): Promise<void>;
	addServer?(name: string, config: MappedMcpServerConfig): Promise<void>;
}

function parseBool(value: unknown, fallback: boolean): boolean {
	if (value === undefined || value === null || value === "") return fallback;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const lowered = value.trim().toLowerCase();
		if (["1", "true", "yes", "on"].includes(lowered)) return true;
		if (["0", "false", "no", "off"].includes(lowered)) return false;
	}
	return fallback;
}

function parseCsv(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === "string");
	}
	if (typeof value !== "string" || value.trim() === "") return [];
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function looksLikeUrl(value: string): boolean {
	return /^(https?:)?\/\//i.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value);
}

export class AgentPluginsService extends Service {
	static serviceType = AGENT_PLUGINS_SERVICE_TYPE;
	capabilityDescription =
		"Agent Plugins 1.0.0 client — load plugin.json packages and bridge skills/MCP";

	private plugins = new Map<string, LoadedAgentPlugin>();
	private pluginsDir = DEFAULT_AGENT_PLUGINS_DIR;
	private extraPaths: string[] = [];
	private enableMcp = false;
	private bridgedSkillDirs = new Set<string>();

	static async start(runtime: IAgentRuntime): Promise<AgentPluginsService> {
		const service = new AgentPluginsService(runtime);
		await service.initialize();
		return service;
	}

	static async stop(_runtime: IAgentRuntime): Promise<void> {}

	async stop(): Promise<void> {
		this.plugins.clear();
		this.bridgedSkillDirs.clear();
	}

	async initialize(): Promise<void> {
		const dirSetting = this.runtime.getSetting("AGENT_PLUGINS_DIR");
		this.pluginsDir =
			typeof dirSetting === "string" && dirSetting.trim()
				? dirSetting
				: DEFAULT_AGENT_PLUGINS_DIR;
		this.extraPaths = parseCsv(this.runtime.getSetting("AGENT_PLUGIN_PATHS"));
		this.enableMcp = parseBool(
			this.runtime.getSetting("AGENT_PLUGINS_ENABLE_MCP"),
			false,
		);
		await this.reload();
	}

	async reload(): Promise<void> {
		this.plugins.clear();
		const installedDir = resolve(this.pluginsDir);
		if (await isDirectory(installedDir)) {
			const entries = await readdir(installedDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
				const root = join(installedDir, entry.name);
				await this.loadIntoRegistry(root, "installed");
			}
		}

		for (const extra of this.extraPaths) {
			const root = isAbsolute(extra) ? extra : resolve(extra);
			await this.loadIntoRegistry(root, "path");
		}

		await this.bridgeLoadedPlugins();
	}

	list(): LoadedAgentPlugin[] {
		return [...this.plugins.values()].sort((a, b) =>
			a.manifest.name.localeCompare(b.manifest.name),
		);
	}

	get(name: string): LoadedAgentPlugin | undefined {
		return this.plugins.get(name);
	}

	async installFromDirectory(
		srcPath: string,
		options: { force?: boolean } = {},
	): Promise<LoadedAgentPlugin> {
		if (looksLikeUrl(srcPath)) {
			throw new Error(
				"Remote URLs are not supported. Install from a local directory path.",
			);
		}

		const source = isAbsolute(srcPath) ? srcPath : resolve(srcPath);
		const loaded = await loadAgentPlugin(source, "path");
		if (!loaded.ok) {
			throw new Error(
				`Invalid Agent Plugin at ${source}: ${loaded.errors.join("; ")}`,
			);
		}

		const name = loaded.plugin.manifest.name;
		const destDir = resolve(this.pluginsDir);
		await mkdir(destDir, { recursive: true });
		const dest = join(destDir, name);

		if (await isDirectory(dest)) {
			if (!options.force) {
				throw new Error(
					`Plugin "${name}" is already installed. Pass force to replace it.`,
				);
			}
			await rm(dest, { recursive: true, force: true });
		}

		await cp(source, dest, { recursive: true, dereference: false });

		const installed = await loadAgentPlugin(dest, "installed");
		if (!installed.ok) {
			await rm(dest, { recursive: true, force: true });
			throw new Error(
				`Installed copy of "${name}" failed validation: ${installed.errors.join("; ")}`,
			);
		}

		this.plugins.set(name, installed.plugin);
		await this.bridgePlugin(installed.plugin);
		return installed.plugin;
	}

	async uninstall(name: string): Promise<void> {
		const existing = this.plugins.get(name);
		if (!existing) {
			throw new Error(`Plugin "${name}" is not loaded`);
		}
		if (existing.source !== "installed") {
			throw new Error(
				`Plugin "${name}" was loaded from AGENT_PLUGIN_PATHS and will not be deleted`,
			);
		}

		const dest = resolve(this.pluginsDir, name);
		if (await isDirectory(dest)) {
			await rm(dest, { recursive: true, force: true });
		}
		this.plugins.delete(name);
	}

	private async loadIntoRegistry(
		root: string,
		source: LoadedAgentPlugin["source"],
	): Promise<void> {
		const loaded = await loadAgentPlugin(root, source);
		if (!loaded.ok) {
			this.log().warn(
				`[agent-plugins] skipped ${root}: ${loaded.errors.join("; ")}`,
			);
			return;
		}
		const name = loaded.plugin.manifest.name;
		const prior = this.plugins.get(name);
		if (prior && prior.source === "installed" && source === "path") {
			this.log().warn(
				`[agent-plugins] extra path ${root} ignored; "${name}" already installed`,
			);
			return;
		}
		this.plugins.set(name, loaded.plugin);
		for (const warning of loaded.plugin.warnings) {
			this.log().warn(`[agent-plugins] ${name}: ${warning}`);
		}
		for (const invalid of loaded.plugin.mcp.invalidServers) {
			this.log().warn(
				`[agent-plugins] ${name} mcp "${invalid.name}": ${invalid.reason}`,
			);
		}
	}

	private async bridgeLoadedPlugins(): Promise<void> {
		for (const plugin of this.plugins.values()) {
			await this.bridgePlugin(plugin);
		}
	}

	private async bridgePlugin(plugin: LoadedAgentPlugin): Promise<void> {
		await this.bridgeSkills(plugin);
		await this.bridgeMcp(plugin);
	}

	private async bridgeSkills(plugin: LoadedAgentPlugin): Promise<void> {
		if (plugin.skills.length === 0) return;
		const skills = this.runtime.getService(
			AGENT_SKILLS_SERVICE_TYPE,
		) as AgentSkillsBridge | undefined;
		if (!skills || typeof skills.addPluginSkillsDir !== "function") return;

		const skillsDir = join(plugin.root, "skills");
		if (this.bridgedSkillDirs.has(skillsDir)) return;
		try {
			await skills.addPluginSkillsDir(skillsDir);
			this.bridgedSkillDirs.add(skillsDir);
		} catch (error) {
			this.log().warn(
				`[agent-plugins] failed to register skills for ${plugin.manifest.name}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	private async bridgeMcp(plugin: LoadedAgentPlugin): Promise<void> {
		if (!this.enableMcp) return;
		if (plugin.mcp.servers.length === 0) return;

		const mcp = this.runtime.getService(MCP_SERVICE_TYPE) as McpBridge | null;
		if (!mcp) return;

		const connect =
			typeof mcp.connectServer === "function"
				? mcp.connectServer.bind(mcp)
				: typeof mcp.addServer === "function"
					? mcp.addServer.bind(mcp)
					: null;
		if (!connect) {
			this.log().info(
				`[agent-plugins] plugin-mcp is present but has no public connect API; listing servers only`,
			);
			return;
		}

		for (const server of plugin.mcp.servers) {
			const namespaced = `${plugin.manifest.name}:${server.name}`;
			try {
				await connect(namespaced, server.mappedConfig);
			} catch (error) {
				this.log().warn(
					`[agent-plugins] MCP connect failed for ${namespaced}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
	}

	private log() {
		return this.runtime.logger ?? logger;
	}
}
