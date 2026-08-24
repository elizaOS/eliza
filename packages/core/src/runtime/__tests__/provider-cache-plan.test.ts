/**
 * Unit coverage for prompt-cache planning — `buildProviderCachePlan` and
 * `buildPromptCacheKey` — verifying the per-provider `providerOptions` (OpenAI
 * retention, Anthropic breakpoints, Cerebras/OpenRouter, Gemini, Gateway, and
 * the eliza sidecar) and the 1024-char cache-key cap. Deterministic; no live
 * provider call.
 */
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

	it("routes per-segment TTL hints into Anthropic breakpoints (#15742)", () => {
		const plan = buildProviderCachePlan({
			prefixHash: "abc123",
			segmentHashes: ["s0", "s1", "s2", "s3"],
			promptSegments: [
				// Stable run ending at index 1: run-end segment carries ttl "long".
				{ stable: true },
				{ stable: true, ttl: "long" },
				{ stable: false },
				// Stable run of one segment with no ttl → default "short".
				{ stable: true },
			],
		});

		expect(plan.anthropic.breakpoints).toEqual([
			{
				segmentIndex: 1,
				segmentHash: "s1",
				ttl: "long",
				cacheControl: { type: "ephemeral", ttl: "1h" },
			},
			{
				segmentIndex: 3,
				segmentHash: "s3",
				ttl: "short",
				cacheControl: { type: "ephemeral" },
			},
		]);
	});

	it("ignores a ttl hint on a segment that is not a stable run end (#15742)", () => {
		const plan = buildProviderCachePlan({
			prefixHash: "abc123",
			segmentHashes: ["s0", "s1", "s2"],
			promptSegments: [
				// ttl on a mid-run segment is inert; the run END segment governs.
				{ stable: true, ttl: "long" },
				{ stable: true },
				{ stable: false },
			],
		});

		expect(plan.anthropic.breakpoints).toEqual([
			{
				segmentIndex: 1,
				segmentHash: "s1",
				ttl: "short",
				cacheControl: { type: "ephemeral" },
			},
		]);
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

	it("emits conversationId on providerOptions.eliza when provided", () => {
		const plan = buildProviderCachePlan({
			prefixHash: "abc123",
			conversationId: "room-1",
		});
		expect(plan.providerOptions.eliza).toMatchObject({
			conversationId: "room-1",
			promptCacheKey: "v5:abc123",
		});
	});

	it("omits conversationId when blank or unset", () => {
		const noneProvided = buildProviderCachePlan({ prefixHash: "abc" });
		expect(noneProvided.providerOptions.eliza).not.toHaveProperty(
			"conversationId",
		);
		const empty = buildProviderCachePlan({
			prefixHash: "abc",
			conversationId: "",
		});
		expect(empty.providerOptions.eliza).not.toHaveProperty("conversationId");
	});

	it("forwards stable promptSegments on providerOptions.eliza for local backends", () => {
		const plan = buildProviderCachePlan({
			prefixHash: "abc123",
			promptSegments: [
				{ content: "system: stable", stable: true } as unknown as {
					stable?: boolean;
				},
				{ content: "now: timestamp", stable: false } as unknown as {
					stable?: boolean;
				},
			],
		});
		const eliza = plan.providerOptions.eliza as Record<string, unknown>;
		expect(eliza.promptSegments).toEqual([
			{ content: "system: stable", stable: true },
			{ content: "now: timestamp", stable: false },
		]);
	});
});

describe("ProviderCachePlan edge branches", () => {
	it("keeps keys at the cap intact and truncates longer ones after the v5: prefix", () => {
		expect(buildPromptCacheKey("")).toBe("v5:");
		const exact = buildPromptCacheKey("y".repeat(1021));
		expect(exact).toBe(`v5:${"y".repeat(1021)}`);
		const over = buildPromptCacheKey("z".repeat(1022));
		expect(over).toHaveLength(1024);
		expect(over.slice(3)).toBe("z".repeat(1021));
	});

	it("treats any google/gemini model as Gemini regardless of case or provider slot", () => {
		const upperModelOnly = buildProviderCachePlan({
			prefixHash: "h",
			model: "GEMINI-2.5-Flash",
			hasTools: true,
			promptSegments: [{ stable: true }],
		});
		expect(upperModelOnly.providerOptions).not.toHaveProperty("anthropic");
		expect(upperModelOnly.anthropic.cacheSystem).toBe(false);
		expect(upperModelOnly.anthropic.breakpoints).toEqual([]);
		expect(upperModelOnly.anthropic.maxBreakpoints).toBe(4);
		expect(upperModelOnly.warnings).toEqual([
			"Gemini explicit caching is disabled when tools are present; relying on implicit/provider caching.",
		]);
	});

	it("keeps Anthropic cache markers for Gemini providers unless tools are present", () => {
		const withoutTools = buildProviderCachePlan({
			prefixHash: "h",
			provider: "google",
			model: "gemini-3-pro",
			hasTools: false,
			promptSegments: [{ stable: true }],
		});
		expect(withoutTools.anthropic.cacheSystem).toBe(true);
		expect(withoutTools.providerOptions).toHaveProperty("anthropic");
		expect(withoutTools.warnings).toEqual([]);
	});

	it("resolves OpenAI retention through namespace, case, and version suffixes", () => {
		const namespaced = buildProviderCachePlan({
			prefixHash: "h",
			model: "openrouter/openai/gpt-5.1-codex-mini",
		});
		expect(namespaced.providerOptions.openai).toEqual({
			promptCacheKey: "v5:h",
			promptCacheRetention: "24h",
		});
		const suffixed = buildProviderCachePlan({
			prefixHash: "h",
			model: "gpt-5.4:2026-01-01",
		});
		expect(suffixed.providerOptions.openai).toEqual({
			promptCacheKey: "v5:h",
			promptCacheRetention: "24h",
		});
	});

	it("drops sections that are not cacheable, not stable, or lack an integer segmentIndex", () => {
		const plan = buildProviderCachePlan({
			prefixHash: "h",
			sections: [
				{ id: "kept", segmentIndex: 2 },
				{ id: "uncacheable", segmentIndex: 0, cacheable: false },
				{ id: "unstable", segmentIndex: 1, stable: false },
				{ id: "fractional", segmentIndex: 1.5 },
				{ id: "missing-index" },
			],
		});
		expect(plan.anthropic.breakpoints).toEqual([
			{
				id: "kept",
				segmentIndex: 2,
				ttl: "short",
				cacheControl: { type: "ephemeral" },
			},
		]);
	});

	it("caps selected sections by priority then reports them in segment order", () => {
		const plan = buildProviderCachePlan({
			prefixHash: "h",
			segmentHashes: ["h0", "h1", "h2", "h3", "h4"],
			promptSegments: [{ stable: true }, { stable: true }],
			sections: [
				{ id: "a", segmentIndex: 0, priority: 50 },
				{ id: "e", segmentIndex: 1, priority: 10 },
				{ id: "c", segmentIndex: 2, priority: 30 },
				{ id: "d", segmentIndex: 3, priority: 20 },
				{ id: "b", segmentIndex: 4, priority: 40 },
			],
		});
		expect(
			plan.anthropic.breakpoints.map((breakpoint) => breakpoint.id),
		).toEqual(["a", "c", "b"]);
		expect(
			plan.anthropic.breakpoints.map((breakpoint) => breakpoint.segmentHash),
		).toEqual(["h0", "h2", "h4"]);
	});

	it("prefers an explicit section segmentHash and leaves out-of-range lookups undefined", () => {
		const plan = buildProviderCachePlan({
			prefixHash: "h",
			segmentHashes: ["only-0"],
			sections: [
				{ id: "explicit", segmentIndex: 0, segmentHash: "own-hash" },
				{ id: "beyond", segmentIndex: 3 },
			],
		});
		expect(
			plan.anthropic.breakpoints.map((breakpoint) => breakpoint.segmentHash),
		).toEqual(["own-hash", undefined]);
	});

	it("keeps only the first three stable runs and warns when more exist", () => {
		const plan = buildProviderCachePlan({
			prefixHash: "h",
			promptSegments: [
				{ stable: true },
				{ stable: false },
				{ stable: true },
				{ stable: false },
				{ stable: true },
				{ stable: false },
				{ stable: true },
			],
		});
		expect(
			plan.anthropic.breakpoints.map((breakpoint) => breakpoint.segmentIndex),
		).toEqual([0, 2, 4]);
		expect(plan.warnings).toContain(
			"Anthropic cache markers capped at 3 prompt segments plus system.",
		);
	});

	it("returns no breakpoints and no warnings for empty or never-stable segments", () => {
		const empty = buildProviderCachePlan({
			prefixHash: "h",
			promptSegments: [],
		});
		expect(empty.anthropic.breakpoints).toEqual([]);
		expect(empty.warnings).toEqual([]);

		const noneStable = buildProviderCachePlan({
			prefixHash: "h",
			promptSegments: [{ stable: false }, {}],
		});
		expect(noneStable.anthropic.breakpoints).toEqual([]);
		expect(noneStable.warnings).toEqual([]);
	});

	it("rejects invalid segment content instead of dropping model input", () => {
		for (const promptSegments of [
			[{ content: "keep", stable: true }, { content: 42, stable: true }, {}],
			[{ content: 42 }],
		]) {
			expect(() =>
				buildProviderCachePlan({
					prefixHash: "h",
					promptSegments: promptSegments as unknown as {
						stable?: boolean;
					}[],
				}),
			).toThrowError(
				expect.objectContaining({
					code: "PROVIDER_CACHE_PROMPT_SEGMENT_INVALID",
				}),
			);
		}
	});

	it("omits an explicitly empty prompt segment list", () => {
		const emptyList = buildProviderCachePlan({
			prefixHash: "h",
			promptSegments: [],
		});
		expect(emptyList.providerOptions.eliza).not.toHaveProperty(
			"promptSegments",
		);
	});

	it("mirrors top-level anthropic summary fields into providerOptions.anthropic", () => {
		const plan = buildProviderCachePlan({
			prefixHash: "h",
			promptSegments: [{ stable: true }],
		});
		const anthropic = plan.providerOptions.anthropic as Record<string, unknown>;
		expect(anthropic.cacheBreakpoints).toBe(plan.anthropic.breakpoints);
		expect(anthropic.cacheControl).toEqual({ type: "ephemeral" });
		expect(anthropic.cacheSystem).toBe(true);
		expect(anthropic.maxBreakpoints).toBe(4);
	});
});
