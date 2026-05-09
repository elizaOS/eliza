import { describe, expect, it } from "vitest";
import { cacheProviderOptions } from "../planner-loop";

describe("cacheProviderOptions — universal cache directives", () => {
	const HASH = "abc123def456";

	it("emits options for eliza, cerebras, openai, anthropic, openrouter, and gateway", () => {
		const opts = cacheProviderOptions({ prefixHash: HASH });
		expect(opts).toHaveProperty("eliza");
		expect(opts).toHaveProperty("cerebras");
		expect(opts).toHaveProperty("openai");
		expect(opts).toHaveProperty("anthropic");
		expect(opts).toHaveProperty("openrouter");
		expect(opts).toHaveProperty("gateway");
	});

	it("eliza carries promptCacheKey and prefixHash", () => {
		const opts = cacheProviderOptions({ prefixHash: HASH });
		const eliza = opts.eliza as Record<string, unknown>;
		expect(typeof eliza.promptCacheKey).toBe("string");
		expect((eliza.promptCacheKey as string).length).toBeGreaterThan(0);
		expect(eliza.prefixHash).toBe(HASH);
	});

	it("cerebras carries promptCacheKey (camelCase) and prompt_cache_key (snake_case)", () => {
		const opts = cacheProviderOptions({ prefixHash: HASH });
		const cerebras = opts.cerebras as Record<string, unknown>;
		expect(typeof cerebras.promptCacheKey).toBe("string");
		expect(typeof cerebras.prompt_cache_key).toBe("string");
		expect(cerebras.promptCacheKey).toBe(cerebras.prompt_cache_key);
	});

	it("openai carries promptCacheKey without unsafe retention by default", () => {
		const opts = cacheProviderOptions({ prefixHash: HASH });
		const openai = opts.openai as Record<string, unknown>;
		expect(typeof openai.promptCacheKey).toBe("string");
		expect(openai).not.toHaveProperty("promptCacheRetention");
	});

	it("openai carries promptCacheRetention=24h for documented extended-retention models", () => {
		const opts = cacheProviderOptions({ prefixHash: HASH, model: "gpt-5.4" });
		const openai = opts.openai as Record<string, unknown>;
		expect(typeof openai.promptCacheKey).toBe("string");
		expect(openai.promptCacheRetention).toBe("24h");
	});

	it("anthropic carries cacheControl with type=ephemeral — always-on, no env required", () => {
		const opts = cacheProviderOptions({ prefixHash: HASH });
		const anthropic = opts.anthropic as Record<string, unknown>;
		const cacheControl = anthropic.cacheControl as Record<string, unknown>;
		expect(cacheControl).toBeDefined();
		expect(cacheControl.type).toBe("ephemeral");
	});

	it("openrouter carries promptCacheKey for prefix routing", () => {
		const opts = cacheProviderOptions({ prefixHash: HASH });
		const openrouter = opts.openrouter as Record<string, unknown>;
		expect(typeof openrouter.promptCacheKey).toBe("string");
		expect((openrouter.promptCacheKey as string).length).toBeGreaterThan(0);
	});

	it("gateway carries caching=auto", () => {
		const opts = cacheProviderOptions({ prefixHash: HASH });
		const gateway = opts.gateway as Record<string, unknown>;
		expect(gateway.caching).toBe("auto");
	});

	it("promptCacheKey is deterministic from the same prefixHash", () => {
		const opts1 = cacheProviderOptions({ prefixHash: HASH });
		const opts2 = cacheProviderOptions({ prefixHash: HASH });
		const key1 = (opts1.eliza as Record<string, unknown>).promptCacheKey;
		const key2 = (opts2.eliza as Record<string, unknown>).promptCacheKey;
		expect(key1).toBe(key2);
	});

	it("promptCacheKey differs for different prefixHashes", () => {
		const opts1 = cacheProviderOptions({ prefixHash: "hash-a" });
		const opts2 = cacheProviderOptions({ prefixHash: "hash-b" });
		const key1 = (opts1.eliza as Record<string, unknown>).promptCacheKey;
		const key2 = (opts2.eliza as Record<string, unknown>).promptCacheKey;
		expect(key1).not.toBe(key2);
	});

	it("promptCacheKey is at most 1024 characters", () => {
		const longHash = "x".repeat(2000);
		const opts = cacheProviderOptions({ prefixHash: longHash });
		const key = (opts.eliza as Record<string, unknown>)
			.promptCacheKey as string;
		expect(key.length).toBeLessThanOrEqual(1024);
	});

	it("includes segmentHashes in eliza options when provided", () => {
		const segmentHashes = ["seg1", "seg2", "seg3"];
		const opts = cacheProviderOptions({ prefixHash: HASH, segmentHashes });
		const eliza = opts.eliza as Record<string, unknown>;
		expect(eliza.segmentHashes).toEqual(segmentHashes);
	});

	it("omits segmentHashes from eliza options when not provided", () => {
		const opts = cacheProviderOptions({ prefixHash: HASH });
		const eliza = opts.eliza as Record<string, unknown>;
		expect(eliza).not.toHaveProperty("segmentHashes");
	});
});
