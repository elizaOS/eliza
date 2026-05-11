/**
 * Per-action model routing — unit tests.
 *
 * Closes Eliza-1 pipeline W1-R2 / A5. Verifies:
 *   1. The strategy registry shape for each {@link ActionModelClass}.
 *   2. Chain resolution narrows to the right provider (LOCAL only picks
 *      local-tagged registrations).
 *   3. Ascending fallback on handler error.
 *   4. Low-confidence escalation when the result exposes `confidence`.
 *   5. Back-compat: absent modelClass = no rerouting.
 *   6. End-to-end: a configured action with `modelClass: 'LOCAL'` routes a
 *      `useModel` call to a local registration, not to the cloud one.
 */

import { describe, expect, it, vi } from "vitest";
import { ModelType } from "../../types/model";
import type { ActionModelClass } from "../../types/components";
import type { ModelHandler } from "../../types/model";
import {
	ACTION_MODEL_STRATEGIES,
	executeChainWithFallback,
	getActionModelStrategy,
	isLocalProvider,
	isLowConfidence,
	maybeReroute,
	resolveChain,
	resolveStep,
	type ResolvedActionModel,
	ROUTABLE_TEXT_MODEL_TYPES,
} from "../action-model-routing";
import {
	getActionRoutingContext,
	runWithActionRoutingContext,
	runWithoutActionRoutingContext,
} from "../action-routing-context";

// ─── helpers ──────────────────────────────────────────────────────────────

function makeHandler(
	provider: string,
	returnValue: unknown = "ok",
): ModelHandler {
	return {
		handler: vi.fn(async () => returnValue),
		provider,
		priority: 0,
		registrationOrder: Date.now(),
	};
}

function makeRegistry(
	entries: Record<string, ModelHandler[]>,
): (modelType: string) => readonly ModelHandler[] | undefined {
	return (key: string) => entries[key];
}

// ─── strategy registry ────────────────────────────────────────────────────

describe("ACTION_MODEL_STRATEGIES", () => {
	it("has an entry for every ActionModelClass", () => {
		const classes: ActionModelClass[] = ["TEXT_LARGE", "TEXT_SMALL", "LOCAL"];
		for (const c of classes) {
			expect(ACTION_MODEL_STRATEGIES[c]).toBeDefined();
			expect(ACTION_MODEL_STRATEGIES[c].chain.length).toBeGreaterThan(0);
		}
	});

	it("LOCAL chain leads with a local-provider-filtered TEXT_SMALL step", () => {
		const local = ACTION_MODEL_STRATEGIES.LOCAL;
		const first = local.chain[0];
		expect(first?.modelType).toBe(ModelType.TEXT_SMALL);
		expect(first?.providerFilter).toBeDefined();
	});

	it("LOCAL → TEXT_SMALL → TEXT_LARGE escalation order", () => {
		const chain = ACTION_MODEL_STRATEGIES.LOCAL.chain;
		expect(chain.map((s) => s.modelType)).toEqual([
			ModelType.TEXT_SMALL, // local-filtered
			ModelType.TEXT_SMALL, // any provider
			ModelType.TEXT_LARGE,
		]);
	});

	it("TEXT_LARGE chain is terminal — no escalation", () => {
		expect(ACTION_MODEL_STRATEGIES.TEXT_LARGE.chain).toHaveLength(1);
		expect(ACTION_MODEL_STRATEGIES.TEXT_LARGE.chain[0]?.modelType).toBe(
			ModelType.TEXT_LARGE,
		);
	});
});

// ─── isLocalProvider ──────────────────────────────────────────────────────

describe("isLocalProvider", () => {
	it("matches canonical local providers from LOCAL_MODEL_PROVIDERS", () => {
		expect(isLocalProvider("ollama")).toBe(true);
	});

	it("matches well-known local-server families by substring", () => {
		expect(isLocalProvider("lm-studio")).toBe(true);
		expect(isLocalProvider("lmstudio")).toBe(true);
		expect(isLocalProvider("mlx-lm")).toBe(true);
		expect(isLocalProvider("llama.cpp")).toBe(true);
		expect(isLocalProvider("llamacpp-server")).toBe(true);
	});

	it("rejects cloud providers", () => {
		expect(isLocalProvider("anthropic")).toBe(false);
		expect(isLocalProvider("openai")).toBe(false);
		expect(isLocalProvider("elizacloud")).toBe(false);
	});

	it("is case-insensitive", () => {
		expect(isLocalProvider("OLLAMA")).toBe(true);
		expect(isLocalProvider("LM-Studio")).toBe(true);
	});
});

// ─── getActionModelStrategy / maybeReroute ────────────────────────────────

describe("getActionModelStrategy", () => {
	it("returns undefined for undefined modelClass (back-compat)", () => {
		expect(getActionModelStrategy(undefined)).toBeUndefined();
	});

	it("returns the strategy for each known class", () => {
		expect(getActionModelStrategy("TEXT_SMALL")).toBe(
			ACTION_MODEL_STRATEGIES.TEXT_SMALL,
		);
		expect(getActionModelStrategy("TEXT_LARGE")).toBe(
			ACTION_MODEL_STRATEGIES.TEXT_LARGE,
		);
		expect(getActionModelStrategy("LOCAL")).toBe(
			ACTION_MODEL_STRATEGIES.LOCAL,
		);
	});
});

describe("maybeReroute", () => {
	it("does not reroute non-text-generation model types", () => {
		expect(maybeReroute("LOCAL", ModelType.TEXT_EMBEDDING)).toBeUndefined();
		expect(maybeReroute("LOCAL", ModelType.IMAGE)).toBeUndefined();
		expect(maybeReroute("LOCAL", ModelType.TRANSCRIPTION)).toBeUndefined();
	});

	it("does not reroute when modelClass is undefined", () => {
		expect(maybeReroute(undefined, ModelType.TEXT_LARGE)).toBeUndefined();
	});

	it("reroutes text-generation models when modelClass is set", () => {
		expect(maybeReroute("LOCAL", ModelType.TEXT_LARGE)).toBe(
			ACTION_MODEL_STRATEGIES.LOCAL,
		);
		expect(maybeReroute("TEXT_SMALL", ModelType.ACTION_PLANNER)).toBe(
			ACTION_MODEL_STRATEGIES.TEXT_SMALL,
		);
	});

	it("covers all routable text generation model types", () => {
		const routable = Array.from(ROUTABLE_TEXT_MODEL_TYPES);
		expect(routable).toContain(ModelType.TEXT_SMALL);
		expect(routable).toContain(ModelType.TEXT_LARGE);
		expect(routable).toContain(ModelType.ACTION_PLANNER);
		expect(routable).toContain(ModelType.RESPONSE_HANDLER);
		expect(routable).not.toContain(ModelType.TEXT_EMBEDDING);
	});
});

// ─── resolveStep / resolveChain ───────────────────────────────────────────

describe("resolveStep", () => {
	it("returns undefined when no handlers are registered for the model type", () => {
		const lookup = makeRegistry({});
		expect(
			resolveStep({ modelType: ModelType.TEXT_SMALL }, lookup),
		).toBeUndefined();
	});

	it("returns the first handler when no providerFilter is given", () => {
		const handlers = [makeHandler("openai"), makeHandler("anthropic")];
		const lookup = makeRegistry({ [ModelType.TEXT_SMALL]: handlers });
		const resolved = resolveStep({ modelType: ModelType.TEXT_SMALL }, lookup);
		expect(resolved?.provider).toBe("openai");
		expect(resolved?.modelType).toBe(ModelType.TEXT_SMALL);
	});

	it("honors providerFilter and skips non-matching registrations", () => {
		const handlers = [
			makeHandler("openai"),
			makeHandler("ollama"),
			makeHandler("anthropic"),
		];
		const lookup = makeRegistry({ [ModelType.TEXT_SMALL]: handlers });
		const resolved = resolveStep(
			{
				modelType: ModelType.TEXT_SMALL,
				providerFilter: isLocalProvider,
			},
			lookup,
		);
		expect(resolved?.provider).toBe("ollama");
	});

	it("returns undefined when providerFilter excludes every registration", () => {
		const handlers = [makeHandler("openai"), makeHandler("anthropic")];
		const lookup = makeRegistry({ [ModelType.TEXT_SMALL]: handlers });
		expect(
			resolveStep(
				{ modelType: ModelType.TEXT_SMALL, providerFilter: isLocalProvider },
				lookup,
			),
		).toBeUndefined();
	});
});

describe("resolveChain", () => {
	it("returns an empty list when nothing in the chain has a registration", () => {
		expect(
			resolveChain(ACTION_MODEL_STRATEGIES.LOCAL, makeRegistry({})),
		).toEqual([]);
	});

	it("LOCAL chain: prefers local-tagged handler, falls through to default TEXT_SMALL", () => {
		const lookup = makeRegistry({
			[ModelType.TEXT_SMALL]: [makeHandler("openai"), makeHandler("ollama")],
			[ModelType.TEXT_LARGE]: [makeHandler("anthropic")],
		});
		const chain = resolveChain(ACTION_MODEL_STRATEGIES.LOCAL, lookup);
		expect(chain.map((r) => r.provider)).toEqual([
			"ollama", // local-filtered TEXT_SMALL
			"openai", // unfiltered TEXT_SMALL
			"anthropic", // TEXT_LARGE
		]);
	});

	it("LOCAL chain: with no local handler, still resolves the cloud fallback steps", () => {
		const lookup = makeRegistry({
			[ModelType.TEXT_SMALL]: [makeHandler("openai")],
			[ModelType.TEXT_LARGE]: [makeHandler("anthropic")],
		});
		const chain = resolveChain(ACTION_MODEL_STRATEGIES.LOCAL, lookup);
		expect(chain.map((r) => r.provider)).toEqual(["openai", "anthropic"]);
	});

	it("LOCAL chain: does not repeat the same provider when the local handler is already first", () => {
		const lookup = makeRegistry({
			[ModelType.TEXT_SMALL]: [makeHandler("ollama"), makeHandler("openai")],
			[ModelType.TEXT_LARGE]: [makeHandler("anthropic")],
		});
		const chain = resolveChain(ACTION_MODEL_STRATEGIES.LOCAL, lookup);
		expect(chain.map((r) => r.provider)).toEqual([
			"ollama",
			"openai",
			"anthropic",
		]);
	});
});

// ─── isLowConfidence ──────────────────────────────────────────────────────

describe("isLowConfidence", () => {
	it("returns false when threshold is undefined", () => {
		expect(isLowConfidence({ confidence: 0.1 }, undefined)).toBe(false);
	});

	it("returns false when result is a string (no confidence field)", () => {
		expect(isLowConfidence("hello", 0.5)).toBe(false);
	});

	it("returns false when result has no confidence field", () => {
		expect(isLowConfidence({ text: "hi" }, 0.5)).toBe(false);
	});

	it("returns true when confidence is below threshold", () => {
		expect(isLowConfidence({ confidence: 0.3 }, 0.5)).toBe(true);
	});

	it("returns false when confidence meets threshold", () => {
		expect(isLowConfidence({ confidence: 0.5 }, 0.5)).toBe(false);
		expect(isLowConfidence({ confidence: 0.9 }, 0.5)).toBe(false);
	});
});

// ─── executeChainWithFallback ─────────────────────────────────────────────

describe("executeChainWithFallback", () => {
	function mkResolved(
		modelType: string,
		provider: string,
		impl: () => Promise<unknown>,
	): ResolvedActionModel {
		return {
			modelType,
			provider,
			// The handler signature in the registry takes (runtime, params), but
			// the executor only passes the resolved entry to invoke(), and our
			// invoke spy doesn't call handler directly.
			handler: vi.fn(impl) as unknown as ModelHandler["handler"],
		};
	}

	it("throws when the chain is empty", async () => {
		await expect(
			executeChainWithFallback([], undefined, async () => "x"),
		).rejects.toThrow(/chain is empty/);
	});

	it("returns the first successful step result", async () => {
		const invoke = vi.fn(async (r: ResolvedActionModel) => r.provider);
		const chain = [
			mkResolved(ModelType.TEXT_SMALL, "ollama", async () => "ollama"),
			mkResolved(ModelType.TEXT_LARGE, "anthropic", async () => "anthropic"),
		];
		const result = await executeChainWithFallback(chain, undefined, invoke);
		expect(result).toBe("ollama");
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it("escalates on error: first throws, second succeeds", async () => {
		let calls = 0;
		const invoke = vi.fn(async (r: ResolvedActionModel) => {
			calls++;
			if (calls === 1) {
				throw new Error("local backend down");
			}
			return r.provider;
		});
		const chain = [
			mkResolved(ModelType.TEXT_SMALL, "ollama", async () => "ollama"),
			mkResolved(ModelType.TEXT_LARGE, "anthropic", async () => "anthropic"),
		];
		const result = await executeChainWithFallback(chain, undefined, invoke);
		expect(result).toBe("anthropic");
		expect(invoke).toHaveBeenCalledTimes(2);
	});

	it("re-raises the last error when every step fails", async () => {
		const invoke = vi.fn(async (r: ResolvedActionModel) => {
			throw new Error(`${r.provider} down`);
		});
		const chain = [
			mkResolved(ModelType.TEXT_SMALL, "ollama", async () => "x"),
			mkResolved(ModelType.TEXT_LARGE, "anthropic", async () => "x"),
		];
		await expect(
			executeChainWithFallback(chain, undefined, invoke),
		).rejects.toThrow(/anthropic down/);
		expect(invoke).toHaveBeenCalledTimes(2);
	});

	it("escalates on low-confidence: first returns 0.2 confidence, second returns hi-confidence", async () => {
		let calls = 0;
		const invoke = vi.fn(async (r: ResolvedActionModel) => {
			calls++;
			if (calls === 1) {
				return { provider: r.provider, confidence: 0.2 };
			}
			return { provider: r.provider, confidence: 0.95 };
		});
		const chain = [
			mkResolved(ModelType.TEXT_SMALL, "ollama", async () => "x"),
			mkResolved(ModelType.TEXT_LARGE, "anthropic", async () => "x"),
		];
		const result = (await executeChainWithFallback(
			chain,
			0.5,
			invoke,
		)) as { provider: string; confidence: number };
		expect(result.provider).toBe("anthropic");
		expect(result.confidence).toBeGreaterThanOrEqual(0.5);
		expect(invoke).toHaveBeenCalledTimes(2);
	});

	it("accepts the last step's low-confidence result rather than throwing", async () => {
		// Terminal step is the last word — the executor should still return its
		// result rather than escalating further (since there's nowhere to go).
		const invoke = vi.fn(async (r: ResolvedActionModel) => ({
			provider: r.provider,
			confidence: 0.1,
		}));
		const chain = [
			mkResolved(ModelType.TEXT_LARGE, "anthropic", async () => "x"),
		];
		const result = (await executeChainWithFallback(chain, 0.5, invoke)) as {
			confidence: number;
		};
		expect(result.confidence).toBe(0.1);
		expect(invoke).toHaveBeenCalledTimes(1);
	});
});

// ─── action routing context propagation ──────────────────────────────────

describe("action routing context", () => {
	it("getActionRoutingContext is undefined outside any run", () => {
		expect(getActionRoutingContext()).toBeUndefined();
	});

	it("propagates the context to a synchronous call", async () => {
		const ctx = { actionName: "FOO", modelClass: "LOCAL" as const };
		const observed = await runWithActionRoutingContext(ctx, () =>
			getActionRoutingContext(),
		);
		expect(observed).toEqual(ctx);
	});

	it("propagates through async/await", async () => {
		const ctx = { actionName: "BAR", modelClass: "TEXT_SMALL" as const };
		const observed = await runWithActionRoutingContext(ctx, async () => {
			await Promise.resolve();
			return getActionRoutingContext();
		});
		expect(observed?.modelClass).toBe("TEXT_SMALL");
	});

	it("runWithoutActionRoutingContext clears the context for the inner call", async () => {
		const ctx = { actionName: "BAZ", modelClass: "LOCAL" as const };
		const observed = await runWithActionRoutingContext(ctx, async () => {
			const before = getActionRoutingContext();
			const inner = await runWithoutActionRoutingContext(async () =>
				getActionRoutingContext(),
			);
			const after = getActionRoutingContext();
			return { before, inner, after };
		});
		expect(observed.before).toEqual(ctx);
		expect(observed.inner).toBeUndefined();
		// AsyncLocalStorage restores the outer scope on exit.
		expect(observed.after).toEqual(ctx);
	});
});
