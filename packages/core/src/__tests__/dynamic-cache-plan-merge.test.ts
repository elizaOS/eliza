/**
 * Tests for mergeProviderOptionsWithCachePlan — the exported helper used by
 * dynamicPromptExecFromState to merge per-call providerOptions with the PromptBatcher
 * cache plan. Imports the real function so regressions in runtime.ts are caught here.
 */
import { describe, expect, it } from "vitest";
import { mergeProviderOptionsWithCachePlan } from "../runtime";

describe("mergeProviderOptionsWithCachePlan", () => {
	it("caller nested provider fields survive alongside cache-plan additions", () => {
		const result = mergeProviderOptionsWithCachePlan(
			{ agentName: "Bot" },
			{ anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } } },
			{ anthropic: { cacheControl: { type: "ephemeral" } } },
		);

		expect(result.agentName).toBe("Bot");
		const anthropic = result.anthropic as Record<string, unknown>;
		expect(anthropic.thinking).toEqual({ type: "enabled", budgetTokens: 1024 });
		expect(anthropic.cacheControl).toEqual({ type: "ephemeral" });
	});

	it("cache-plan nested field overwrites caller on key collision within a provider namespace", () => {
		const result = mergeProviderOptionsWithCachePlan(
			{ agentName: "Bot" },
			{ anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } } },
			{ anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } },
		);

		const anthropic = result.anthropic as Record<string, unknown>;
		expect((anthropic.cacheControl as Record<string, unknown>).ttl).toBe("1h");
	});

	it("top-level non-object plan values replace caller values", () => {
		const result = mergeProviderOptionsWithCachePlan(
			{ agentName: "Bot" },
			{ openrouter: { promptCacheKey: "old" } },
			{ openrouter: { promptCacheKey: "new", prompt_cache_key: "new" } },
		);

		const openrouter = result.openrouter as Record<string, unknown>;
		expect(openrouter.promptCacheKey).toBe("new");
		expect(openrouter.prompt_cache_key).toBe("new");
	});

	it("caller top-level provider namespaces not in the plan survive untouched", () => {
		const result = mergeProviderOptionsWithCachePlan(
			{ agentName: "Bot" },
			{ gateway: { caching: "auto" }, openai: { promptCacheKey: "abc" } },
			{ anthropic: { cacheControl: { type: "ephemeral" } } },
		);

		expect(result.gateway).toEqual({ caching: "auto" });
		expect(result.openai).toEqual({ promptCacheKey: "abc" });
		expect((result.anthropic as Record<string, unknown>).cacheControl).toEqual({
			type: "ephemeral",
		});
	});

	it("undefined caller options still receive the full cache plan", () => {
		const result = mergeProviderOptionsWithCachePlan(
			{ agentName: "Bot" },
			undefined,
			{
				anthropic: { cacheControl: { type: "ephemeral" } },
				openrouter: { promptCacheKey: "x" },
			},
		);

		expect(result.agentName).toBe("Bot");
		expect(result.anthropic).toBeDefined();
		expect(result.openrouter).toBeDefined();
	});

	it("plan scalar value wins over caller and base on key collision", () => {
		const result = mergeProviderOptionsWithCachePlan(
			{ agentName: "RealBot" },
			{ agentName: "CallerOverride" },
			{ agentName: "PlanOverride" },
		);

		expect(result.agentName).toBe("PlanOverride");
	});

	it("array values in plan replace (not merge) the corresponding caller value", () => {
		const result = mergeProviderOptionsWithCachePlan(
			{ agentName: "Bot" },
			{ tags: ["a", "b"] },
			{ tags: ["c"] },
		);

		expect(result.tags).toEqual(["c"]);
	});
});
