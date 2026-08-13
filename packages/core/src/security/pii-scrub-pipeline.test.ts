/**
 * Contract tests for the production PII scrub pipeline using deterministic
 * cache, map-store, and model doubles. They verify tier-0 removal, async mode,
 * durable write ordering, and direct-call idempotency without external I/O.
 */

import { describe, expect, test, vi } from "vitest";
import type { PiiScrubResult } from "../types/model.js";
import { ModelType } from "../types/model.js";
import type { IAgentRuntime } from "../types/runtime.js";
import type { PseudonymMapStore } from "./pii-pseudonym-map-store.js";
import { scrubMarkerKeyForContent } from "./pii-scrub-markers.js";
import {
	applyScrubWriteBack,
	enqueuePiiScrub,
	mineTier0Candidates,
	runPiiScrubPipeline,
} from "./pii-scrub-pipeline.js";

const RULESET = "2026.08";

test("re-detects structured PII introduced or normalized by a whole-text rewrite", () => {
	const original = "card 4111 1111 1111 1111";
	const rewritten = applyScrubWriteBack(
		original,
		[{ span: "4111 1111 1111 1111" }],
		[
			{
				span: original,
				kind: "pii",
				replacement: "card 4111111111111111",
			},
		],
	);
	expect(rewritten).toBe("card [REDACTED]");
});

function makeMapStore(): PseudonymMapStore {
	return {
		load: vi.fn(async () => null),
		save: vi.fn(async () => {}),
	};
}

function makeRuntime(modelResult?: PiiScrubResult) {
	const cache = new Map<string, unknown>();
	const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
	let modelCalls = 0;
	const runtime = {
		agentId: "00000000-0000-0000-0000-000000000001",
		getCache: async <T>(key: string): Promise<T | undefined> =>
			cache.get(key) as T | undefined,
		setCache: async <T>(key: string, value: T): Promise<boolean> => {
			cache.set(key, value);
			return true;
		},
		getModel: (type: string) =>
			type === ModelType.PII_SCRUB && modelResult
				? async () => modelResult
				: undefined,
		useModel: async () => {
			modelCalls++;
			if (!modelResult) throw new Error("unexpected model call");
			return modelResult;
		},
		emitEvent: async (type: string, payload: Record<string, unknown>) => {
			events.push({ type, payload });
		},
	} as unknown as IAgentRuntime;
	return { runtime, cache, events, modelCalls: () => modelCalls };
}

describe("runPiiScrubPipeline", () => {
	test("removes tier-0 payment-card spans and writes before the done marker", async () => {
		const content = "pay 4111 1111 1111 1111 today";
		const { runtime, cache } = makeRuntime();
		const order: string[] = [];
		const originalSetCache = runtime.setCache.bind(runtime);
		runtime.setCache = async (key, value) => {
			order.push("marker");
			return originalSetCache(key, value);
		};

		const result = await runPiiScrubPipeline(
			runtime,
			{
				content,
				itemRef: "memory:card",
				candidates: mineTier0Candidates(content),
				writeBack: async (text) => {
					order.push("writeBack");
					expect(text).not.toContain("4111");
				},
			},
			{ rulesetVersion: RULESET, mapStore: makeMapStore() },
		);

		expect(result.scrubbedText).toBe("pay [REDACTED] today");
		expect(result.modelId).toBe("tier0");
		expect(order).toEqual(["writeBack", "marker"]);
		expect(
			cache.has(scrubMarkerKeyForContent(content, RULESET, "memory:card")),
		).toBe(true);
	});

	test("async mode builds a rails payload without running paid inference", async () => {
		const content = "met Jordan Rivers";
		const modelResult: PiiScrubResult = {
			modelId: "local-test",
			rulesetVersion: RULESET,
			verdicts: [
				{ span: "Jordan Rivers", kind: "pii", replacement: "Person 1" },
			],
		};
		const { runtime, modelCalls } = makeRuntime(modelResult);
		const writeBack = vi.fn(async () => {});

		const result = await runPiiScrubPipeline(
			runtime,
			{
				content,
				itemRef: "memory:name",
				candidates: [{ surfaceForm: "Jordan Rivers", kind: "person" }],
				writeBack,
			},
			{
				rulesetVersion: RULESET,
				mapStore: makeMapStore(),
				applyWriteBack: false,
			},
		);

		expect(modelCalls()).toBe(0);
		expect(writeBack).not.toHaveBeenCalled();
		expect(result.scrubbedText).toBe(content);
		expect(result.railsPayload?.writeBack).toBe(writeBack);
	});

	test("a completed direct call is idempotent and does not repeat inference", async () => {
		const content = "met Jordan Rivers";
		const modelResult: PiiScrubResult = {
			modelId: "local-test",
			rulesetVersion: RULESET,
			verdicts: [
				{ span: "Jordan Rivers", kind: "pii", replacement: "Person 1" },
			],
		};
		const { runtime, modelCalls } = makeRuntime(modelResult);
		const item = {
			content,
			itemRef: "memory:name",
			candidates: [{ surfaceForm: "Jordan Rivers", kind: "person" }],
			writeBack: vi.fn(async () => {}),
		};
		const options = { rulesetVersion: RULESET, mapStore: makeMapStore() };

		const first = await runPiiScrubPipeline(runtime, item, options);
		const second = await runPiiScrubPipeline(runtime, item, options);

		expect(first.scrubbedText).toBe("met Person 1");
		expect(second.skipped).toBe(true);
		expect(modelCalls()).toBe(1);
		expect(item.writeBack).toHaveBeenCalledTimes(1);
	});

	test("identical content in a second source still performs its write-back", async () => {
		const content = "met Jordan Rivers";
		const modelResult: PiiScrubResult = {
			modelId: "local-test",
			rulesetVersion: RULESET,
			verdicts: [
				{ span: "Jordan Rivers", kind: "pii", replacement: "Person 1" },
			],
		};
		const { runtime, modelCalls } = makeRuntime(modelResult);
		const firstWriteBack = vi.fn(async () => {});
		const secondWriteBack = vi.fn(async () => {});
		const options = { rulesetVersion: RULESET, mapStore: makeMapStore() };

		await runPiiScrubPipeline(
			runtime,
			{
				content,
				itemRef: "memory:a",
				candidates: [{ surfaceForm: "Jordan Rivers", kind: "person" }],
				writeBack: firstWriteBack,
			},
			options,
		);
		await runPiiScrubPipeline(
			runtime,
			{
				content,
				itemRef: "memory:b",
				candidates: [{ surfaceForm: "Jordan Rivers", kind: "person" }],
				writeBack: secondWriteBack,
			},
			options,
		);

		expect(modelCalls()).toBe(2);
		expect(firstWriteBack).toHaveBeenCalledOnce();
		expect(secondWriteBack).toHaveBeenCalledOnce();
	});

	test("write-back failure leaves the source unmarked for retry", async () => {
		const content = "pay 4111 1111 1111 1111 today";
		const { runtime, cache } = makeRuntime();

		await expect(
			runPiiScrubPipeline(
				runtime,
				{
					content,
					itemRef: "memory:card",
					candidates: mineTier0Candidates(content),
					writeBack: async () => {
						throw new Error("disk unavailable");
					},
				},
				{ rulesetVersion: RULESET, mapStore: makeMapStore() },
			),
		).rejects.toThrow("disk unavailable");
		expect(
			cache.has(scrubMarkerKeyForContent(content, RULESET, "memory:card")),
		).toBe(false);
	});
});

describe("enqueuePiiScrub", () => {
	test("emits the payload-only request and preserves durable write-back", async () => {
		const content = "pay 4111 1111 1111 1111";
		const { runtime, events, modelCalls } = makeRuntime();
		const writeBack = vi.fn(async () => {});

		await enqueuePiiScrub(
			runtime,
			{
				content,
				itemRef: "memory:card",
				candidates: mineTier0Candidates(content),
				writeBack,
			},
			{ rulesetVersion: RULESET, mapStore: makeMapStore() },
		);

		expect(modelCalls()).toBe(0);
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("PII_SCRUB_REQUESTED");
		expect(events[0].payload.writeBack).toBe(writeBack);
	});
});
