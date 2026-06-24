import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { IAgentRuntime } from "../../types";
import { ModelType } from "../../types";
import { embedRecallQuery, RECALL_EMBED_TIMEOUT_MS } from "./recall-embed.ts";

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
	const runtime = {
		getCurrentRunId: () => opts.runId ?? RUN_A,
		useModel: (type: string, params: { text: string }) => {
			if (type !== ModelType.TEXT_EMBEDDING) {
				throw new Error(`unexpected model ${type}`);
			}
			calls.count++;
			return opts.embed(params);
		},
	} as unknown as IAgentRuntime;
	return { runtime, calls };
}

describe("embedRecallQuery — timeout / fail-open (item 1)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("returns the vector when the embed resolves before the timeout", async () => {
		const { runtime } = makeRuntime({
			embed: async () => [0.1, 0.2, 0.3],
		});
		const vec = await embedRecallQuery(runtime, "hello world");
		expect(vec).toEqual([0.1, 0.2, 0.3]);
	});

	test("a slow embed exceeding the timeout fails open (returns null) — caller falls back to BM25, reply not blocked", async () => {
		const { runtime } = makeRuntime({
			// Never resolves within the timeout window.
			embed: () =>
				new Promise((resolve) => {
					setTimeout(() => resolve([1, 2, 3]), RECALL_EMBED_TIMEOUT_MS * 10);
				}),
		});
		const promise = embedRecallQuery(runtime, "slow query");
		// Advance past the recall-embed timeout; the race should resolve to null.
		await vi.advanceTimersByTimeAsync(RECALL_EMBED_TIMEOUT_MS + 1);
		await expect(promise).resolves.toBeNull();
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

	test("a new turn (different runId) does NOT reuse the prior turn's cache", async () => {
		let runId = RUN_A;
		const calls = { count: 0 };
		const runtime = {
			getCurrentRunId: () => runId,
			useModel: (_type: string, _params: { text: string }) => {
				calls.count++;
				return Promise.resolve([0.1]);
			},
		} as unknown as IAgentRuntime;

		await embedRecallQuery(runtime, "shared query");
		expect(calls.count).toBe(1);

		runId = RUN_B;
		await embedRecallQuery(runtime, "shared query");
		// New turn → fresh cache → a second embed call.
		expect(calls.count).toBe(2);
	});
});
