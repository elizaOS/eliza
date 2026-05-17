/**
 * Tool Policy Types
 *
 * Types and definitions for tool/action filtering and permissions in elizaOS.
 *
 * @module tools
 */

// Re-export from channel-config to avoid duplication
export type { ToolPolicyConfig, ToolProfileId } from "./channel-config";

import type { ToolPolicyConfig, ToolProfileId } from "./channel-config";

/**
 * Predefined tool groups for easier policy configuration.
 * Use "group:<name>" syntax in policy configs (e.g., "group:fs").
 */
export const TOOL_GROUPS: Record<string, string[]> = {
	// Memory tools.
	"group:memory": ["read_attachment"],
	// Web tools
	"group:web": ["web_search", "web_fetch"],
	// Basic workspace/file tools
	"group:fs": ["read", "read_file", "write", "edit", "apply_patch"],
	// Host/runtime execution tools
	"group:runtime": ["exec", "process"],
	// Session management tools
	"group:sessions": [
		"sessions_list",
		"sessions_history",
		"sessions_send",
		"sessions_spawn",
		"session_status",
	],
	// UI helpers
	"group:ui": ["browser", "canvas"],
	// Automation + infra
	"group:automation": ["cron", "gateway"],
	// Messaging surface
	"group:messaging": ["message"],
	// Nodes + device tools
	"group:nodes": ["nodes"],
	// All native tools (excludes provider plugins)
	"group:all": [
		"browser",
		"canvas",
		"nodes",
		"cron",
		"message",
		"gateway",
		"agents_list",
		"sessions_list",
		"sessions_history",
		"sessions_send",
		"sessions_spawn",
		"session_status",
		"read_attachment",
		"read_file",
		"web_search",
		"web_fetch",
		"image",
		"read",
		"write",
		"edit",
		"apply_patch",
		"exec",
		"process",
	],
};

/**
 * Predefined tool profiles with default allow/deny policies.
 */
export const TOOL_PROFILES: Record<ToolProfileId, ToolPolicyConfig> = {
	minimal: {
		allow: ["session_status"],
	},
	coding: {
		allow: [
			"group:fs",
			"group:runtime",
			"group:sessions",
			"group:memory",
			"image",
		],
	},
	messaging: {
		allow: [
			"group:messaging",
			"sessions_list",
			"sessions_history",
			"sessions_send",
			"session_status",
		],
	},
	full: {
		// No restrictions - all tools allowed
	},
};

/**
 * Plugin tool groups for dynamic tool resolution.
 */
export interface PluginToolGroups {
	/** All tool names from plugins */
	all: string[];
	/** Tool names organized by plugin ID */
	byPlugin: Map<string, string[]>;
}

/**
 * Result of allowlist resolution with diagnostics.
 */
export interface AllowlistResolution {
	/** The resolved policy after processing */
	policy: ToolPolicyConfig | undefined;
	/** Entries in the allowlist that weren't recognized */
	unknownAllowlist: string[];
	/** Whether the allowlist was stripped (contained only plugin tools) */
	strippedAllowlist: boolean;
}

/**
 * Tool policy evaluation options.
 */
export interface ToolPolicyEvaluationOptions {
	/** The character's tool profile */
	profile?: ToolProfileId;
	/** Character-level tool policy overrides */
	characterPolicy?: ToolPolicyConfig;
	/** Channel-specific tool policy overrides */
	channelPolicy?: ToolPolicyConfig;
	/** Provider-specific tool policy overrides */
	providerPolicy?: ToolPolicyConfig;
	/** Plugin tool groups for resolution */
	pluginGroups?: PluginToolGroups;
	/** Set of core tool names for validation */
	coreTools?: Set<string>;
}

/**
 * Tool policy evaluation result.
 */
export interface ToolPolicyResult {
	/** Whether the tool is allowed */
	allowed: boolean;
	/** Reason for the decision */
	reason: string;
	/** The effective policy after merging */
	effectivePolicy: ToolPolicyConfig;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Normalize a plugin-tool name for case-insensitive policy matching.
 *
 * IMPORTANT: this only normalizes plugin-tool names (e.g. `web_search`,
 * `read_file`) used by the tool-policy engine. Action names (e.g.
 * `MESSAGE`) are matched verbatim by the planner — the action name
 * shown in the system prompt's available-actions list is the exact string
 * the LLM must pass back as `actionName` in `call_action`. There is no
 * alias mapping for actions; the displayed name IS the invocation key.
 */
export function normalizeToolName(name: string): string {
	return name.trim().toLowerCase();
}

/**
 * Normalize a list of tool names.
 *
 * @param list - The list of tool names to normalize
 * @returns Normalized list with empty entries filtered out
 */
export function normalizeToolList(list?: string[]): string[] {
	if (!list) {
		return [];
	}
	return list.map(normalizeToolName).filter(Boolean);
}

/**
 * Expand tool groups in a list to their constituent tools.
 * Handles both group references (e.g., "group:fs") and individual tools.
 *
 * @param list - The list containing tool names and/or group references
 * @returns Expanded list with all groups resolved to individual tools
 */
export function expandToolGroups(list?: string[]): string[] {
	const normalized = normalizeToolList(list);
	const expanded: string[] = [];

	for (const value of normalized) {
		const group = TOOL_GROUPS[value];
		if (group) {
			expanded.push(...group);
			continue;
		}
		expanded.push(value);
	}

	return Array.from(new Set(expanded));
}

/**
 * Resolve a tool profile to its policy configuration.
 *
 * @param profile - The profile ID to resolve
 * @returns The policy configuration, or undefined if profile is invalid
 */
export function resolveToolProfilePolicy(
	profile?: string,
): ToolPolicyConfig | undefined {
	if (!profile) {
		return undefined;
	}
	const resolved = TOOL_PROFILES[profile as ToolProfileId];
	if (!resolved) {
		return undefined;
	}
	// Return undefined for 'full' profile (no restrictions)
	if (!resolved.allow && !resolved.deny) {
		return undefined;
	}
	return {
		allow: resolved.allow ? [...resolved.allow] : undefined,
		deny: resolved.deny ? [...resolved.deny] : undefined,
	};
}

/**
 * Collect all explicit allow entries from multiple policies.
 *
 * @param policies - Array of policies to collect from
 * @returns Combined allowlist entries
 */
export function collectExplicitAllowlist(
	policies: Array<ToolPolicyConfig | undefined>,
): string[] {
	const entries: string[] = [];

	for (const policy of policies) {
		if (!policy?.allow) {
			continue;
		}
		for (const value of policy.allow) {
			if (typeof value !== "string") {
				continue;
			}
			const trimmed = value.trim();
			if (trimmed) {
				entries.push(trimmed);
			}
		}
	}

	return entries;
}

/**
 * Build plugin tool groups from a list of tools with metadata.
 *
 * @param params - Tools and metadata accessor
 * @returns Plugin tool groups organized by plugin ID
 */
export function buildPluginToolGroups<T extends { name: string }>(params: {
	tools: T[];
	toolMeta: (tool: T) => { pluginId: string } | undefined;
}): PluginToolGroups {
	const all: string[] = [];
	const byPlugin = new Map<string, string[]>();

	for (const tool of params.tools) {
		const meta = params.toolMeta(tool);
		if (!meta) {
			continue;
		}
		const name = normalizeToolName(tool.name);
		all.push(name);
		const pluginId = meta.pluginId.toLowerCase();
		const list = byPlugin.get(pluginId) ?? [];
		list.push(name);
		byPlugin.set(pluginId, list);
	}

	return { all, byPlugin };
}

/**
 * Expand plugin group references in a list.
 *
 * @param list - The list containing potential plugin group references
 * @param groups - Plugin tool groups for resolution
 * @returns Expanded list with plugin groups resolved
 */
export function expandPluginGroups(
	list: string[] | undefined,
	groups: PluginToolGroups,
): string[] | undefined {
	if (!list || list.length === 0) {
		return list;
	}

	const expanded: string[] = [];
	for (const entry of list) {
		const normalized = normalizeToolName(entry);
		if (normalized === "group:plugins") {
			if (groups.all.length > 0) {
				expanded.push(...groups.all);
			} else {
				expanded.push(normalized);
			}
			continue;
		}
		const tools = groups.byPlugin.get(normalized);
		if (tools && tools.length > 0) {
			expanded.push(...tools);
			continue;
		}
		expanded.push(normalized);
	}

	return Array.from(new Set(expanded));
}

/**
 * Expand a policy with plugin group resolution.
 *
 * @param policy - The policy to expand
 * @param groups - Plugin tool groups for resolution
 * @returns Policy with plugin groups expanded
 */
export function expandPolicyWithPluginGroups(
	policy: ToolPolicyConfig | undefined,
	groups: PluginToolGroups,
): ToolPolicyConfig | undefined {
	if (!policy) {
		return undefined;
	}
	return {
		allow: expandPluginGroups(policy.allow, groups),
		deny: expandPluginGroups(policy.deny, groups),
	};
}

/**
 * Strip plugin-only allowlist to prevent accidentally disabling core tools.
 * When an allowlist contains only plugin tools, we remove it to avoid
 * inadvertently blocking core functionality.
 *
 * @param policy - The policy to check
 * @param groups - Plugin tool groups
 * @param coreTools - Set of core tool names
 * @returns Resolution result with diagnostic information
 */
export function stripPluginOnlyAllowlist(
	policy: ToolPolicyConfig | undefined,
	groups: PluginToolGroups,
	coreTools: Set<string>,
): AllowlistResolution {
	if (!policy?.allow || policy.allow.length === 0) {
		return { policy, unknownAllowlist: [], strippedAllowlist: false };
	}

	const normalized = normalizeToolList(policy.allow);
	if (normalized.length === 0) {
		return { policy, unknownAllowlist: [], strippedAllowlist: false };
	}

	const pluginIds = new Set(groups.byPlugin.keys());
	const pluginTools = new Set(groups.all);
	const unknownAllowlist: string[] = [];
	let hasCoreEntry = false;

	for (const entry of normalized) {
		if (entry === "*") {
			hasCoreEntry = true;
			continue;
		}
		const isPluginEntry =
			entry === "group:plugins" ||
			pluginIds.has(entry) ||
			pluginTools.has(entry);
		const expanded = expandToolGroups([entry]);
		const isCoreEntry = expanded.some((tool) => coreTools.has(tool));
		if (isCoreEntry) {
			hasCoreEntry = true;
		}
		if (!isCoreEntry && !isPluginEntry) {
			unknownAllowlist.push(entry);
		}
	}

	const strippedAllowlist = !hasCoreEntry;

	return {
		policy: strippedAllowlist ? { ...policy, allow: undefined } : policy,
		unknownAllowlist: Array.from(new Set(unknownAllowlist)),
		strippedAllowlist,
	};
}

/**
 * Merge multiple tool policies into a single effective policy.
 * Later policies take precedence for conflicts.
 *
 * @param policies - Policies to merge in order of precedence
 * @returns Merged policy
 */
export function mergeToolPolicies(
	...policies: Array<ToolPolicyConfig | undefined>
): ToolPolicyConfig {
	const result: ToolPolicyConfig = {};

	for (const policy of policies) {
		if (!policy) continue;

		if (policy.allow !== undefined) {
			// If a more specific policy has an allow list, it replaces (not merges)
			result.allow = [...(policy.allow || [])];
		}

		if (policy.deny !== undefined) {
			// Deny lists are additive - combine them
			result.deny = [...(result.deny || []), ...(policy.deny || [])];
		}
	}

	// Deduplicate
	if (result.allow) {
		result.allow = Array.from(new Set(result.allow));
	}
	if (result.deny) {
		result.deny = Array.from(new Set(result.deny));
	}

	return result;
}

/**
 * Check if a tool is allowed by a policy.
 *
 * @param toolName - The tool name to check
 * @param policy - The policy to evaluate against
 * @returns Whether the tool is allowed
 */
export function isToolAllowedByPolicy(
	toolName: string,
	policy: ToolPolicyConfig | undefined,
): boolean {
	const normalizedName = normalizeToolName(toolName);

	// No policy means all tools allowed
	if (!policy) {
		return true;
	}

	// Check deny list first (deny takes precedence)
	if (policy.deny && policy.deny.length > 0) {
		const expandedDeny = expandToolGroups(policy.deny);
		if (expandedDeny.includes(normalizedName)) {
			return false;
		}
	}

	// Check allow list
	if (policy.allow && policy.allow.length > 0) {
		const expandedAllow = expandToolGroups(policy.allow);
		// Wildcard allows everything not denied
		if (expandedAllow.includes("*")) {
			return true;
		}
		return expandedAllow.includes(normalizedName);
	}

	// No allow list means all tools allowed (if not denied)
	return true;
}
