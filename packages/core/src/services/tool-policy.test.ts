/**
 * Exercises ToolPolicyService directly across construction, plugin-group
 * registration, the allow/deny reason matrix, multi-source policy
 * precedence, action filtering, plugin-only allowlist stripping, and
 * policy validation. The suite is deterministic and mock-free: collaborator
 * runtimes are plain objects and every assertion drives the real policy
 * engine.
 */
import { describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../types";
import type { ToolProfileId } from "../types/tools";
import { TOOL_GROUPS, TOOL_PROFILES } from "../types/tools";
import { ToolPolicyService } from "./tool-policy";

const fakeRuntime = (
	actions: Array<Record<string, unknown>> = [],
): IAgentRuntime =>
	({
		agentId: "00000000-0000-0000-0000-000000000000",
		getAllActions: () => actions,
	}) as unknown as IAgentRuntime;

const pluginActions = (): Array<Record<string, unknown>> => [
	{ name: "Plugin_Tool_One", pluginId: "Some-Plugin" },
	{ name: "other_tool", plugin: "ANOTHER_PLUGIN" },
	{ name: "Bare_Action" },
];

const serviceWithPlugins = (): ToolPolicyService => {
	const service = new ToolPolicyService(fakeRuntime(pluginActions()));
	service.updatePluginGroups();
	return service;
};

describe("ToolPolicyService construction and registries", () => {
	it("exposes the tool_policy service type and constructs without a runtime", () => {
		const service = new ToolPolicyService();
		expect(ToolPolicyService.serviceType).toBe("tool_policy");
		expect(service.getCoreTools()).toEqual(new Set(TOOL_GROUPS["group:all"]));
	});

	it("returns a defensive copy of the core tool set", () => {
		const service = new ToolPolicyService();
		const tools = service.getCoreTools();
		tools.delete("exec");
		expect(service.getCoreTools().has("exec")).toBe(true);
	});

	it("returns a defensive copy of the plugin tool groups", () => {
		const service = serviceWithPlugins();
		const snapshot = service.getPluginToolGroups();
		snapshot.all.push("injected");
		snapshot.byPlugin.delete("some-plugin");
		expect(service.getPluginToolGroups().all).toEqual([
			"plugin_tool_one",
			"other_tool",
		]);
		expect(service.getPluginToolGroups().byPlugin.get("some-plugin")).toEqual([
			"plugin_tool_one",
		]);
	});

	it("starts from empty plugin groups and treats updatePluginGroups without a runtime as a no-op", () => {
		const service = new ToolPolicyService();
		expect(service.getPluginToolGroups()).toEqual({
			all: [],
			byPlugin: new Map(),
		});
		service.updatePluginGroups();
		expect(service.getPluginToolGroups().all).toEqual([]);
	});

	it("builds plugin groups from runtime actions, skipping tools without plugin metadata", () => {
		const service = serviceWithPlugins();
		expect(service.getPluginToolGroups().all).toEqual([
			"plugin_tool_one",
			"other_tool",
		]);
		expect(service.getPluginToolGroups().byPlugin.get("some-plugin")).toEqual([
			"plugin_tool_one",
		]);
		expect(
			service.getPluginToolGroups().byPlugin.get("another_plugin"),
		).toEqual(["other_tool"]);
		expect(service.getPluginToolGroups().byPlugin.has("bare_action")).toBe(
			false,
		);
	});

	it("static start registers plugin groups from the runtime and returns the service", async () => {
		const started = await ToolPolicyService.start(fakeRuntime(pluginActions()));
		expect(started).toBeInstanceOf(ToolPolicyService);
		expect((started as ToolPolicyService).getPluginToolGroups().all).toEqual([
			"plugin_tool_one",
			"other_tool",
		]);
		await started.stop();
	});
});

describe("expandToolGroups delegation", () => {
	it("expands group references, normalizes names, and deduplicates", () => {
		const service = new ToolPolicyService();
		expect(service.expandToolGroups(["GROUP:FS"])).toEqual(
			TOOL_GROUPS["group:fs"],
		);
		expect(service.expandToolGroups(["group:runtime", " EXEC "])).toEqual([
			"exec",
			"process",
		]);
		expect(service.expandToolGroups([])).toEqual([]);
	});
});

describe("isToolAllowed reason matrix", () => {
	const service = new ToolPolicyService();

	it("allows everything with no context and reports no policy restrictions", () => {
		expect(service.isToolAllowed("exec")).toEqual({
			allowed: true,
			reason: "No policy restrictions",
			effectivePolicy: {},
		});
		expect(service.isToolAllowed("exec", {}).reason).toBe(
			"No policy restrictions",
		);
	});

	it("reports wildcard allows", () => {
		const result = service.isToolAllowed("exec", {
			characterPolicy: { allow: ["*"] },
		});
		expect(result.allowed).toBe(true);
		expect(result.reason).toBe("Allowed by wildcard");
	});

	it("matches allow-listed tools case-insensitively and reports explicit allows", () => {
		const result = service.isToolAllowed("EXEC", {
			characterPolicy: { allow: ["exec"] },
		});
		expect(result.allowed).toBe(true);
		expect(result.reason).toBe("Explicitly allowed");
	});

	it("denies tools missing from a non-wildcard allowlist", () => {
		const result = service.isToolAllowed("exec", {
			characterPolicy: { allow: ["web_search"] },
		});
		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("Not in allowlist");
	});

	it("treats an empty allow list as unrestricted rather than closed", () => {
		const result = service.isToolAllowed("exec", {
			characterPolicy: { allow: [] },
		});
		expect(result.allowed).toBe(true);
		expect(result.reason).toBe("Allowed (no restrictions)");
	});

	it("reports explicitly denied and not-denied outcomes for deny-only policies", () => {
		const context = { characterPolicy: { deny: ["group:runtime"] } };
		const denied = service.isToolAllowed("exec", context);
		expect(denied.allowed).toBe(false);
		expect(denied.reason).toBe("Explicitly denied");
		const spared = service.isToolAllowed("read", context);
		expect(spared.allowed).toBe(true);
		expect(spared.reason).toBe("Allowed (not denied)");
	});

	it("lets deny take precedence over a wildcard allow", () => {
		const result = service.isToolAllowed("exec", {
			characterPolicy: { allow: ["*"], deny: ["exec"] },
		});
		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("Explicitly denied");
	});

	it("resolves the minimal profile to its session_status allowlist", () => {
		const allowed = service.isToolAllowed("session_status", {
			profile: "minimal",
		});
		expect(allowed.allowed).toBe(true);
		expect(allowed.reason).toBe("Explicitly allowed");
		const rejected = service.isToolAllowed("exec", { profile: "minimal" });
		expect(rejected.allowed).toBe(false);
		expect(rejected.reason).toBe("Not in allowlist");
	});

	it("expands group-based profile allows against concrete tools", () => {
		const result = service.isToolAllowed("write", { profile: "coding" });
		expect(result.allowed).toBe(true);
		expect(result.reason).toBe("Explicitly allowed");
	});

	it("expands group:plugins through registered plugin groups", () => {
		const withPlugins = serviceWithPlugins();
		const hit = withPlugins.isToolAllowed("plugin_tool_one", {
			characterPolicy: { allow: ["group:plugins"] },
		});
		expect(hit.allowed).toBe(true);
		expect(hit.reason).toBe("Explicitly allowed");
		const miss = withPlugins.isToolAllowed("bare_action", {
			characterPolicy: { allow: ["group:plugins"] },
		});
		expect(miss.allowed).toBe(false);
		expect(miss.reason).toBe("Not in allowlist");
	});
});

describe("getEffectivePolicy precedence", () => {
	const service = new ToolPolicyService();

	it("returns an empty policy for no context, the full profile, and unknown profiles", () => {
		expect(service.getEffectivePolicy()).toEqual({});
		expect(service.getEffectivePolicy(undefined)).toEqual({});
		expect(service.getEffectivePolicy({ profile: "full" })).toEqual({});
		expect(
			service.getEffectivePolicy({
				profile: "nonexistent" as unknown as ToolProfileId,
			}),
		).toEqual({});
	});

	it("returns the resolved profile policy verbatim", () => {
		expect(service.getEffectivePolicy({ profile: "minimal" })).toEqual({
			allow: ["session_status"],
		});
	});

	it("replaces profile allows while accumulating and deduplicating denies in source order", () => {
		const policy = service.getEffectivePolicy({
			profile: "minimal",
			characterPolicy: { allow: ["*"], deny: ["exec"] },
			worldPolicy: { deny: ["process"] },
			channelPolicy: { allow: ["web_search"], deny: ["edit"] },
			roomPolicy: { deny: ["write"] },
			providerPolicy: { allow: ["read_file"], deny: ["exec"] },
		});
		expect(policy.allow).toEqual(["read_file"]);
		expect(policy.deny).toEqual(["exec", "process", "edit", "write"]);
	});

	it("caches profile resolution without changing results across calls", () => {
		const first = service.getEffectivePolicy({ profile: "coding" });
		const second = service.getEffectivePolicy({ profile: "coding" });
		expect(second).toEqual(first);
		expect(first.allow).toEqual(TOOL_PROFILES.coding.allow);
	});
});

describe("getEffectivePolicyForCharacter extraction", () => {
	it("pulls profile, character, channel, and provider policies from their settings shapes", () => {
		const service = new ToolPolicyService();
		const policy = service.getEffectivePolicyForCharacter(
			{
				settings: {
					toolProfile: "minimal",
					tools: { deny: ["exec"] },
				},
			},
			{ tools: { allow: ["*"] } },
			{ tools: { allow: ["read"] } },
		);
		expect(policy.allow).toEqual(["read"]);
		expect(policy.deny).toEqual(["exec"]);
	});

	it("tolerates characters and overrides without any tool settings", () => {
		const service = new ToolPolicyService();
		expect(service.getEffectivePolicyForCharacter({})).toEqual({});
		expect(service.getEffectivePolicyForCharacter({}, {}, {})).toEqual({});
	});
});

describe("filterActions, getAllowedTools, and getDeniedTools", () => {
	const service = new ToolPolicyService();
	const context = { characterPolicy: { deny: ["exec"] } };

	it("filters actions in order and preserves the original elements", () => {
		const first = { name: "ReadFile", weight: 1 };
		const second = { name: "EXEC", weight: 2 };
		const third = { name: "cron", weight: 3 };
		const kept = service.filterActions([first, second, third], context);
		expect(kept).toEqual([first, third]);
		expect(kept[0]).toBe(first);
	});

	it("partitions available tools into allowed and denied lists with reasons", () => {
		const available = ["EXEC", "read", "cron"];
		expect(service.getAllowedTools(context, available)).toEqual([
			"read",
			"cron",
		]);
		expect(service.getDeniedTools(context, available)).toEqual([
			{ name: "EXEC", reason: "Explicitly denied" },
		]);
	});

	it("returns empty results when nothing is denied", () => {
		expect(service.getAllowedTools(context, [])).toEqual([]);
		expect(service.getDeniedTools(undefined, ["exec"])).toEqual([]);
	});
});

describe("stripPluginOnlyAllowlist", () => {
	it("passes through policies without an allow list untouched", () => {
		const service = serviceWithPlugins();
		expect(service.stripPluginOnlyAllowlist(undefined)).toEqual({
			policy: undefined,
			unknownAllowlist: [],
			strippedAllowlist: false,
		});
		const denyOnly = { deny: ["exec"] };
		expect(service.stripPluginOnlyAllowlist(denyOnly)).toEqual({
			policy: denyOnly,
			unknownAllowlist: [],
			strippedAllowlist: false,
		});
	});

	it("keeps allowlists that reference core tools or the wildcard", () => {
		const service = serviceWithPlugins();
		const core = service.stripPluginOnlyAllowlist({ allow: ["exec"] });
		expect(core.strippedAllowlist).toBe(false);
		expect(core.unknownAllowlist).toEqual([]);
		const mixed = service.stripPluginOnlyAllowlist({
			allow: ["exec", "plugin_tool_one"],
		});
		expect(mixed.strippedAllowlist).toBe(false);
		const wildcard = service.stripPluginOnlyAllowlist({ allow: ["*"] });
		expect(wildcard.strippedAllowlist).toBe(false);
	});

	it("strips plugin-only allowlists so core tools stay reachable", () => {
		const service = serviceWithPlugins();
		const result = service.stripPluginOnlyAllowlist({
			allow: ["plugin_tool_one"],
		});
		expect(result.strippedAllowlist).toBe(true);
		expect(result.policy?.allow).toBeUndefined();
		expect(result.unknownAllowlist).toEqual([]);
	});

	it("reports unrecognized entries and strips them when nothing else qualifies", () => {
		const service = serviceWithPlugins();
		const mixed = service.stripPluginOnlyAllowlist({
			allow: ["exec", "mystery_tool"],
		});
		expect(mixed.strippedAllowlist).toBe(false);
		expect(mixed.unknownAllowlist).toEqual(["mystery_tool"]);
		const unknownOnly = service.stripPluginOnlyAllowlist({
			allow: ["mystery_tool", "Mystery_Tool"],
		});
		expect(unknownOnly.strippedAllowlist).toBe(true);
		expect(unknownOnly.unknownAllowlist).toEqual(["mystery_tool"]);
	});
});

describe("validatePolicy", () => {
	it("accepts an empty policy and recognized entries without warnings", () => {
		const service = serviceWithPlugins();
		expect(service.validatePolicy({})).toEqual({
			valid: true,
			warnings: [],
			errors: [],
		});
		const verdict = service.validatePolicy({
			allow: ["group:fs", "group:plugins", "*", "exec", "plugin_tool_one"],
			deny: ["cron"],
		});
		expect(verdict.valid).toBe(true);
		expect(verdict.warnings).toEqual([]);
		expect(verdict.errors).toEqual([]);
	});

	it("warns about unknown groups and unknown tools without failing validation", () => {
		const service = new ToolPolicyService();
		const verdict = service.validatePolicy({
			allow: ["group:bogus"],
			deny: ["not_a_tool"],
		});
		expect(verdict.valid).toBe(true);
		expect(verdict.warnings).toEqual([
			"allow contains unknown group: group:bogus",
			"deny contains unknown tool: not_a_tool (may be a plugin tool)",
		]);
		expect(verdict.errors).toEqual([]);
	});

	it("fails validation on non-string entries", () => {
		const service = new ToolPolicyService();
		const verdict = service.validatePolicy({
			allow: [null as unknown as string],
		});
		expect(verdict.valid).toBe(false);
		expect(verdict.errors).toEqual(["allow contains invalid entry: null"]);
		expect(verdict.warnings).toEqual([]);
	});
});

describe("stop lifecycle", () => {
	it("stops cleanly and keeps serving policy decisions afterwards", async () => {
		const service = serviceWithPlugins();
		await service.stop();
		expect(service.isToolAllowed("exec").allowed).toBe(true);
	});
});
