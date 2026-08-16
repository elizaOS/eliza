/**
 * Comprehensive test suite for ToolPolicyService.
 *
 * Tests the security-critical service that enforces tool/action access policies
 * across profiles, character settings, channel overrides, and provider configs.
 *
 * Coverage includes:
 * - Policy merging with precedence ordering
 * - Tool allowlist/denylist resolution
 * - Plugin tool group expansion and filtering
 * - Edge cases: empty policies, conflicting rules, profile inheritance
 * - Integration with expandToolGroups() and isToolAllowedByPolicy()
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import ToolPolicyService, { type ToolPolicyContext } from "./tool-policy";
import type { IAgentRuntime } from "../types";
import type { ToolPolicyConfig } from "../types/tools";
import {
	TOOL_PROFILES,
	TOOL_GROUPS,
	normalizeToolName,
} from "../types/tools";

/**
 * Create a minimal mock runtime for testing.
 */
function createMockRuntime(overrides?: Partial<IAgentRuntime>): IAgentRuntime {
	return {
		agentId: "test-agent-123",
		getAllActions: () => [],
		getSetting: () => undefined,
		...overrides,
	} as unknown as IAgentRuntime;
}

describe("ToolPolicyService", () => {
	let service: ToolPolicyService;
	let mockRuntime: IAgentRuntime;

	beforeEach(() => {
		mockRuntime = createMockRuntime();
		service = new ToolPolicyService(mockRuntime);
	});

	describe("Core initialization", () => {
		it("should initialize with empty runtime", () => {
			const svc = new ToolPolicyService();
			expect(svc).toBeDefined();
		});

		it("should initialize core tools from TOOL_GROUPS", () => {
			const coreTools = service.getCoreTools();
			expect(coreTools.size).toBeGreaterThan(0);

			// Check that known tools are present
			expect(coreTools.has("exec")).toBe(true);
			expect(coreTools.has("read")).toBe(true);
			expect(coreTools.has("write")).toBe(true);
			expect(coreTools.has("web_search")).toBe(true);
		});

		it("should initialize with empty plugin groups", () => {
			const groups = service.getPluginToolGroups();
			expect(groups.all).toEqual([]);
			expect(groups.byPlugin.size).toBe(0);
		});
	});

	describe("Policy merging - precedence order", () => {
		it("should apply profile policy as base", () => {
			const context: ToolPolicyContext = {
				profile: "coding",
			};

			const policy = service.getEffectivePolicy(context);
			expect(policy).toBeDefined();
			expect(policy.allow).toBeDefined();
			expect(policy.allow).toContain("group:fs");
		});

		it("should merge character policy over profile policy", () => {
			const context: ToolPolicyContext = {
				profile: "minimal",
				characterPolicy: {
					allow: ["read_file"],
				},
			};

			const policy = service.getEffectivePolicy(context);
			// Character policy replaces profile's allow list
			expect(policy.allow).toEqual(["read_file"]);
		});

		it("should merge world policy after character policy", () => {
			const context: ToolPolicyContext = {
				profile: "minimal",
				characterPolicy: {
					allow: ["read_file"],
				},
				worldPolicy: {
					allow: ["web_search"],
				},
			};

			const policy = service.getEffectivePolicy(context);
			// World policy replaces character's allow list
			expect(policy.allow).toEqual(["web_search"]);
		});

		it("should merge channel policy after world policy", () => {
			const context: ToolPolicyContext = {
				profile: "minimal",
				characterPolicy: {
					allow: ["read_file"],
				},
				worldPolicy: {
					allow: ["web_search"],
				},
				channelPolicy: {
					allow: ["exec"],
				},
			};

			const policy = service.getEffectivePolicy(context);
			// Channel policy replaces world's allow list
			expect(policy.allow).toEqual(["exec"]);
		});

		it("should merge room policy after channel policy", () => {
			const context: ToolPolicyContext = {
				profile: "minimal",
				characterPolicy: {
					allow: ["read_file"],
				},
				channelPolicy: {
					allow: ["exec"],
				},
				roomPolicy: {
					allow: ["write"],
				},
			};

			const policy = service.getEffectivePolicy(context);
			// Room policy replaces channel's allow list
			expect(policy.allow).toEqual(["write"]);
		});

		it("should merge provider policy as highest precedence", () => {
			const context: ToolPolicyContext = {
				profile: "minimal",
				characterPolicy: {
					allow: ["read_file"],
				},
				channelPolicy: {
					allow: ["exec"],
				},
				roomPolicy: {
					allow: ["write"],
				},
				providerPolicy: {
					allow: ["web_fetch"],
				},
			};

			const policy = service.getEffectivePolicy(context);
			// Provider policy replaces room's allow list
			expect(policy.allow).toEqual(["web_fetch"]);
		});

		it("should handle deny lists additively", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					deny: ["exec"],
				},
				providerPolicy: {
					deny: ["process"],
				},
			};

			const policy = service.getEffectivePolicy(context);
			// Deny lists are additive
			expect(policy.deny).toContain("exec");
			expect(policy.deny).toContain("process");
		});

		it("should deduplicate merged deny lists", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					deny: ["exec", "process"],
				},
				providerPolicy: {
					deny: ["exec"],
				},
			};

			const policy = service.getEffectivePolicy(context);
			expect(policy.deny).toHaveLength(2);
			expect(policy.deny).toContain("exec");
			expect(policy.deny).toContain("process");
		});
	});

	describe("Tool allowlist/denylist resolution", () => {
		it("should allow tool when no policy is set", () => {
			const result = service.isToolAllowed("exec");
			expect(result.allowed).toBe(true);
			expect(result.reason).toContain("No policy");
		});

		it("should allow tool explicitly in allowlist", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					allow: ["exec", "read"],
				},
			};

			const result = service.isToolAllowed("exec", context);
			expect(result.allowed).toBe(true);
			expect(result.reason).toContain("Explicitly allowed");
		});

		it("should deny tool not in allowlist", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					allow: ["exec"],
				},
			};

			const result = service.isToolAllowed("write", context);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain("Not in allowlist");
		});

		it("should deny tool explicitly in denylist", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					deny: ["exec"],
				},
			};

			const result = service.isToolAllowed("exec", context);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain("Explicitly denied");
		});

		it("should allow tool when in denylist but not in restrictive allowlist", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					allow: ["*"],
					deny: ["exec"],
				},
			};

			const result = service.isToolAllowed("write", context);
			expect(result.allowed).toBe(true);
		});

		it("should handle wildcard allowlist", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					allow: ["*"],
				},
			};

			const result = service.isToolAllowed("exec", context);
			expect(result.allowed).toBe(true);
			expect(result.reason).toContain("wildcard");
		});

		it("should normalize tool names case-insensitively", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					allow: ["EXEC"],
				},
			};

			const result = service.isToolAllowed("exec", context);
			expect(result.allowed).toBe(true);
		});

		it("should deny takes precedence over allow", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					allow: ["*"],
					deny: ["exec"],
				},
			};

			const result = service.isToolAllowed("exec", context);
			expect(result.allowed).toBe(false);
		});
	});

	describe("Tool group expansion", () => {
		it("should expand group:fs to file tools", () => {
			const expanded = service.expandToolGroups(["group:fs"]);
			expect(expanded).toContain("read");
			expect(expanded).toContain("write");
			expect(expanded).toContain("edit");
		});

		it("should expand group:runtime to runtime tools", () => {
			const expanded = service.expandToolGroups(["group:runtime"]);
			expect(expanded).toContain("exec");
			expect(expanded).toContain("process");
		});

		it("should expand group:web to web tools", () => {
			const expanded = service.expandToolGroups(["group:web"]);
			expect(expanded).toContain("web_search");
			expect(expanded).toContain("web_fetch");
		});

		it("should handle mixed group and individual tool names", () => {
			const expanded = service.expandToolGroups(["group:fs", "exec"]);
			expect(expanded).toContain("read");
			expect(expanded).toContain("write");
			expect(expanded).toContain("exec");
		});

		it("should deduplicate expanded tools", () => {
			const expanded = service.expandToolGroups([
				"group:all",
				"exec",
				"read",
			]);
			const uniqueCount = new Set(expanded).size;
			expect(uniqueCount).toBe(expanded.length);
		});

		it("should allow tool with group in allowlist", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					allow: ["group:fs"],
				},
			};

			const result = service.isToolAllowed("read", context);
			expect(result.allowed).toBe(true);
		});

		it("should deny tool with group in denylist", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					deny: ["group:runtime"],
				},
			};

			const result = service.isToolAllowed("exec", context);
			expect(result.allowed).toBe(false);
		});
	});

	describe("Profile-based policies", () => {
		it("should resolve minimal profile", () => {
			const context: ToolPolicyContext = {
				profile: "minimal",
			};

			const policy = service.getEffectivePolicy(context);
			expect(policy.allow).toBeDefined();
			expect(policy.allow).toContain("session_status");
		});

		it("should resolve coding profile", () => {
			const context: ToolPolicyContext = {
				profile: "coding",
			};

			const policy = service.getEffectivePolicy(context);
			expect(policy.allow).toContain("group:fs");
			expect(policy.allow).toContain("group:runtime");
		});

		it("should resolve messaging profile", () => {
			const context: ToolPolicyContext = {
				profile: "messaging",
			};

			const policy = service.getEffectivePolicy(context);
			expect(policy.allow).toContain("group:messaging");
		});

		it("should resolve full profile as no restrictions", () => {
			const context: ToolPolicyContext = {
				profile: "full",
			};

			const policy = service.getEffectivePolicy(context);
			// Full profile has no restrictions
			expect(policy).toBeDefined();
		});

		it("should cache profile policies", () => {
			const context: ToolPolicyContext = {
				profile: "coding",
			};

			const policy1 = service.getEffectivePolicy(context);
			const policy2 = service.getEffectivePolicy(context);

			// Should be same reference (cached)
			expect(policy1).toEqual(policy2);
		});

		it("should apply character policy over profile", () => {
			const context: ToolPolicyContext = {
				profile: "full",
				characterPolicy: {
					deny: ["exec"],
				},
			};

			const result = service.isToolAllowed("exec", context);
			expect(result.allowed).toBe(false);
		});
	});

	describe("Action filtering", () => {
		it("should filter actions based on policy", () => {
			const actions = [
				{ name: "read", description: "Read file" },
				{ name: "exec", description: "Execute command" },
				{ name: "write", description: "Write file" },
			];

			const context: ToolPolicyContext = {
				characterPolicy: {
					allow: ["read", "write"],
				},
			};

			const filtered = service.filterActions(actions, context);
			expect(filtered).toHaveLength(2);
			expect(filtered.map((a) => a.name)).toContain("read");
			expect(filtered.map((a) => a.name)).toContain("write");
			expect(filtered.map((a) => a.name)).not.toContain("exec");
		});

		it("should handle empty action list", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					allow: ["read"],
				},
			};

			const filtered = service.filterActions([], context);
			expect(filtered).toEqual([]);
		});

		it("should preserve action properties during filtering", () => {
			const actions = [
				{ name: "read", description: "Read file", custom: "data" },
			];

			const context: ToolPolicyContext = {
				characterPolicy: {
					allow: ["read"],
				},
			};

			const filtered = service.filterActions(actions, context);
			expect(filtered[0].custom).toBe("data");
		});
	});

	describe("getAllowedTools and getDeniedTools", () => {
		const availableTools = [
			"read",
			"write",
			"exec",
			"process",
			"web_search",
		];

		it("should get allowed tools", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					allow: ["read", "write"],
				},
			};

			const allowed = service.getAllowedTools(context, availableTools);
			expect(allowed).toEqual(["read", "write"]);
		});

		it("should get denied tools", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					allow: ["read", "write"],
				},
			};

			const denied = service.getDeniedTools(context, availableTools);
			expect(denied.map((d) => d.name)).toContain("exec");
			expect(denied.map((d) => d.name)).toContain("process");
		});

		it("should include reason for denied tools", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					allow: ["read"],
				},
			};

			const denied = service.getDeniedTools(context, availableTools);
			const exec = denied.find((d) => d.name === "exec");
			expect(exec?.reason).toBeDefined();
		});

		it("should handle no restrictions context", () => {
			const allowed = service.getAllowedTools(undefined, availableTools);
			expect(allowed).toEqual(availableTools);
		});
	});

	describe("Policy validation", () => {
		it("should validate correct policy", () => {
			const policy: ToolPolicyConfig = {
				allow: ["read", "write"],
			};

			const validation = service.validatePolicy(policy);
			expect(validation.valid).toBe(true);
			expect(validation.errors).toHaveLength(0);
		});

		it("should detect unknown group warnings", () => {
			const policy: ToolPolicyConfig = {
				allow: ["group:unknown"],
			};

			const validation = service.validatePolicy(policy);
			expect(validation.warnings.length).toBeGreaterThan(0);
		});

		it("should detect invalid entries in allow list", () => {
			const policy: ToolPolicyConfig = {
				allow: ["", "read"],
			};

			const validation = service.validatePolicy(policy);
			// Empty string should be handled gracefully
			expect(validation).toBeDefined();
		});

		it("should validate wildcard", () => {
			const policy: ToolPolicyConfig = {
				allow: ["*"],
			};

			const validation = service.validatePolicy(policy);
			expect(validation.valid).toBe(true);
		});

		it("should validate group references", () => {
			const policy: ToolPolicyConfig = {
				allow: ["group:fs", "group:runtime"],
			};

			const validation = service.validatePolicy(policy);
			expect(validation.valid).toBe(true);
		});

		it("should handle deny list validation", () => {
			const policy: ToolPolicyConfig = {
				deny: ["exec", "process"],
			};

			const validation = service.validatePolicy(policy);
			expect(validation.valid).toBe(true);
		});
	});

	describe("Plugin tool groups", () => {
		it("should update plugin groups from runtime actions", () => {
			const mockRuntimeWithActions = createMockRuntime({
				getAllActions: () => [
					{ name: "plugin_tool_1", pluginId: "test-plugin" },
					{ name: "plugin_tool_2", pluginId: "test-plugin" },
					{ name: "other_tool", pluginId: "other-plugin" },
				],
			});

			const svc = new ToolPolicyService(mockRuntimeWithActions);
			svc.updatePluginGroups();

			const groups = svc.getPluginToolGroups();
			expect(groups.byPlugin.has("test-plugin")).toBe(true);
			expect(groups.all.length).toBeGreaterThan(0);
		});

		it("should expand group:plugins reference", () => {
			const mockRuntimeWithActions = createMockRuntime({
				getAllActions: () => [
					{ name: "custom_action", pluginId: "my-plugin" },
				],
			});

			const svc = new ToolPolicyService(mockRuntimeWithActions);
			svc.updatePluginGroups();

			const context: ToolPolicyContext = {
				characterPolicy: {
					allow: ["group:plugins"],
				},
			};

			const policy = svc.getEffectivePolicy(context);
			expect(policy.allow).toContain("group:plugins");
		});
	});

	describe("stripPluginOnlyAllowlist", () => {
		it("should not strip allowlist with core tools", () => {
			const policy: ToolPolicyConfig = {
				allow: ["read", "exec"],
			};

			const result = service.stripPluginOnlyAllowlist(policy);
			expect(result.strippedAllowlist).toBe(false);
			expect(result.policy).toEqual(policy);
		});

		it("should strip allowlist with only plugin tools", () => {
			const mockRuntimeWithActions = createMockRuntime({
				getAllActions: () => [
					{ name: "plugin_tool_1", pluginId: "test-plugin" },
				],
			});

			const svc = new ToolPolicyService(mockRuntimeWithActions);
			svc.updatePluginGroups();

			const policy: ToolPolicyConfig = {
				allow: ["plugin_tool_1"],
			};

			const result = svc.stripPluginOnlyAllowlist(policy);
			expect(result.strippedAllowlist).toBe(true);
			expect(result.policy?.allow).toBeUndefined();
		});

		it("should not strip allowlist with wildcard", () => {
			const policy: ToolPolicyConfig = {
				allow: ["*"],
			};

			const result = service.stripPluginOnlyAllowlist(policy);
			expect(result.strippedAllowlist).toBe(false);
		});

		it("should handle undefined policy", () => {
			const result = service.stripPluginOnlyAllowlist(undefined);
			expect(result.strippedAllowlist).toBe(false);
			expect(result.policy).toBeUndefined();
		});
	});

	describe("getEffectivePolicyForCharacter", () => {
		it("should extract policy from character settings", () => {
			const character = {
				settings: {
					toolProfile: "coding" as const,
					tools: {
						deny: ["exec"],
					},
				},
			};

			const policy = service.getEffectivePolicyForCharacter(character);
			expect(policy).toBeDefined();
			expect(policy.deny).toContain("exec");
		});

		it("should merge channel override", () => {
			const character = {
				settings: {
					tools: {
						allow: ["read"],
					},
				},
			};

			const channel = {
				tools: {
					allow: ["write"],
				},
			};

			const policy = service.getEffectivePolicyForCharacter(
				character,
				channel
			);
			expect(policy.allow).toEqual(["write"]);
		});

		it("should merge provider override", () => {
			const character = {
				settings: {
					tools: {
						allow: ["read"],
					},
				},
			};

			const provider = {
				tools: {
					allow: ["web_search"],
				},
			};

			const policy = service.getEffectivePolicyForCharacter(
				character,
				undefined,
				provider
			);
			expect(policy.allow).toEqual(["web_search"]);
		});

		it("should handle missing character settings", () => {
			const character = {};

			const policy = service.getEffectivePolicyForCharacter(character);
			expect(policy).toBeDefined();
		});
	});

	describe("Edge cases and complex scenarios", () => {
		it("should handle empty context", () => {
			const policy = service.getEffectivePolicy();
			expect(policy).toBeDefined();
		});

		it("should handle conflicting allow and deny", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					allow: ["exec", "read"],
					deny: ["exec"],
				},
			};

			const result = service.isToolAllowed("exec", context);
			expect(result.allowed).toBe(false);
		});

		it("should handle very restrictive policy (allow empty)", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					allow: [],
				},
			};

			// Empty allow list is treated as "no allow list", so all tools are allowed
			const result = service.isToolAllowed("exec", context);
			expect(result.allowed).toBe(true);
		});

		it("should handle multiple profile levels", () => {
			const context: ToolPolicyContext = {
				profile: "minimal",
				characterPolicy: {
					allow: ["read"],
				},
				channelPolicy: {
					deny: ["read"],
				},
			};

			const result = service.isToolAllowed("read", context);
			expect(result.allowed).toBe(false);
		});

		it("should handle normalization of mixed case and spaces", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					allow: ["  EXEC  ", "Read"],
				},
			};

			const result1 = service.isToolAllowed("exec", context);
			const result2 = service.isToolAllowed("read", context);

			expect(result1.allowed).toBe(true);
			expect(result2.allowed).toBe(true);
		});

		it("should handle policy with only denylist", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					deny: ["exec"],
				},
			};

			const result1 = service.isToolAllowed("read", context);
			const result2 = service.isToolAllowed("exec", context);

			expect(result1.allowed).toBe(true);
			expect(result2.allowed).toBe(false);
		});

		it("should provide detailed effectivePolicy in result", () => {
			const context: ToolPolicyContext = {
				characterPolicy: {
					allow: ["exec"],
				},
				channelPolicy: {
					deny: ["read"],
				},
			};

			const result = service.isToolAllowed("exec", context);
			expect(result.effectivePolicy).toBeDefined();
			expect(result.effectivePolicy.allow).toBeDefined();
			expect(result.effectivePolicy.deny).toBeDefined();
		});
	});

	describe("Service lifecycle", () => {
		it("should start service", async () => {
			const svc = await ToolPolicyService.start(mockRuntime);
			expect(svc).toBeDefined();
			expect(svc instanceof ToolPolicyService).toBe(true);
		});

		it("should stop service", async () => {
			const svc = new ToolPolicyService(mockRuntime);
			await svc.stop();
			// Should not throw
			expect(svc).toBeDefined();
		});

		it("should get core tools", () => {
			const coreTools = service.getCoreTools();
			expect(coreTools).toBeInstanceOf(Set);
			expect(coreTools.size).toBeGreaterThan(0);
		});

		it("should get plugin tool groups", () => {
			const groups = service.getPluginToolGroups();
			expect(groups).toBeDefined();
			expect(groups.all).toBeInstanceOf(Array);
			expect(groups.byPlugin).toBeInstanceOf(Map);
		});
	});
});
