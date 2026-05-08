import { describe, expect, it } from "vitest";
import {
	buildPromptCacheKey,
	buildProviderCachePlan,
} from "../provider-cache-plan";

describe("ProviderCachePlan", () => {
	it("builds deterministic providerOptions for OpenAI, Cerebras, OpenRouter, and Gateway", () => {
		const plan = buildProviderCachePlan({
			prefixHash: "abc123",
			segmentHashes: ["s1", "s2"],
		});

		expect(plan.promptCacheKey).toBe("v5:abc123");
		expect(plan.providerOptions.openai).toEqual({
			promptCacheKey: "v5:abc123",
		});
		expect(plan.providerOptions.cerebras).toEqual({
			promptCacheKey: "v5:abc123",
			prompt_cache_key: "v5:abc123",
		});
		expect(plan.providerOptions.openrouter).toEqual({
			promptCacheKey: "v5:abc123",
			prompt_cache_key: "v5:abc123",
		});
		expect(plan.providerOptions.gateway).toEqual({ caching: "auto" });
	});

	it("only emits OpenAI 24h retention for documented extended-retention models", () => {
		const miniPlan = buildProviderCachePlan({
			prefixHash: "abc123",
			model: "gpt-5.4-mini",
		});
		const extendedPlan = buildProviderCachePlan({
			prefixHash: "abc123",
			model: "gpt-5.4",
		});

		expect(miniPlan.providerOptions.openai).toEqual({
			promptCacheKey: "v5:abc123",
		});
		expect(extendedPlan.providerOptions.openai).toEqual({
			promptCacheKey: "v5:abc123",
			promptCacheRetention: "24h",
		});
	});

	it("limits Anthropic user-content breakpoints to three plus system", () => {
		const plan = buildProviderCachePlan({
			prefixHash: "abc123",
			segmentHashes: ["s0", "s1", "s2", "s3", "s4"],
			promptSegments: [
				{ stable: true },
				{ stable: false },
				{ stable: true },
				{ stable: false },
				{ stable: true },
			],
		});

		const anthropic = plan.providerOptions.anthropic as Record<string, unknown>;
		expect(anthropic.maxBreakpoints).toBe(4);
		expect(anthropic.cacheSystem).toBe(true);
		expect(plan.anthropic.breakpoints).toHaveLength(3);
		expect(
			plan.anthropic.breakpoints.map((breakpoint) => breakpoint.segmentIndex),
		).toEqual([0, 2, 4]);
		expect(1 + plan.anthropic.breakpoints.length).toBeLessThanOrEqual(4);
	});

	it("uses section priority while preserving selected marker order", () => {
		const plan = buildProviderCachePlan({
			prefixHash: "abc123",
			segmentHashes: ["s0", "s1", "s2", "s3"],
			sections: [
				{ id: "low", segmentIndex: 0, priority: 1, ttl: "short" },
				{ id: "history", segmentIndex: 3, priority: 10, ttl: "short" },
				{ id: "character", segmentIndex: 1, priority: 20, ttl: "long" },
				{ id: "tier-a", segmentIndex: 2, priority: 15, ttl: "short" },
			],
		});

		expect(
			plan.anthropic.breakpoints.map((breakpoint) => breakpoint.id),
		).toEqual(["character", "tier-a", "history"]);
		expect(plan.anthropic.breakpoints[0]?.cacheControl).toEqual({
			type: "ephemeral",
			ttl: "1h",
		});
	});

	it("does not emit explicit Gemini cache markers when tools are present", () => {
		const plan = buildProviderCachePlan({
			prefixHash: "abc123",
			provider: "google",
			model: "gemini-3-pro",
			hasTools: true,
			promptSegments: [{ stable: true }],
		});

		expect(plan.providerOptions).not.toHaveProperty("anthropic");
		expect(plan.providerOptions).not.toHaveProperty("google");
		expect(plan.warnings[0]).toContain("Gemini explicit caching is disabled");
	});

	it("caps prompt cache keys at 1024 characters", () => {
		expect(buildPromptCacheKey("x".repeat(2000))).toHaveLength(1024);
	});
});
