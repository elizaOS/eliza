/**
 * Parse and validate Agent Plugins 1.0.0 mcp.json (§7.2).
 *
 * Invalid mcp.json disables MCP for that plugin only. An invalid individual
 * server is skipped; other servers and component types still load.
 */

import { join } from "node:path";
import {
	MCP_SCHEMA_1_0_0,
	PLUGIN_SCHEMA_1_0_0,
	type InvalidMcpServer,
	type LoadedMcpState,
	type MappedMcpServerConfig,
	type McpTransportType,
	type ValidatedMcpServer,
} from "../types";
import { isPluginRelativePath, resolveContained } from "./paths";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SUPPORTED_TRANSPORTS = new Set<string>([
	"stdio",
	"http",
	"sse",
	"streamable-http",
]);

export function expandPlaceholders(
	value: string,
	pluginRoot: string,
	pluginData: string,
): string {
	return value
		.replaceAll("${PLUGIN_ROOT}", pluginRoot)
		.replaceAll("${PLUGIN_DATA}", pluginData);
}

function emptyMcp(overrides: Partial<LoadedMcpState> = {}): LoadedMcpState {
	return {
		present: false,
		configValid: true,
		servers: [],
		invalidServers: [],
		errors: [],
		...overrides,
	};
}

export async function parseMcpConfig(
	raw: unknown,
	pluginRoot: string,
	pluginSchema?: string,
	pluginDataDir?: string,
): Promise<LoadedMcpState> {
	const pluginData = pluginDataDir ?? join(pluginRoot, ".data");

	if (!isRecord(raw)) {
		return emptyMcp({
			present: true,
			configValid: false,
			errors: ["mcp.json must be a JSON object"],
		});
	}

	const topLevelKeys = Object.keys(raw);
	const allowed = new Set(["$schema", "mcpServers"]);
	const extra = topLevelKeys.filter((key) => !allowed.has(key));
	if (extra.length > 0) {
		return emptyMcp({
			present: true,
			configValid: false,
			errors: [`mcp.json has unknown top-level fields: ${extra.join(", ")}`],
		});
	}

	if (typeof raw.$schema !== "string") {
		return emptyMcp({
			present: true,
			configValid: false,
			errors: ["mcp.json $schema is required"],
		});
	}
	if (raw.$schema !== MCP_SCHEMA_1_0_0) {
		return emptyMcp({
			present: true,
			configValid: false,
			errors: [`mcp.json $schema is unsupported: ${raw.$schema}`],
		});
	}

	if (pluginSchema && pluginSchema !== PLUGIN_SCHEMA_1_0_0) {
		return emptyMcp({
			present: true,
			configValid: false,
			errors: ["mcp.json version does not match plugin.json"],
		});
	}

	if (!isRecord(raw.mcpServers)) {
		return emptyMcp({
			present: true,
			configValid: false,
			errors: ["mcpServers must be an object"],
		});
	}

	const servers: ValidatedMcpServer[] = [];
	const invalidServers: InvalidMcpServer[] = [];

	for (const [name, entry] of Object.entries(raw.mcpServers)) {
		const parsed = await parseServerEntry(name, entry, pluginRoot, pluginData);
		if (parsed.ok) {
			servers.push(parsed.server);
		} else {
			invalidServers.push({ name, reason: parsed.reason });
		}
	}

	return {
		present: true,
		configValid: true,
		servers,
		invalidServers,
		errors: [],
	};
}

async function parseServerEntry(
	name: string,
	entry: unknown,
	pluginRoot: string,
	pluginData: string,
): Promise<{ ok: true; server: ValidatedMcpServer } | { ok: false; reason: string }> {
	if (!isRecord(entry)) {
		return { ok: false, reason: "server entry must be an object" };
	}
	const type = entry.type;
	if (typeof type !== "string") {
		return { ok: false, reason: "type is required" };
	}
	if (!SUPPORTED_TRANSPORTS.has(type)) {
		return { ok: false, reason: `unsupported transport "${type}"` };
	}

	if (type === "stdio") {
		return parseStdioServer(name, entry, pluginRoot, pluginData);
	}
	return parseHttpServer(name, type as Exclude<McpTransportType, "stdio">, entry);
}

async function parseStdioServer(
	name: string,
	entry: Record<string, unknown>,
	pluginRoot: string,
	pluginData: string,
): Promise<{ ok: true; server: ValidatedMcpServer } | { ok: false; reason: string }> {
	const allowed = new Set(["type", "command", "args", "env", "cwd"]);
	for (const key of Object.keys(entry)) {
		if (!allowed.has(key)) {
			return { ok: false, reason: `unknown field "${key}"` };
		}
	}

	if (typeof entry.command !== "string" || entry.command.length === 0) {
		return { ok: false, reason: "command must be a non-empty string" };
	}

	let command = entry.command;
	if (command.includes("${")) {
		return { ok: false, reason: "command must not contain placeholder expansion" };
	}
	if (command.includes("/") || command.includes("\\")) {
		if (!isPluginRelativePath(command)) {
			return {
				ok: false,
				reason: "plugin-relative command must start with ./ and stay inside the plugin root",
			};
		}
		const resolved = await resolveContained(pluginRoot, command);
		if (!resolved.ok) {
			return { ok: false, reason: resolved.reason };
		}
		command = resolved.path;
	}

	let args: string[] | undefined;
	if (entry.args !== undefined) {
		if (
			!Array.isArray(entry.args) ||
			!entry.args.every((item) => typeof item === "string")
		) {
			return { ok: false, reason: "args must be an array of strings" };
		}
		args = entry.args.map((item) =>
			expandPlaceholders(item, pluginRoot, pluginData),
		);
	}

	let env: Record<string, string> | undefined;
	if (entry.env !== undefined) {
		if (!isRecord(entry.env) || !Object.values(entry.env).every((v) => typeof v === "string")) {
			return { ok: false, reason: "env must be an object of strings" };
		}
		env = {};
		for (const [key, value] of Object.entries(entry.env)) {
			env[key] = expandPlaceholders(value as string, pluginRoot, pluginData);
		}
	}

	let cwd: string | undefined;
	if (entry.cwd === undefined) {
		cwd = pluginRoot;
	} else if (typeof entry.cwd !== "string") {
		return { ok: false, reason: "cwd must be a string" };
	} else {
		const expanded = expandPlaceholders(entry.cwd, pluginRoot, pluginData);
		if (entry.cwd === "${PLUGIN_DATA}" || entry.cwd.startsWith("${PLUGIN_DATA}/")) {
			const resolved = await resolveContained(pluginData, expanded);
			if (!resolved.ok) {
				return { ok: false, reason: `cwd escapes PLUGIN_DATA: ${entry.cwd}` };
			}
			cwd = resolved.path;
		} else if (
			entry.cwd === "${PLUGIN_ROOT}" ||
			entry.cwd.startsWith("${PLUGIN_ROOT}/") ||
			isPluginRelativePath(entry.cwd)
		) {
			const relativeTarget = isPluginRelativePath(entry.cwd)
				? entry.cwd
				: expanded;
			const resolved = await resolveContained(pluginRoot, relativeTarget);
			if (!resolved.ok) {
				return { ok: false, reason: resolved.reason };
			}
			cwd = resolved.path;
		} else {
			return {
				ok: false,
				reason: "cwd must be ./…, ${PLUGIN_ROOT}, or ${PLUGIN_DATA}",
			};
		}
	}

	const mappedConfig: MappedMcpServerConfig = {
		type: "stdio",
		command,
		...(args ? { args } : {}),
		...(env ? { env } : {}),
		...(cwd ? { cwd } : {}),
	};

	return {
		ok: true,
		server: { name, type: "stdio", mappedConfig },
	};
}

async function parseHttpServer(
	name: string,
	type: Exclude<McpTransportType, "stdio">,
	entry: Record<string, unknown>,
): Promise<{ ok: true; server: ValidatedMcpServer } | { ok: false; reason: string }> {
	const allowed = new Set(["type", "url", "headers"]);
	for (const key of Object.keys(entry)) {
		if (!allowed.has(key)) {
			return { ok: false, reason: `unknown field "${key}"` };
		}
	}
	if (typeof entry.url !== "string" || entry.url.length === 0) {
		return { ok: false, reason: "url must be a non-empty string" };
	}
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(entry.url);
	} catch {
		return { ok: false, reason: "url must be an absolute HTTP(S) URL" };
	}
	if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
		return { ok: false, reason: "url must be http or https" };
	}
	if (parsedUrl.username || parsedUrl.password || parsedUrl.hash) {
		return { ok: false, reason: "url must not contain userinfo or a fragment" };
	}

	const mappedConfig: MappedMcpServerConfig = { type, url: entry.url };
	return { ok: true, server: { name, type, mappedConfig } };
}

export function parseMcpJsonText(
	text: string,
	pluginRoot: string,
	pluginSchema?: string,
	pluginDataDir?: string,
): Promise<LoadedMcpState> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return Promise.resolve(
			emptyMcp({
				present: true,
				configValid: false,
				errors: ["mcp.json is not valid JSON"],
			}),
		);
	}
	return parseMcpConfig(parsed, pluginRoot, pluginSchema, pluginDataDir);
}
