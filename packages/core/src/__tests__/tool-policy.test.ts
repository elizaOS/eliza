/**
 * Tool Policy Tests
 *
 * Tests for tool policy functionality including expandToolGroups(),
 * isToolAllowedByPolicy(), mergeToolPolicies(), and ToolPolicyService.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	type ToolPolicyContext,
	ToolPolicyService,
} from "../services/tool-policy.ts";
import {
	buildPluginToolGroups,
	collectExplicitAllowlist,
	expandPluginGroups,
	expandToolGroups,
	isToolAllowedByPolicy,
	mergeToolPolicies,
	normalizeToolList,
	normalizeToolName,
	type PluginToolGroups,
	resolveToolProfilePolicy,
	stripPluginOnlyAllowlist,
	TOOL_GROUPS,
	type ToolPolicyConfig,
} from "../types/tools.ts";

// ============================================================================
// normalizeToolName Tests
// ============================================================================

describe("normalizeToolName()", () => {
	it("should lowercase tool names", () => {
		expect(normalizeToolName("Read")).toBe("read");
		expect(normalizeToolName("WRITE")).toBe("write");
		expect(normalizeToolName("Exec")).toBe("exec");
	});

	it("should trim whitespace", () => {
		expect(normalizeToolName("  read  ")).toBe("read");
		expect(normalizeToolName("\twrite\n")).toBe("write");
	});

	it("should resolve aliases", () => {
		expect(normalizeToolName("bash")).toBe("exec");
		expect(normalizeToolName("BASH")).toBe("exec");
		expect(normalizeToolName("apply-patch")).toBe("apply_patch");
	});

	it("should handle unknown names unchanged", () => {
		expect(normalizeToolName("custom_tool")).toBe("custom_tool");
		expect(normalizeToolName("my-tool")).toBe("my-tool");
	});
});

describe("normalizeToolList()", () => {
	it("should normalize all tools in list", () => {
		const result = normalizeToolList(["Read", "WRITE", "bash"]);
		expect(result).toEqual(["read", "write", "exec"]);
	});

	it("should filter empty strings", () => {
		const result = normalizeToolList(["read", "", "write", "  "]);
		expect(result).toEqual(["read", "write"]);
	});

	it("should handle undefined", () => {
		expect(normalizeToolList(undefined)).toEqual([]);
	});

	it("should handle empty array", () => {
		expect(normalizeToolList([])).toEqual([]);
	});
});

// ============================================================================
// expandToolGroups Tests
// ============================================================================

describe("expandToolGroups()", () => {
	it("should expand group:fs to filesystem tools", () => {
		const expanded = expandToolGroups(["group:fs"]);
		expect(expanded).toContain("read");
		expect(expanded).toContain("read_file");
		expect(expanded).toContain("write");
		expect(expanded).toContain("edit");
		expect(expanded).toContain("apply_patch");
	});

	it("should expand group:memory to memory tools", () => {
		const expanded = expandToolGroups(["group:memory"]);
		expect(expanded).toContain("scratchpad_add");
		expect(expanded).toContain("scratchpad_search");
		expect(expanded).toContain("scratchpad_read");
		expect(expanded).toContain("scratchpad_replace");
		expect(expanded).toContain("scratchpad_delete");
		expect(expanded).toContain("read_attachment");
		expect(expanded).not.toContain("remove_from_scratchpad");
		expect(expanded).not.toContain("add_to_scratchpad");
	});

	it("should expand group:web to web tools", () => {
		const expanded = expandToolGroups(["group:web"]);
		expect(expanded).toContain("web_search");
		expect(expanded).toContain("web_fetch");
	});

	it("should expand group:runtime to execution tools", () => {
		const expanded = expandToolGroups(["group:runtime"]);
		expect(expanded).toContain("exec");
		expect(expanded).toContain("process");
	});

	it("should expand group:sessions to session tools", () => {
		const expanded = expandToolGroups(["group:sessions"]);
		expect(expanded).toContain("sessions_list");
		expect(expanded).toContain("sessions_history");
		expect(expanded).toContain("sessions_send");
		expect(expanded).toContain("sessions_spawn");
		expect(expanded).toContain("session_status");
	});

	it("should expand group:ui to UI tools", () => {
		const expanded = expandToolGroups(["group:ui"]);
		expect(expanded).toContain("browser");
		expect(expanded).toContain("canvas");
	});

	it("should expand group:automation to automation tools", () => {
		const expanded = expandToolGroups(["group:automation"]);
		expect(expanded).toContain("cron");
		expect(expanded).toContain("gateway");
	});

	it("should expand group:messaging to messaging tools", () => {
		const expanded = expandToolGroups(["group:messaging"]);
		expect(expanded).toContain("message");
	});

	it("should expand group:nodes to node tools", () => {
		const expanded = expandToolGroups(["group:nodes"]);
		expect(expanded).toContain("nodes");
	});

	it("should expand group:all to all native tools", () => {
		const expanded = expandToolGroups(["group:all"]);
		// Verify key tools are included
		expect(expanded).toContain("read");
		expect(expanded).toContain("write");
		expect(expanded).toContain("exec");
		expect(expanded).toContain("scratchpad_add");
		expect(expanded).toContain("scratchpad_search");
		expect(expanded).toContain("scratchpad_delete");
		expect(expanded).toContain("web_search");
		expect(expanded).toContain("browser");
		expect(expanded).toContain("sessions_list");
		expect(expanded.length).toBeGreaterThan(15);
	});

	it("should pass through non-group names", () => {
		const expanded = expandToolGroups(["read", "write", "custom_tool"]);
		expect(expanded).toEqual(["read", "write", "custom_tool"]);
	});

	it("should combine groups and individual tools", () => {
		const expanded = expandToolGroups(["group:fs", "custom_tool"]);
		expect(expanded).toContain("read");
		expect(expanded).toContain("write");
		expect(expanded).toContain("custom_tool");
	});

	it("should deduplicate results", () => {
		const expanded = expandToolGroups(["read", "group:fs", "read"]);
		const readCount = expanded.filter((t) => t === "read").length;
		expect(readCount).toBe(1);
	});

	it("should handle undefined", () => {
		expect(expandToolGroups(undefined)).toEqual([]);
	});

	it("should handle empty array", () => {
		expect(expandToolGroups([])).toEqual([]);
	});

	it("should normalize before expanding", () => {
		const expanded = expandToolGroups(["GROUP:FS"]);
		expect(expanded).toContain("read");
	});

	it("should handle unknown groups as regular names", () => {
		const expanded = expandToolGroups(["group:unknown"]);
		expect(expanded).toEqual(["group:unknown"]);
	});
});

// ============================================================================
// resolveToolProfilePolicy Tests
// ============================================================================

describe("resolveToolProfilePolicy()", () => {
	it("should resolve minimal profile", () => {
		const policy = resolveToolProfilePolicy("minimal");
		expect(policy?.allow).toContain("session_status");
		expect(policy?.allow).toHaveLength(1);
	});

	it("should resolve coding profile", () => {
		const policy = resolveToolProfilePolicy("coding");
		expect(policy?.allow).toContain("group:fs");
		expect(policy?.allow).toContain("group:runtime");
		expect(policy?.allow).toContain("group:sessions");
		expect(policy?.allow).toContain("group:memory");
		expect(policy?.allow).toContain("image");
	});

	it("should resolve messaging profile", () => {
		const policy = resolveToolProfilePolicy("messaging");
		expect(policy?.allow).toContain("group:messaging");
		expect(policy?.allow).toContain("sessions_list");
		expect(policy?.allow).toContain("sessions_history");
		expect(policy?.allow).toContain("sessions_send");
		expect(policy?.allow).toContain("session_status");
	});

	it("should return undefined for full profile (no restrictions)", () => {
		const policy = resolveToolProfilePolicy("full");
		expect(policy).toBeUndefined();
	});

	it("should return undefined for invalid profile", () => {
		expect(resolveToolProfilePolicy("invalid")).toBeUndefined();
		expect(resolveToolProfilePolicy("unknown")).toBeUndefined();
	});

	it("should return undefined for undefined input", () => {
		expect(resolveToolProfilePolicy(undefined)).toBeUndefined();
	});

	it("should return copy not reference", () => {
		const policy1 = resolveToolProfilePolicy("minimal");
		const policy2 = resolveToolProfilePolicy("minimal");
		expect(policy1).not.toBe(policy2);
		expect(policy1?.allow).not.toBe(policy2?.allow);
	});
});

// ============================================================================
// mergeToolPolicies Tests
// ============================================================================

describe("mergeToolPolicies()", () => {
	it("should return empty policy for no inputs", () => {
		const result = mergeToolPolicies();
		expect(result).toEqual({});
	});

	it("should return empty policy for undefined inputs", () => {
		const result = mergeToolPolicies(undefined, undefined);
		expect(result).toEqual({});
	});

	it("should return policy unchanged if only one input", () => {
		const policy: ToolPolicyConfig = { allow: ["read", "write"] };
		const result = mergeToolPolicies(policy);
		expect(result.allow).toEqual(["read", "write"]);
	});

	it("should replace allow list with later policy", () => {
		const policy1: ToolPolicyConfig = { allow: ["read"] };
		const policy2: ToolPolicyConfig = { allow: ["write"] };

		const result = mergeToolPolicies(policy1, policy2);
		expect(result.allow).toEqual(["write"]);
	});

	it("should combine deny lists (additive)", () => {
		const policy1: ToolPolicyConfig = { deny: ["exec"] };
		const policy2: ToolPolicyConfig = { deny: ["write"] };

		const result = mergeToolPolicies(policy1, policy2);
		expect(result.deny).toContain("exec");
		expect(result.deny).toContain("write");
	});

	it("should deduplicate deny lists", () => {
		const policy1: ToolPolicyConfig = { deny: ["exec", "write"] };
		const policy2: ToolPolicyConfig = { deny: ["exec", "read"] };

		const result = mergeToolPolicies(policy1, policy2);
		const execCount = result.deny?.filter((t) => t === "exec").length ?? 0;
		expect(execCount).toBe(1);
	});

	it("should preserve deny from earlier policy when later has allow", () => {
		const policy1: ToolPolicyConfig = { deny: ["exec"] };
		const policy2: ToolPolicyConfig = { allow: ["read", "write"] };

		const result = mergeToolPolicies(policy1, policy2);
		expect(result.deny).toContain("exec");
		expect(result.allow).toEqual(["read", "write"]);
	});

	it("should merge multiple policies in order", () => {
		const profile: ToolPolicyConfig = { allow: ["group:fs"] };
		const character: ToolPolicyConfig = { deny: ["exec"] };
		const channel: ToolPolicyConfig = {
			allow: ["read", "write"],
			deny: ["process"],
		};

		const result = mergeToolPolicies(profile, character, channel);
		expect(result.allow).toEqual(["read", "write"]);
		expect(result.deny).toContain("exec");
		expect(result.deny).toContain("process");
	});

	it("should handle empty arrays", () => {
		const policy1: ToolPolicyConfig = { allow: [] };
		const policy2: ToolPolicyConfig = { deny: [] };

		const result = mergeToolPolicies(policy1, policy2);
		expect(result.allow).toEqual([]);
		expect(result.deny).toEqual([]);
	});
});

// ============================================================================
// isToolAllowedByPolicy Tests
// ============================================================================

describe("isToolAllowedByPolicy()", () => {
	describe("with no policy", () => {
		it("should allow any tool when policy is undefined", () => {
			expect(isToolAllowedByPolicy("read", undefined)).toBe(true);
			expect(isToolAllowedByPolicy("exec", undefined)).toBe(true);
			expect(isToolAllowedByPolicy("custom_tool", undefined)).toBe(true);
		});

		it("should allow any tool when policy is empty", () => {
			expect(isToolAllowedByPolicy("read", {})).toBe(true);
			expect(isToolAllowedByPolicy("exec", {})).toBe(true);
		});
	});

	describe("with allow list only", () => {
		it("should allow tools in the allow list", () => {
			const policy: ToolPolicyConfig = { allow: ["read", "write"] };
			expect(isToolAllowedByPolicy("read", policy)).toBe(true);
			expect(isToolAllowedByPolicy("write", policy)).toBe(true);
		});

		it("should deny tools not in the allow list", () => {
			const policy: ToolPolicyConfig = { allow: ["read", "write"] };
			expect(isToolAllowedByPolicy("exec", policy)).toBe(false);
			expect(isToolAllowedByPolicy("custom_tool", policy)).toBe(false);
		});

		it("should expand groups in allow list", () => {
			const policy: ToolPolicyConfig = { allow: ["group:fs"] };
			expect(isToolAllowedByPolicy("read", policy)).toBe(true);
			expect(isToolAllowedByPolicy("write", policy)).toBe(true);
			expect(isToolAllowedByPolicy("edit", policy)).toBe(true);
			expect(isToolAllowedByPolicy("exec", policy)).toBe(false);
		});

		it("should handle wildcard in allow list", () => {
			const policy: ToolPolicyConfig = { allow: ["*"] };
			expect(isToolAllowedByPolicy("read", policy)).toBe(true);
			expect(isToolAllowedByPolicy("exec", policy)).toBe(true);
			expect(isToolAllowedByPolicy("any_tool", policy)).toBe(true);
		});

		it("should allow with empty allow list (no restrictions)", () => {
			const policy: ToolPolicyConfig = { allow: [] };
			// Empty allow list is treated as "no allow restriction" => all tools allowed if not denied
			expect(isToolAllowedByPolicy("read", policy)).toBe(true);
		});
	});

	describe("with deny list only", () => {
		it("should deny tools in the deny list", () => {
			const policy: ToolPolicyConfig = { deny: ["exec", "process"] };
			expect(isToolAllowedByPolicy("exec", policy)).toBe(false);
			expect(isToolAllowedByPolicy("process", policy)).toBe(false);
		});

		it("should allow tools not in the deny list", () => {
			const policy: ToolPolicyConfig = { deny: ["exec", "process"] };
			expect(isToolAllowedByPolicy("read", policy)).toBe(true);
			expect(isToolAllowedByPolicy("write", policy)).toBe(true);
		});

		it("should expand groups in deny list", () => {
			const policy: ToolPolicyConfig = { deny: ["group:runtime"] };
			expect(isToolAllowedByPolicy("exec", policy)).toBe(false);
			expect(isToolAllowedByPolicy("process", policy)).toBe(false);
			expect(isToolAllowedByPolicy("read", policy)).toBe(true);
		});
	});

	describe("with both allow and deny lists", () => {
		it("should give deny precedence over allow", () => {
			const policy: ToolPolicyConfig = {
				allow: ["read", "write", "exec"],
				deny: ["exec"],
			};
			expect(isToolAllowedByPolicy("read", policy)).toBe(true);
			expect(isToolAllowedByPolicy("write", policy)).toBe(true);
			expect(isToolAllowedByPolicy("exec", policy)).toBe(false);
		});

		it("should deny from deny list even with wildcard allow", () => {
			const policy: ToolPolicyConfig = {
				allow: ["*"],
				deny: ["exec"],
			};
			expect(isToolAllowedByPolicy("read", policy)).toBe(true);
			expect(isToolAllowedByPolicy("exec", policy)).toBe(false);
		});

		it("should deny if not in allow list even if not in deny list", () => {
			const policy: ToolPolicyConfig = {
				allow: ["read"],
				deny: ["exec"],
			};
			expect(isToolAllowedByPolicy("write", policy)).toBe(false);
		});
	});

	describe("with tool name normalization", () => {
		it("should normalize tool names before checking", () => {
			const policy: ToolPolicyConfig = { allow: ["read", "exec"] };
			expect(isToolAllowedByPolicy("READ", policy)).toBe(true);
			expect(isToolAllowedByPolicy("Exec", policy)).toBe(true);
		});

		it("should resolve aliases before checking", () => {
			const policy: ToolPolicyConfig = { allow: ["exec"] };
			expect(isToolAllowedByPolicy("bash", policy)).toBe(true);

			const policy2: ToolPolicyConfig = { deny: ["exec"] };
			expect(isToolAllowedByPolicy("bash", policy2)).toBe(false);
		});
	});
});

// ============================================================================
// stripPluginOnlyAllowlist Tests
// ============================================================================

describe("stripPluginOnlyAllowlist()", () => {
	const mockPluginGroups: PluginToolGroups = {
		all: ["plugin_tool_a", "plugin_tool_b"],
		byPlugin: new Map([
			["plugin-a", ["plugin_tool_a"]],
			["plugin-b", ["plugin_tool_b"]],
		]),
	};

	const coreTools = new Set(TOOL_GROUPS["group:all"]);

	it("should not strip when policy has core tools", () => {
		const policy: ToolPolicyConfig = { allow: ["read", "plugin_tool_a"] };
		const result = stripPluginOnlyAllowlist(
			policy,
			mockPluginGroups,
			coreTools,
		);

		expect(result.strippedAllowlist).toBe(false);
		expect(result.policy?.allow).toEqual(["read", "plugin_tool_a"]);
	});

	it("should not strip when policy has core group", () => {
		const policy: ToolPolicyConfig = { allow: ["group:fs", "plugin_tool_a"] };
		const result = stripPluginOnlyAllowlist(
			policy,
			mockPluginGroups,
			coreTools,
		);

		expect(result.strippedAllowlist).toBe(false);
	});

	it("should strip when policy has only plugin tools", () => {
		const policy: ToolPolicyConfig = {
			allow: ["plugin_tool_a", "plugin_tool_b"],
		};
		const result = stripPluginOnlyAllowlist(
			policy,
			mockPluginGroups,
			coreTools,
		);

		expect(result.strippedAllowlist).toBe(true);
		expect(result.policy?.allow).toBeUndefined();
	});

	it("should strip when policy has only plugin group references", () => {
		const policy: ToolPolicyConfig = { allow: ["plugin-a", "plugin-b"] };
		const result = stripPluginOnlyAllowlist(
			policy,
			mockPluginGroups,
			coreTools,
		);

		expect(result.strippedAllowlist).toBe(true);
	});

	it("should strip when policy has only group:plugins", () => {
		const policy: ToolPolicyConfig = { allow: ["group:plugins"] };
		const result = stripPluginOnlyAllowlist(
			policy,
			mockPluginGroups,
			coreTools,
		);

		expect(result.strippedAllowlist).toBe(true);
	});

	it("should not strip when policy has wildcard", () => {
		const policy: ToolPolicyConfig = { allow: ["*"] };
		const result = stripPluginOnlyAllowlist(
			policy,
			mockPluginGroups,
			coreTools,
		);

		expect(result.strippedAllowlist).toBe(false);
	});

	it("should track unknown allowlist entries", () => {
		const policy: ToolPolicyConfig = { allow: ["unknown_tool", "read"] };
		const result = stripPluginOnlyAllowlist(
			policy,
			mockPluginGroups,
			coreTools,
		);

		expect(result.unknownAllowlist).toContain("unknown_tool");
		expect(result.strippedAllowlist).toBe(false);
	});

	it("should handle undefined policy", () => {
		const result = stripPluginOnlyAllowlist(
			undefined,
			mockPluginGroups,
			coreTools,
		);

		expect(result.strippedAllowlist).toBe(false);
		expect(result.policy).toBeUndefined();
	});

	it("should handle empty allowlist", () => {
		const policy: ToolPolicyConfig = { allow: [] };
		const result = stripPluginOnlyAllowlist(
			policy,
			mockPluginGroups,
			coreTools,
		);

		expect(result.strippedAllowlist).toBe(false);
	});

	it("should preserve deny list when stripping allow", () => {
		const policy: ToolPolicyConfig = {
			allow: ["plugin_tool_a"],
			deny: ["exec"],
		};
		const result = stripPluginOnlyAllowlist(
			policy,
			mockPluginGroups,
			coreTools,
		);

		expect(result.strippedAllowlist).toBe(true);
		expect(result.policy?.deny).toEqual(["exec"]);
	});
});

// ============================================================================
// buildPluginToolGroups Tests
// ============================================================================

describe("buildPluginToolGroups()", () => {
	it("should build groups from tools with plugin metadata", () => {
		const tools = [
			{ name: "tool_a", pluginId: "plugin-x" },
			{ name: "tool_b", pluginId: "plugin-x" },
			{ name: "tool_c", pluginId: "plugin-y" },
		];

		const groups = buildPluginToolGroups({
			tools,
			toolMeta: (tool) => ({ pluginId: tool.pluginId }),
		});

		expect(groups.all).toContain("tool_a");
		expect(groups.all).toContain("tool_b");
		expect(groups.all).toContain("tool_c");
		expect(groups.byPlugin.get("plugin-x")).toEqual(["tool_a", "tool_b"]);
		expect(groups.byPlugin.get("plugin-y")).toEqual(["tool_c"]);
	});

	it("should skip tools without plugin metadata", () => {
		const tools = [
			{ name: "core_tool" },
			{ name: "plugin_tool", pluginId: "my-plugin" },
		];

		const groups = buildPluginToolGroups({
			tools,
			toolMeta: (tool: { name: string; pluginId?: string }) =>
				tool.pluginId ? { pluginId: tool.pluginId } : undefined,
		});

		expect(groups.all).not.toContain("core_tool");
		expect(groups.all).toContain("plugin_tool");
	});

	it("should normalize tool names", () => {
		const tools = [{ name: "Tool_Name", pluginId: "plugin" }];

		const groups = buildPluginToolGroups({
			tools,
			toolMeta: (tool) => ({ pluginId: tool.pluginId }),
		});

		expect(groups.all).toContain("tool_name");
	});

	it("should lowercase plugin IDs", () => {
		const tools = [{ name: "tool", pluginId: "My-Plugin" }];

		const groups = buildPluginToolGroups({
			tools,
			toolMeta: (tool) => ({ pluginId: tool.pluginId }),
		});

		expect(groups.byPlugin.has("my-plugin")).toBe(true);
	});

	it("should handle empty tools array", () => {
		const groups = buildPluginToolGroups({
			tools: [],
			toolMeta: () => undefined,
		});

		expect(groups.all).toEqual([]);
		expect(groups.byPlugin.size).toBe(0);
	});
});

// ============================================================================
// expandPluginGroups Tests
// ============================================================================

describe("expandPluginGroups()", () => {
	const mockGroups: PluginToolGroups = {
		all: ["tool_a", "tool_b", "tool_c"],
		byPlugin: new Map([
			["plugin-x", ["tool_a", "tool_b"]],
			["plugin-y", ["tool_c"]],
		]),
	};

	it("should expand group:plugins to all plugin tools", () => {
		const result = expandPluginGroups(["group:plugins"], mockGroups);
		expect(result).toContain("tool_a");
		expect(result).toContain("tool_b");
		expect(result).toContain("tool_c");
	});

	it("should expand plugin ID to its tools", () => {
		const result = expandPluginGroups(["plugin-x"], mockGroups);
		expect(result).toContain("tool_a");
		expect(result).toContain("tool_b");
		expect(result).not.toContain("tool_c");
	});

	it("should pass through unknown entries", () => {
		const result = expandPluginGroups(["read", "unknown"], mockGroups);
		expect(result).toContain("read");
		expect(result).toContain("unknown");
	});

	it("should combine plugin and non-plugin entries", () => {
		const result = expandPluginGroups(["read", "plugin-x"], mockGroups);
		expect(result).toContain("read");
		expect(result).toContain("tool_a");
		expect(result).toContain("tool_b");
	});

	it("should deduplicate results", () => {
		const result = expandPluginGroups(["tool_a", "plugin-x"], mockGroups);
		const countA = result?.filter((t) => t === "tool_a").length ?? 0;
		expect(countA).toBe(1);
	});

	it("should handle undefined input", () => {
		expect(expandPluginGroups(undefined, mockGroups)).toBeUndefined();
	});

	it("should handle empty input", () => {
		expect(expandPluginGroups([], mockGroups)).toEqual([]);
	});

	it("should keep group:plugins as-is when no plugin tools", () => {
		const emptyGroups: PluginToolGroups = { all: [], byPlugin: new Map() };
		const result = expandPluginGroups(["group:plugins"], emptyGroups);
		expect(result).toContain("group:plugins");
	});
});

// ============================================================================
// collectExplicitAllowlist Tests
// ============================================================================

describe("collectExplicitAllowlist()", () => {
	it("should collect allow entries from multiple policies", () => {
		const policies: Array<ToolPolicyConfig | undefined> = [
			{ allow: ["read", "write"] },
			{ allow: ["exec"] },
		];

		const result = collectExplicitAllowlist(policies);
		expect(result).toContain("read");
		expect(result).toContain("write");
		expect(result).toContain("exec");
	});

	it("should skip policies without allow lists", () => {
		const policies: Array<ToolPolicyConfig | undefined> = [
			{ deny: ["exec"] },
			{ allow: ["read"] },
			undefined,
		];

		const result = collectExplicitAllowlist(policies);
		expect(result).toEqual(["read"]);
	});

	it("should trim entries", () => {
		const result = collectExplicitAllowlist([
			{ allow: ["  read  ", "\twrite\n"] },
		]);
		expect(result).toContain("read");
		expect(result).toContain("write");
	});

	it("should filter empty entries", () => {
		const result = collectExplicitAllowlist([{ allow: ["read", "", "  "] }]);
		expect(result).toEqual(["read"]);
	});

	it("should handle empty policies array", () => {
		expect(collectExplicitAllowlist([])).toEqual([]);
	});
});

// ============================================================================
// ToolPolicyService Tests
// ============================================================================

describe("ToolPolicyService", () => {
	let service: ToolPolicyService;

	beforeEach(() => {
		service = new ToolPolicyService();
	});

	describe("constructor", () => {
		it("should initialize core tools from TOOL_GROUPS", () => {
			const coreTools = service.getCoreTools();
			expect(coreTools.has("read")).toBe(true);
			expect(coreTools.has("write")).toBe(true);
			expect(coreTools.has("exec")).toBe(true);
			expect(coreTools.size).toBeGreaterThan(10);
		});

		it("should initialize empty plugin groups", () => {
			const groups = service.getPluginToolGroups();
			expect(groups.all).toEqual([]);
			expect(groups.byPlugin.size).toBe(0);
		});
	});

	describe("expandToolGroups()", () => {
		it("should delegate to utility function", () => {
			const result = service.expandToolGroups(["group:fs"]);
			expect(result).toContain("read");
			expect(result).toContain("write");
		});
	});

	describe("isToolAllowed()", () => {
		it("should allow all tools with no context", () => {
			const result = service.isToolAllowed("exec");
			expect(result.allowed).toBe(true);
			expect(result.reason).toBe("No policy restrictions");
		});

		it("should respect profile policy", () => {
			const result = service.isToolAllowed("exec", { profile: "minimal" });
			expect(result.allowed).toBe(false);
			expect(result.reason).toBe("Not in allowlist");
		});

		it("should allow tools in profile", () => {
			const result = service.isToolAllowed("session_status", {
				profile: "minimal",
			});
			expect(result.allowed).toBe(true);
		});

		it("should respect deny list", () => {
			const result = service.isToolAllowed("exec", {
				characterPolicy: { deny: ["exec"] },
			});
			expect(result.allowed).toBe(false);
			expect(result.reason).toBe("Explicitly denied");
		});

		it("should provide effective policy in result", () => {
			const result = service.isToolAllowed("read", {
				profile: "coding",
				characterPolicy: { deny: ["exec"] },
			});
			expect(result.effectivePolicy).toBeDefined();
			expect(result.effectivePolicy.deny).toContain("exec");
		});

		it("should normalize tool names", () => {
			const result = service.isToolAllowed("BASH", {
				characterPolicy: { allow: ["exec"] },
			});
			expect(result.allowed).toBe(true);
		});
	});

	describe("getEffectivePolicy()", () => {
		it("should return empty policy for no context", () => {
			const result = service.getEffectivePolicy();
			expect(result).toEqual({});
		});

		it("should resolve profile policy", () => {
			const result = service.getEffectivePolicy({ profile: "minimal" });
			expect(result.allow).toContain("session_status");
		});

		it("should merge character policy", () => {
			const result = service.getEffectivePolicy({
				profile: "minimal",
				characterPolicy: { deny: ["session_status"] },
			});
			expect(result.deny).toContain("session_status");
		});

		it("should respect precedence order", () => {
			const result = service.getEffectivePolicy({
				profile: "minimal",
				characterPolicy: { allow: ["read"] },
				channelPolicy: { allow: ["write"] },
			});
			// Channel policy overrides character policy for allow
			expect(result.allow).toEqual(["write"]);
		});

		it("should combine deny lists from all levels", () => {
			const result = service.getEffectivePolicy({
				characterPolicy: { deny: ["exec"] },
				channelPolicy: { deny: ["process"] },
				providerPolicy: { deny: ["write"] },
			});
			expect(result.deny).toContain("exec");
			expect(result.deny).toContain("process");
			expect(result.deny).toContain("write");
		});

		it("should cache profile policies", () => {
			// First call
			const result1 = service.getEffectivePolicy({ profile: "minimal" });
			// Second call (should use cache)
			const result2 = service.getEffectivePolicy({ profile: "minimal" });

			expect(result1.allow).toEqual(result2.allow);
		});

		it("should include world policy", () => {
			const result = service.getEffectivePolicy({
				worldPolicy: { deny: ["exec"] },
			});
			expect(result.deny).toContain("exec");
		});

		it("should include room policy", () => {
			const result = service.getEffectivePolicy({
				roomPolicy: { allow: ["read"] },
			});
			expect(result.allow).toContain("read");
		});
	});

	describe("getEffectivePolicyForCharacter()", () => {
		it("should extract policy from character settings", () => {
			const character = {
				settings: {
					toolProfile: "coding" as const,
					tools: { deny: ["exec"] },
				},
			};

			const result = service.getEffectivePolicyForCharacter(character);
			expect(result.allow).toContain("group:fs");
			expect(result.deny).toContain("exec");
		});

		it("should include channel overrides", () => {
			const character = {
				settings: { toolProfile: "full" as const },
			};
			const channel = { tools: { deny: ["exec"] } };

			const result = service.getEffectivePolicyForCharacter(character, channel);
			expect(result.deny).toContain("exec");
		});

		it("should include provider overrides", () => {
			const character = { settings: {} };
			const provider = { tools: { allow: ["read", "write"] } };

			const result = service.getEffectivePolicyForCharacter(
				character,
				undefined,
				provider,
			);
			expect(result.allow).toEqual(["read", "write"]);
		});
	});

	describe("filterActions()", () => {
		const actions = [
			{ name: "read" },
			{ name: "write" },
			{ name: "exec" },
			{ name: "custom_tool" },
		];

		it("should return all actions with no context", () => {
			const result = service.filterActions(actions);
			expect(result).toHaveLength(4);
		});

		it("should filter by profile", () => {
			const result = service.filterActions(actions, { profile: "minimal" });
			// Minimal only allows session_status
			expect(result).toHaveLength(0);
		});

		it("should respect allow list", () => {
			const result = service.filterActions(actions, {
				characterPolicy: { allow: ["read", "write"] },
			});
			expect(result).toHaveLength(2);
			expect(result.map((a) => a.name)).toContain("read");
			expect(result.map((a) => a.name)).toContain("write");
		});

		it("should respect deny list", () => {
			const result = service.filterActions(actions, {
				characterPolicy: { deny: ["exec"] },
			});
			expect(result).toHaveLength(3);
			expect(result.map((a) => a.name)).not.toContain("exec");
		});
	});

	describe("getAllowedTools()", () => {
		const tools = ["read", "write", "exec", "session_status"];

		it("should return all tools with no context", () => {
			const result = service.getAllowedTools(undefined, tools);
			expect(result).toEqual(tools);
		});

		it("should filter by policy", () => {
			const result = service.getAllowedTools({ profile: "minimal" }, tools);
			expect(result).toEqual(["session_status"]);
		});
	});

	describe("getDeniedTools()", () => {
		const tools = ["read", "write", "exec"];

		it("should return empty array with no context", () => {
			const result = service.getDeniedTools(undefined, tools);
			expect(result).toHaveLength(0);
		});

		it("should return denied tools with reasons", () => {
			const result = service.getDeniedTools(
				{ characterPolicy: { deny: ["exec"] } },
				tools,
			);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe("exec");
			expect(result[0].reason).toBe("Explicitly denied");
		});
	});

	describe("stripPluginOnlyAllowlist()", () => {
		it("should delegate to utility function", () => {
			const policy: ToolPolicyConfig = { allow: ["read"] };
			const result = service.stripPluginOnlyAllowlist(policy);
			expect(result.strippedAllowlist).toBe(false);
		});
	});

	describe("validatePolicy()", () => {
		it("should validate valid policy", () => {
			const result = service.validatePolicy({
				allow: ["read", "write", "group:fs"],
				deny: ["exec"],
			});
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it("should warn about unknown groups", () => {
			const result = service.validatePolicy({
				allow: ["group:unknown"],
			});
			expect(result.warnings.length).toBeGreaterThan(0);
			expect(result.warnings[0]).toContain("unknown group");
		});

		it("should warn about unknown tools", () => {
			const result = service.validatePolicy({
				allow: ["definitely_not_a_real_tool"],
			});
			expect(result.warnings.length).toBeGreaterThan(0);
		});

		it("should error on invalid entries", () => {
			const result = service.validatePolicy({
				allow: ["read", "" as unknown as string],
			});
			expect(result.valid).toBe(false);
			expect(result.errors.length).toBeGreaterThan(0);
		});

		it("should allow wildcards", () => {
			const result = service.validatePolicy({ allow: ["*"] });
			expect(result.valid).toBe(true);
			expect(result.warnings).toHaveLength(0);
		});

		it("should allow group:plugins", () => {
			const result = service.validatePolicy({ allow: ["group:plugins"] });
			expect(result.valid).toBe(true);
		});
	});

	describe("stop()", () => {
		it("should clear caches", async () => {
			// Populate cache
			service.getEffectivePolicy({ profile: "minimal" });

			await service.stop();

			// After stop, getting effective policy should still work
			// (cache is cleared but rebuilt on demand)
			const result = service.getEffectivePolicy({ profile: "minimal" });
			expect(result.allow).toBeDefined();
		});
	});
});

// ============================================================================
// Integration Tests
// ============================================================================

describe("Tool Policy Integration", () => {
	it("should handle complete policy evaluation flow", () => {
		const service = new ToolPolicyService();

		// Simulate a character with coding profile and custom restrictions
		const context: ToolPolicyContext = {
			profile: "coding",
			characterPolicy: {
				deny: ["process"], // Disable process management
			},
			channelPolicy: {
				deny: ["group:web"], // Disable web tools for this channel
			},
		};

		// Should allow coding tools
		expect(service.isToolAllowed("read", context).allowed).toBe(true);
		expect(service.isToolAllowed("write", context).allowed).toBe(true);
		expect(service.isToolAllowed("exec", context).allowed).toBe(true);

		// Should deny process (from character policy)
		expect(service.isToolAllowed("process", context).allowed).toBe(false);

		// Should deny web tools (from channel policy)
		expect(service.isToolAllowed("web_search", context).allowed).toBe(false);
		expect(service.isToolAllowed("web_fetch", context).allowed).toBe(false);
	});

	it("should handle restrictive messaging profile", () => {
		const service = new ToolPolicyService();

		const context: ToolPolicyContext = {
			profile: "messaging",
		};

		// Should allow messaging tools
		expect(service.isToolAllowed("message", context).allowed).toBe(true);
		expect(service.isToolAllowed("sessions_list", context).allowed).toBe(true);
		expect(service.isToolAllowed("session_status", context).allowed).toBe(true);

		// Should deny non-messaging tools
		expect(service.isToolAllowed("exec", context).allowed).toBe(false);
		expect(service.isToolAllowed("read", context).allowed).toBe(false);
		expect(service.isToolAllowed("write", context).allowed).toBe(false);
	});

	it("should handle full profile with specific denies", () => {
		const service = new ToolPolicyService();

		const context: ToolPolicyContext = {
			profile: "full",
			characterPolicy: {
				deny: ["exec", "process"],
			},
		};

		// Full profile allows everything except what's denied
		expect(service.isToolAllowed("read", context).allowed).toBe(true);
		expect(service.isToolAllowed("write", context).allowed).toBe(true);
		expect(service.isToolAllowed("web_search", context).allowed).toBe(true);

		// But these are denied
		expect(service.isToolAllowed("exec", context).allowed).toBe(false);
		expect(service.isToolAllowed("process", context).allowed).toBe(false);
	});

	it("should filter actions for rendering", () => {
		const service = new ToolPolicyService();

		const allActions = [
			{ name: "read", description: "Read files" },
			{ name: "write", description: "Write files" },
			{ name: "exec", description: "Execute commands" },
			{ name: "message", description: "Send messages" },
			{ name: "web_search", description: "Search the web" },
		];

		const messagingContext: ToolPolicyContext = {
			profile: "messaging",
		};

		const filtered = service.filterActions(allActions, messagingContext);

		expect(filtered.map((a) => a.name)).toEqual(["message"]);
	});
});
