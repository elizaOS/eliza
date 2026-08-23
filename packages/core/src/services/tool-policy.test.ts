/**
 * Exercises ToolPolicyService against the real policy engine in
 * types/tools.ts: multi-source merge precedence, allow/deny evaluation and
 * its reason strings, plugin-group ingestion, plugin-only allowlist
 * stripping, and policy validation diagnostics. Deterministic unit suite
 * driven through a minimal in-memory IAgentRuntime stub — no network.
 */
import { describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../types/index.ts";
import { Service, ServiceType } from "../types/service.ts";
import { TOOL_GROUPS } from "../types/tools.ts";
import { ToolPolicyService } from "./tool-policy.ts";

function createRuntime(
	actions: Array<Record<string, unknown>> = [],
): IAgentRuntime {
	return {
		agentId: "00000000-0000-0000-0000-0000000000aa",
		getAllActions: () => actions,
	} as unknown as IAgentRuntime;
}

describe("ToolPolicyService construction", () => {
	it("exposes the canonical tool_policy service type", () => {
		const service = new ToolPolicyService();
		expect(ToolPolicyService.serviceType).toBe(ServiceType.TOOL_POLICY);
		expect(service).toBeInstanceOf(Service);
	});

	it("seeds core tools from every TOOL_GROUPS entry", () => {
		const service = new ToolPolicyService();
		const core = service.getCoreTools();
		for (const tool of Object.values(TOOL_GROUPS).flat()) {
			expect(core.has(tool)).toBe(true);
		}
		expect(core.has("exec")).toBe(true);
		expect(core.has("session_status")).toBe(true);
	});

	it("returns a defensive copy of the core tool set", () => {
		const service = new ToolPolicyService();
		service.getCoreTools().add("injected-tool");
		expect(service.getCoreTools().has("injected-tool")).toBe(false);
	});

	it("starts with empty plugin groups that are defensive copies", () => {
		const service = new ToolPolicyService();
		expect(service.getPluginToolGroups()).toEqual({
			all: [],
			byPlugin: new Map(),
		});
		service.getPluginToolGroups().all.push("injected-tool");
		expect(service.getPluginToolGroups().all).toEqual([]);
	});
});

describe("ToolPolicyService.start", () => {
	it("builds the service and ingests plugin actions up front", async () => {
		const service = await ToolPolicyService.start(
			createRuntime([{ name: "Web3_Mint", pluginId: "web3" }]),
		);
		expect(service).toBeInstanceOf(ToolPolicyService);
		expect(service.getPluginToolGroups()).toEqual({
			all: ["web3_mint"],
			byPlugin: new Map([["web3", ["web3_mint"]]]),
		});
	});
});

describe("updatePluginGroups", () => {
	it("keeps groups empty when constructed without a runtime", () => {
		const service = new ToolPolicyService();
		service.updatePluginGroups();
		expect(service.getPluginToolGroups().all).toEqual([]);
	});

	it("normalizes tool names and lowercases plugin ids", () => {
		const service = new ToolPolicyService(
			createRuntime([
				{ name: "Mint_NFT", pluginId: "Solana" },
				{ name: "Swap", plugin: "Jupiter" },
				{ name: "Untagged" },
			]),
		);
		service.updatePluginGroups();
		expect(service.getPluginToolGroups()).toEqual({
			all: ["mint_nft", "swap"],
			byPlugin: new Map([
				["solana", ["mint_nft"]],
				["jupiter", ["swap"]],
			]),
		});
	});
});

describe("expandToolGroups", () => {
	it("expands group references, dedupes, and preserves order", () => {
		const service = new ToolPolicyService();
		expect(service.expandToolGroups(["GROUP:FS", "exec", "GROUP:FS"])).toEqual([
			"read",
			"read_file",
			"write",
			"edit",
			"apply_patch",
			"exec",
		]);
	});

	it("passes plain tool names through untouched", () => {
		const service = new ToolPolicyService();
		expect(service.expandToolGroups([])).toEqual([]);
		expect(service.expandToolGroups(["*"])).toEqual(["*"]);
	});
});

describe("getEffectivePolicy merge precedence", () => {
	it("returns an empty policy for an absent context", () => {
		expect(new ToolPolicyService().getEffectivePolicy(undefined)).toEqual({});
		expect(new ToolPolicyService().getEffectivePolicy({})).toEqual({});
	});

	it("resolves known profiles to their base policies", () => {
		const service = new ToolPolicyService();
		expect(service.getEffectivePolicy({ profile: "minimal" })).toEqual({
			allow: ["session_status"],
		});
	});

	it("treats the full profile and unknown profiles as unrestricted", () => {
		const service = new ToolPolicyService();
		expect(service.getEffectivePolicy({ profile: "full" })).toEqual({});
		expect(
			service.getEffectivePolicy({ profile: "no-such-profile" as never }),
		).toEqual({});
	});

	it("lets later sources replace the allow list entirely", () => {
		const service = new ToolPolicyService();
		expect(
			service.getEffectivePolicy({
				profile: "minimal",
				characterPolicy: { allow: ["exec"] },
			}),
		).toEqual({ allow: ["exec"] });
	});

	it("accumulates and dedupes deny lists across sources", () => {
		const service = new ToolPolicyService();
		expect(
			service.getEffectivePolicy({
				worldPolicy: { deny: ["exec"] },
				channelPolicy: { deny: ["message", "exec"] },
				roomPolicy: { deny: ["cron"] },
			}),
		).toEqual({ deny: ["exec", "message", "cron"] });
	});

	it("gives provider policy the final say over all six sources", () => {
		const service = new ToolPolicyService();
		const effective = service.getEffectivePolicy({
			profile: "minimal",
			characterPolicy: { allow: ["c-tool"] },
			worldPolicy: { allow: ["w-tool"] },
			channelPolicy: { allow: ["ch-tool"] },
			roomPolicy: { allow: ["r-tool"] },
			providerPolicy: { allow: ["pr-tool"] },
		});
		expect(effective.allow).toEqual(["pr-tool"]);
	});
});

describe("getEffectivePolicyForCharacter", () => {
	it("maps character settings and applies channel then provider overrides", () => {
		const service = new ToolPolicyService();
		expect(
			service.getEffectivePolicyForCharacter(
				{ settings: { toolProfile: "minimal", tools: { allow: ["exec"] } } },
				{ tools: { allow: ["read"] } },
				{ tools: { allow: ["write"] } },
			),
		).toEqual({ allow: ["write"] });
	});

	it("falls back to channel when the provider sets nothing", () => {
		const service = new ToolPolicyService();
		expect(
			service.getEffectivePolicyForCharacter({}, { tools: { deny: ["exec"] } }),
		).toEqual({ deny: ["exec"] });
	});
});

describe("isToolAllowed decisions and reasons", () => {
	it("allows everything with no restrictions", () => {
		const result = new ToolPolicyService().isToolAllowed("exec");
		expect(result.allowed).toBe(true);
		expect(result.reason).toBe("No policy restrictions");
		expect(result.effectivePolicy).toEqual({});
	});

	it("reports explicitly allowed for a listed tool and denies the rest", () => {
		const service = new ToolPolicyService();
		const context = { characterPolicy: { allow: ["exec"] } };
		expect(service.isToolAllowed("exec", context)).toMatchObject({
			allowed: true,
			reason: "Explicitly allowed",
		});
		expect(service.isToolAllowed("read", context)).toMatchObject({
			allowed: false,
			reason: "Not in allowlist",
		});
	});

	it("matches tool names case-insensitively across surrounding whitespace", () => {
		const service = new ToolPolicyService();
		const context = { characterPolicy: { allow: ["EXEC"] } };
		expect(service.isToolAllowed("  Exec  ", context)).toMatchObject({
			allowed: true,
			reason: "Explicitly allowed",
		});
	});

	it("reports wildcard allows even for tools the policy never names", () => {
		const service = new ToolPolicyService();
		const result = service.isToolAllowed("anything", {
			characterPolicy: { allow: ["*"] },
		});
		expect(result.allowed).toBe(true);
		expect(result.reason).toBe("Allowed by wildcard");
	});

	it("allows non-denied tools under a deny-only policy", () => {
		const service = new ToolPolicyService();
		const context = { characterPolicy: { deny: ["exec"] } };
		expect(service.isToolAllowed("read", context)).toMatchObject({
			allowed: true,
			reason: "Allowed (not denied)",
		});
	});

	it("denies listed tools under a deny-only policy", () => {
		const service = new ToolPolicyService();
		const result = service.isToolAllowed("exec", {
			characterPolicy: { deny: ["exec"] },
		});
		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("Explicitly denied");
	});

	it("makes deny win over an allow wildcard via group expansion", () => {
		const service = new ToolPolicyService();
		const context = {
			characterPolicy: { allow: ["*"], deny: ["group:runtime"] },
		};
		expect(service.isToolAllowed("process", context)).toMatchObject({
			allowed: false,
			reason: "Explicitly denied",
		});
		expect(service.isToolAllowed("read", context).allowed).toBe(true);
	});

	it("expands group references in the allow list", () => {
		const service = new ToolPolicyService();
		const context = { characterPolicy: { allow: ["group:web"] } };
		expect(service.isToolAllowed("web_search", context)).toMatchObject({
			allowed: true,
			reason: "Explicitly allowed",
		});
		expect(service.isToolAllowed("exec", context).allowed).toBe(false);
	});

	it("echoes the merged effective policy on every result", () => {
		const service = new ToolPolicyService();
		const context = {
			profile: "minimal" as const,
			channelPolicy: { deny: ["exec"] },
		};
		const result = service.isToolAllowed("session_status", context);
		expect(result.allowed).toBe(true);
		expect(result.effectivePolicy).toEqual(service.getEffectivePolicy(context));
	});
});

describe("isToolAllowed with plugin groups", () => {
	it("resolves group:plugins and plugin-id references from runtime actions", () => {
		const service = new ToolPolicyService(
			createRuntime([{ name: "Mint_NFT", pluginId: "solana" }]),
		);
		service.updatePluginGroups();

		const viaPluginsGroup = service.isToolAllowed("mint_nft", {
			characterPolicy: { allow: ["group:plugins"] },
		});
		expect(viaPluginsGroup.allowed).toBe(true);
		expect(viaPluginsGroup.reason).toBe("Explicitly allowed");

		const viaPluginId = service.isToolAllowed("mint_nft", {
			characterPolicy: { allow: ["SOLANA"] },
		});
		expect(viaPluginId.allowed).toBe(true);

		expect(
			service.isToolAllowed("mint_nft", {
				characterPolicy: { allow: ["exec"] },
			}).allowed,
		).toBe(false);
	});
});

describe("filterActions, getAllowedTools, getDeniedTools", () => {
	const context = { characterPolicy: { allow: ["exec"] } };

	it("filters actions by normalized name, preserving order", () => {
		const service = new ToolPolicyService();
		const actions = [
			{ name: "READ", kind: "a" },
			{ name: "EXEC", kind: "b" },
			{ name: "write", kind: "c" },
		];
		expect(service.filterActions(actions, context)).toEqual([
			{ name: "EXEC", kind: "b" },
		]);
		expect(service.filterActions([], context)).toEqual([]);
	});

	it("lists allowed tools in input order", () => {
		const service = new ToolPolicyService();
		expect(service.getAllowedTools(context, ["exec", "EXEC", "read"])).toEqual([
			"exec",
			"EXEC",
		]);
		expect(service.getAllowedTools(undefined, ["exec"])).toEqual(["exec"]);
	});

	it("pairs each denied tool with its reason, preserving order", () => {
		const service = new ToolPolicyService();
		expect(service.getDeniedTools(context, ["read", "write", "exec"])).toEqual([
			{ name: "read", reason: "Not in allowlist" },
			{ name: "write", reason: "Not in allowlist" },
		]);
		expect(service.getDeniedTools(undefined, ["exec", "read"])).toEqual([]);
	});
});

describe("stripPluginOnlyAllowlist", () => {
	it("strips an allowlist of unknown plugin-shaped tools", () => {
		const service = new ToolPolicyService();
		const resolution = service.stripPluginOnlyAllowlist({
			allow: ["some_plugin_tool"],
			deny: ["exec"],
		});
		expect(resolution.strippedAllowlist).toBe(true);
		expect(resolution.unknownAllowlist).toEqual(["some_plugin_tool"]);
		expect(resolution.policy).toEqual({ allow: undefined, deny: ["exec"] });
	});

	it("keeps allowlists containing core tools or wildcards", () => {
		const service = new ToolPolicyService();
		for (const allow of [["exec"], ["group:fs"], ["*"], ["exec", "*"]]) {
			const resolution = service.stripPluginOnlyAllowlist({ allow });
			expect(resolution.strippedAllowlist).toBe(false);
			expect(resolution.policy).toEqual({ allow });
			expect(resolution.unknownAllowlist).toEqual([]);
		}
	});

	it("passes through absent and allow-less policies untouched", () => {
		const service = new ToolPolicyService();
		expect(service.stripPluginOnlyAllowlist(undefined)).toEqual({
			policy: undefined,
			unknownAllowlist: [],
			strippedAllowlist: false,
		});
		expect(service.stripPluginOnlyAllowlist({ deny: ["exec"] })).toEqual({
			policy: { deny: ["exec"] },
			unknownAllowlist: [],
			strippedAllowlist: false,
		});
	});

	it("recognizes registered plugin tools once updatePluginGroups ran", () => {
		const service = new ToolPolicyService(
			createRuntime([{ name: "Mint_NFT", pluginId: "solana" }]),
		);
		service.updatePluginGroups();
		const resolution = service.stripPluginOnlyAllowlist({
			allow: ["mint_nft"],
		});
		expect(resolution.strippedAllowlist).toBe(true);
		expect(resolution.unknownAllowlist).toEqual([]);
	});
});

describe("validatePolicy", () => {
	it("accepts known tools, groups, wildcards, and mixed case", () => {
		const service = new ToolPolicyService();
		expect(
			service.validatePolicy({
				allow: ["EXEC", "group:fs", "*"],
				deny: ["Group:Web"],
			}),
		).toEqual({ valid: true, warnings: [], errors: [] });
	});

	it("accepts the reserved group:plugins reference", () => {
		const service = new ToolPolicyService();
		expect(
			service.validatePolicy({ allow: ["group:plugins"] }).warnings,
		).toEqual([]);
	});

	it("warns on unknown groups and unknown tools while staying valid", () => {
		const service = new ToolPolicyService();
		const result = service.validatePolicy({
			allow: ["group:nope"],
			deny: ["fake_tool"],
		});
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([
			"allow contains unknown group: group:nope",
			"deny contains unknown tool: fake_tool (may be a plugin tool)",
		]);
	});

	it("rejects non-string entries with an error", () => {
		const service = new ToolPolicyService();
		const result = service.validatePolicy({
			allow: [null as unknown as string],
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual(["allow contains invalid entry: null"]);
		expect(result.warnings).toEqual([]);
	});
});

describe("stop", () => {
	it("clears cached state but keeps evaluating policies correctly", async () => {
		const service = new ToolPolicyService();
		await service.stop();
		expect(service.getEffectivePolicy({ profile: "minimal" })).toEqual({
			allow: ["session_status"],
		});
	});
});
