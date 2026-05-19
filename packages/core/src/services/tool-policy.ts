/**
 * ToolPolicyService
 *
 * Service for managing tool/action access policies in elizaOS.
 * Provides tool filtering based on profiles, character settings,
 * channel-specific overrides, and provider configurations.
 *
 * @example
 * ```typescript
 * const policyService = runtime.getService(ServiceType.TOOL_POLICY) as ToolPolicyService;
 *
 * // Check if a tool is allowed
 * const result = policyService.isToolAllowed('exec', {
 *   profile: 'coding',
 *   channelPolicy: { deny: ['group:runtime'] }
 * });
 *
 * if (!result.allowed) {
 *   console.log(`Tool denied: ${result.reason}`);
 * }
 *
 * // Get effective policy for a context
 * const policy = policyService.getEffectivePolicy({
 *   profile: 'messaging',
 *   characterPolicy: character.settings?.tools
 * });
 * ```
 */

import { logger } from "../logger.ts";
import type { IAgentRuntime } from "../types/index.ts";
import { Service, ServiceType } from "../types/service.ts";
import type {
	AllowlistResolution,
	PluginToolGroups,
	ToolPolicyConfig,
	ToolPolicyResult,
	ToolProfileId,
} from "../types/tools.ts";
import {
	buildPluginToolGroups,
	expandPolicyWithPluginGroups,
	expandToolGroups,
	isToolAllowedByPolicy,
	mergeToolPolicies,
	normalizeToolName,
	resolveToolProfilePolicy,
	stripPluginOnlyAllowlist,
	TOOL_GROUPS,
} from "../types/tools.ts";

/**
 * Context for tool policy evaluation.
 */
export interface ToolPolicyContext {
	/** The character's tool profile (minimal, coding, messaging, full) */
	profile?: ToolProfileId;
	/** Character-level tool policy */
	characterPolicy?: ToolPolicyConfig;
	/** Channel-specific tool policy */
	channelPolicy?: ToolPolicyConfig;
	/** Provider-specific tool policy */
	providerPolicy?: ToolPolicyConfig;
	/** World/server-level policy */
	worldPolicy?: ToolPolicyConfig;
	/** Room-level policy */
	roomPolicy?: ToolPolicyConfig;
}

/**
 * ToolPolicyService provides tool/action access management.
 */
export class ToolPolicyService extends Service {
	static serviceType: string = ServiceType.TOOL_POLICY;
	capabilityDescription = "Manages tool access policies and filtering";

	/** Cached plugin tool groups */
	private pluginGroups: PluginToolGroups = { all: [], byPlugin: new Map() };

	/** Set of core tool names */
	private coreTools: Set<string> = new Set();

	/** Cache for profile policies */
	private profilePolicyCache = new Map<string, ToolPolicyConfig | undefined>();

	constructor(runtime?: IAgentRuntime) {
		super(runtime);
		this.initializeCoreTools();
	}

	/**
	 * Initialize the set of core tools from TOOL_GROUPS.
	 */
	private initializeCoreTools(): void {
		this.coreTools = new Set<string>();
		for (const tools of Object.values(TOOL_GROUPS)) {
			for (const tool of tools) {
				this.coreTools.add(tool);
			}
		}
	}

	/**
	 * Start the ToolPolicyService.
	 */
	static async start(runtime: IAgentRuntime): Promise<Service> {
		const service = new ToolPolicyService(runtime);

		// Build plugin tool groups from runtime actions
		service.updatePluginGroups();

		logger.info(
			{
				src: "service:tool_policy",
				agentId: runtime.agentId,
				coreToolCount: service.coreTools.size,
			},
			"ToolPolicyService started",
		);

		return service;
	}

	/**
	 * Stop the ToolPolicyService.
	 */
	async stop(): Promise<void> {
		this.profilePolicyCache.clear();
		logger.debug({ src: "service:tool_policy" }, "ToolPolicyService stopped");
	}

	/**
	 * Update plugin tool groups from runtime actions.
	 * Call this when plugins are added/removed.
	 */
	updatePluginGroups(): void {
		if (!this.runtime) {
			return;
		}

		// Get actions from runtime
		const actions = this.runtime.getAllActions();

		this.pluginGroups = buildPluginToolGroups({
			tools: actions,
			toolMeta: (action) => {
				// Actions may have plugin metadata
				const meta = action as { pluginId?: string; plugin?: string };
				const pluginId = meta.pluginId || meta.plugin;
				if (!pluginId) {
					return undefined;
				}
				return { pluginId };
			},
		});

		logger.debug(
			{
				src: "service:tool_policy",
				pluginCount: this.pluginGroups.byPlugin.size,
				toolCount: this.pluginGroups.all.length,
			},
			"Updated plugin tool groups",
		);
	}

	/**
	 * Expand tool groups to individual tool names.
	 *
	 * @param groups - List of tool names and/or group references
	 * @returns Expanded list of individual tool names
	 */
	expandToolGroups(groups: string[]): string[] {
		return expandToolGroups(groups);
	}

	/**
	 * Check if a tool is allowed by the given policy context.
	 *
	 * @param toolName - The tool name to check
	 * @param context - The policy context
	 * @returns Result with allowed status and reason
	 */
	isToolAllowed(
		toolName: string,
		context?: ToolPolicyContext,
	): ToolPolicyResult {
		const normalizedName = normalizeToolName(toolName);
		const effectivePolicy = this.getEffectivePolicy(context);

		// Expand the policy with plugin groups for accurate checking
		const expandedPolicy = expandPolicyWithPluginGroups(
			effectivePolicy,
			this.pluginGroups,
		);

		const allowed = isToolAllowedByPolicy(normalizedName, expandedPolicy);

		let reason: string;
		if (allowed) {
			if (!expandedPolicy || (!expandedPolicy.allow && !expandedPolicy.deny)) {
				reason = "No policy restrictions";
			} else if (expandedPolicy.allow) {
				const expandedAllow = expandToolGroups(expandedPolicy.allow);
				if (expandedAllow.includes("*")) {
					reason = "Allowed by wildcard";
				} else if (expandedAllow.includes(normalizedName)) {
					reason = "Explicitly allowed";
				} else {
					reason = "Allowed (no restrictions)";
				}
			} else {
				reason = "Allowed (not denied)";
			}
		} else {
			if (expandedPolicy?.deny) {
				const expandedDeny = expandToolGroups(expandedPolicy.deny);
				if (expandedDeny.includes(normalizedName)) {
					reason = "Explicitly denied";
				} else {
					reason = "Not in allowlist";
				}
			} else {
				reason = "Not in allowlist";
			}
		}

		return {
			allowed,
			reason,
			effectivePolicy,
		};
	}

	/**
	 * Get the effective policy by merging all policy sources.
	 * Order of precedence (later overrides earlier):
	 * 1. Profile base policy
	 * 2. Character-level policy
	 * 3. World/server-level policy
	 * 4. Channel policy
	 * 5. Room policy
	 * 6. Provider policy
	 *
	 * @param context - The policy context
	 * @returns Merged effective policy
	 */
	getEffectivePolicy(context?: ToolPolicyContext): ToolPolicyConfig {
		if (!context) {
			return {};
		}

		// Get profile policy (cached)
		let profilePolicy: ToolPolicyConfig | undefined;
		if (context.profile) {
			if (!this.profilePolicyCache.has(context.profile)) {
				this.profilePolicyCache.set(
					context.profile,
					resolveToolProfilePolicy(context.profile),
				);
			}
			profilePolicy = this.profilePolicyCache.get(context.profile);
		}

		// Merge policies in order of precedence
		return mergeToolPolicies(
			profilePolicy,
			context.characterPolicy,
			context.worldPolicy,
			context.channelPolicy,
			context.roomPolicy,
			context.providerPolicy,
		);
	}

	/**
	 * Get the effective policy for a character, optionally with channel/provider overrides.
	 * This is a convenience method that extracts policy from character settings.
	 *
	 * @param character - The character configuration
	 * @param channel - Optional channel override config
	 * @param provider - Optional provider override config
	 * @returns Effective policy
	 */
	getEffectivePolicyForCharacter(
		character: {
			settings?: {
				tools?: ToolPolicyConfig;
				toolProfile?: ToolProfileId;
			};
		},
		channel?: { tools?: ToolPolicyConfig },
		provider?: { tools?: ToolPolicyConfig },
	): ToolPolicyConfig {
		return this.getEffectivePolicy({
			profile: character.settings?.toolProfile,
			characterPolicy: character.settings?.tools,
			channelPolicy: channel?.tools,
			providerPolicy: provider?.tools,
		});
	}

	/**
	 * Filter a list of actions/tools based on policy.
	 *
	 * @param actions - Actions to filter
	 * @param context - Policy context
	 * @returns Filtered actions that are allowed
	 */
	filterActions<T extends { name: string }>(
		actions: T[],
		context?: ToolPolicyContext,
	): T[] {
		return actions.filter((action) => {
			const result = this.isToolAllowed(action.name, context);
			return result.allowed;
		});
	}

	/**
	 * Get a list of all allowed tool names for a context.
	 *
	 * @param context - Policy context
	 * @param availableTools - List of available tool names to check
	 * @returns List of allowed tool names
	 */
	getAllowedTools(
		context: ToolPolicyContext | undefined,
		availableTools: string[],
	): string[] {
		return availableTools.filter((tool) => {
			const result = this.isToolAllowed(tool, context);
			return result.allowed;
		});
	}

	/**
	 * Get a list of denied tool names for a context.
	 *
	 * @param context - Policy context
	 * @param availableTools - List of available tool names to check
	 * @returns List of denied tool names with reasons
	 */
	getDeniedTools(
		context: ToolPolicyContext | undefined,
		availableTools: string[],
	): Array<{ name: string; reason: string }> {
		const denied: Array<{ name: string; reason: string }> = [];

		for (const tool of availableTools) {
			const result = this.isToolAllowed(tool, context);
			if (!result.allowed) {
				denied.push({ name: tool, reason: result.reason });
			}
		}

		return denied;
	}

	/**
	 * Strip plugin-only allowlist from a policy.
	 * Prevents accidentally blocking core tools when policy only specifies plugin tools.
	 *
	 * @param policy - The policy to check
	 * @returns Resolution result with diagnostic info
	 */
	stripPluginOnlyAllowlist(
		policy: ToolPolicyConfig | undefined,
	): AllowlistResolution {
		return stripPluginOnlyAllowlist(policy, this.pluginGroups, this.coreTools);
	}

	/**
	 * Validate a policy configuration.
	 * Checks for invalid tool names, unknown groups, etc.
	 *
	 * @param policy - The policy to validate
	 * @returns Validation result
	 */
	validatePolicy(policy: ToolPolicyConfig): {
		valid: boolean;
		warnings: string[];
		errors: string[];
	} {
		const warnings: string[] = [];
		const errors: string[] = [];

		const checkList = (list: string[] | undefined, listName: string): void => {
			if (!list) return;

			for (const entry of list) {
				if (!entry || typeof entry !== "string") {
					errors.push(`${listName} contains invalid entry: ${String(entry)}`);
					continue;
				}

				const normalized = normalizeToolName(entry);

				// Check if it's a known group
				if (normalized.startsWith("group:")) {
					if (!TOOL_GROUPS[normalized] && normalized !== "group:plugins") {
						warnings.push(`${listName} contains unknown group: ${normalized}`);
					}
					continue;
				}

				// Check if it's a wildcard
				if (normalized === "*") {
					continue;
				}

				// Check if it's a known core tool
				if (!this.coreTools.has(normalized)) {
					// Might be a plugin tool
					if (!this.pluginGroups.all.includes(normalized)) {
						warnings.push(
							`${listName} contains unknown tool: ${normalized} (may be a plugin tool)`,
						);
					}
				}
			}
		};

		checkList(policy.allow, "allow");
		checkList(policy.deny, "deny");

		return {
			valid: errors.length === 0,
			warnings,
			errors,
		};
	}

	/**
	 * Get core tools set (for external use).
	 */
	getCoreTools(): Set<string> {
		return new Set(this.coreTools);
	}

	/**
	 * Get plugin tool groups (for external use).
	 */
	getPluginToolGroups(): PluginToolGroups {
		return {
			all: [...this.pluginGroups.all],
			byPlugin: new Map(this.pluginGroups.byPlugin),
		};
	}
}

export default ToolPolicyService;
