/**
 * Unit tests for `embedRecallQuery`: it returns the embedding on success, fails
 * open to `null` on an embed error (never throwing onto the reply path), and
 * caches/dedupes identical normalized recall queries within a turn (including
 * across providers). Runs against `createMockRuntime` with a synchronous fake
 * embed model — deterministic, no live LLM.
 */
import { describe, expect, test } from "vitest";
import { createMockRuntime } from "../../testing/mock-runtime";
import type { IAgentRuntime } from "../../types";
import { ModelType } from "../../types";
import { embedRecallQuery } from "./recall-embed.ts";

const RUN_A = "11111111-1111-1111-1111-111111111111";
const RUN_B = "22222222-2222-2222-2222-222222222222";

interface RuntimeMockOpts {
	runId?: string;
	embed: (params: { text: string }) => Promise<number[]>;
}

function makeRuntime(opts: RuntimeMockOpts): {
	runtime: IAgentRuntime;
	calls: { count: number };
} {
	const calls = { count: 0 };
	const runtime = createMockRuntime({
		getCurrentRunId: () => opts.runId ?? RUN_A,
		useModel: (type: string, params: { text: string }) => {
			if (type !== ModelType.TEXT_EMBEDDING) {
				throw new Error(`unexpected model ${type}`);
			}
			calls.count++;
			return opts.embed(params);
		},
	});
	return { runtime, calls };
}

describe("embedRecallQuery — resolve / fail-open", () => {
	test("returns the vector when the embed resolves", async () => {
		const { runtime } = makeRuntime({
			embed: async () => [0.1, 0.2, 0.3],
		});
		const vec = await embedRecallQuery(runtime, "hello world");
		expect(vec).toEqual([0.1, 0.2, 0.3]);
	});

	test("awaits the full embed — a slow-but-resolving embed returns its real vector (no app-level race truncates it to a silent BM25 fallback)", async () => {
		const { runtime } = makeRuntime({
			embed: () =>
				new Promise((resolve) => {
					setTimeout(() => resolve([1, 2, 3]), 50);
				}),
		});
		// Recall richness is preserved: the vector is returned, not degraded to
		// keyword-only by an arbitrary timeout. A hung request is bounded by the
		// embedding model handler's own request timeout (which rejects → catch).
		await expect(embedRecallQuery(runtime, "slow query")).resolves.toEqual([
			1, 2, 3,
		]);
	});

	test("an embed error fails open (returns null), never throwing onto the reply path", async () => {
		const { runtime } = makeRuntime({
			embed: async () => {
				throw new Error("embeddings endpoint 500");
			},
		});
		await expect(embedRecallQuery(runtime, "boom")).resolves.toBeNull();
	});
});

describe("embedRecallQuery — per-turn cache + dedupe (item 2)", () => {
	test("repeated normalized text within a turn hits the cache (one embed call)", async () => {
		const { runtime, calls } = makeRuntime({
			embed: async () => [0.5],
		});

		const a = await embedRecallQuery(runtime, "What is the Refund Policy?");
		// Different whitespace + casing → same normalized key.
		const b = await embedRecallQuery(
			runtime,
			"  what is the   refund policy? ",
		);

		expect(a).toEqual([0.5]);
		expect(b).toEqual([0.5]);
		expect(calls.count).toBe(1);
	});

	test("concurrent identical embeds dedupe to a single in-flight call", async () => {
		let resolveEmbed: ((v: number[]) => void) | undefined;
		const { runtime, calls } = makeRuntime({
			embed: () =>
				new Promise<number[]>((resolve) => {
					resolveEmbed = resolve;
				}),
		});

		const p1 = embedRecallQuery(runtime, "same text");
		const p2 = embedRecallQuery(runtime, "same text");
		// Both started before either resolved → exactly one underlying call.
		expect(calls.count).toBe(1);

		resolveEmbed?.([7, 8, 9]);
		const [r1, r2] = await Promise.all([p1, p2]);
		expect(r1).toEqual([7, 8, 9]);
		expect(r2).toEqual([7, 8, 9]);
		expect(calls.count).toBe(1);
	});

	test("two DIFFERENT recall providers sharing one runtime + runId + text issue ONE underlying embed (cross-provider dedupe)", async () => {
		let resolveEmbed: ((v: number[]) => void) | undefined;
		const { runtime, calls } = makeRuntime({
			embed: () =>
				new Promise<number[]>((resolve) => {
					resolveEmbed = resolve;
				}),
		});

		// Simulate three providers (document recall, experience recall,
		// relevant-conversations) all embedding the same query in the same turn.
		// The first two race concurrently (in-flight dedupe); the third arrives
		// after the shared embed resolves (result-cache dedupe). Whitespace/casing
		// differences must still collapse to one normalized key.
		const documentRecall = embedRecallQuery(runtime, "What is the SLA?");
		const experienceRecall = embedRecallQuery(runtime, "what is the   sla?");
		expect(calls.count).toBe(1);

		resolveEmbed?.([0.4, 0.5, 0.6]);
		const [docVec, expVec] = await Promise.all([
			documentRecall,
			experienceRecall,
		]);

		const relevantConversations = await embedRecallQuery(
			runtime,
			"  WHAT IS THE SLA? ",
		);

		expect(docVec).toEqual([0.4, 0.5, 0.6]);
		expect(expVec).toEqual([0.4, 0.5, 0.6]);
		expect(relevantConversations).toEqual([0.4, 0.5, 0.6]);
		// One round-trip served all three providers for the turn.
		expect(calls.count).toBe(1);
	});

	test("a new turn (different runId) does NOT reuse the prior turn's cache", async () => {
		let runId = RUN_A;
		const calls = { count: 0 };
		const runtime = createMockRuntime({
			getCurrentRunId: () => runId,
			useModel: (_type: string, _params: { text: string }) => {
				calls.count++;
				return Promise.resolve([0.1]);
			},
		});

		await embedRecallQuery(runtime, "shared query");
		expect(calls.count).toBe(1);

		runId = RUN_B;
		await embedRecallQuery(runtime, "shared query");
		// New turn → fresh cache → a second embed call.
		expect(calls.count).toBe(2);
	});
});
