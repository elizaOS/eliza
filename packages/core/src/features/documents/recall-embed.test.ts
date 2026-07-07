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
const MSG_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const MSG_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

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

/**
 * A runtime whose run state is mutable: `getCurrentRunId` throws while no run is
 * active and returns the set id once `setRun` is called. The throw exercises the
 * defensive `runId=""` branch (some runtime shapes/tests have no run in scope);
 * the real `AgentRuntime` instead lazily mints a transient id — that auto-mint
 * transition is covered separately. Both reach the same messageId-keyed slot.
 */
function makeControllableRuntime(
	embed: (params: { text: string }) => Promise<number[]>,
): {
	runtime: IAgentRuntime;
	calls: { count: number };
	setRun: (runId: string | null) => void;
} {
	const state: { runId: string | null } = { runId: null };
	const calls = { count: 0 };
	const runtime = createMockRuntime({
		getCurrentRunId: () => {
			if (state.runId === null) {
				throw new Error("no active run");
			}
			return state.runId;
		},
		useModel: (type: string, params: { text: string }) => {
			if (type !== ModelType.TEXT_EMBEDDING) {
				throw new Error(`unexpected model ${type}`);
			}
			calls.count++;
			return embed(params);
		},
	});
	return {
		runtime,
		calls,
		setRun: (runId) => {
			state.runId = runId;
		},
	};
}

/** Yield a macrotask so the detached in-flight-cleanup `.finally` settles —
 * mirrors the real gap between pre-run augmentation and the in-run prefetch. */
const yieldMacrotask = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));

describe("embedRecallQuery — pre-run messageId cache + in-run adoption (#15253)", () => {
	test("pre-run embed caches by messageId, the in-run prefetch adopts it, and later runId-only callers share the slot — one embed for the whole turn", async () => {
		const { runtime, calls, setRun } = makeControllableRuntime(async () => [
			0.9,
		]);

		// 1) Pre-run augmentation: getCurrentRunId throws → key by messageId.
		const preRun = await embedRecallQuery(runtime, "same text", {
			messageId: MSG_A,
		});
		expect(preRun).toEqual([0.9]);
		expect(calls.count).toBe(1);

		// 2) In-run TTFT prefetch: same messageId, now with a live run → adopts the
		//    pre-run slot and resolves from cache, no new embed.
		setRun(RUN_A);
		const prefetch = await embedRecallQuery(runtime, "same text", {
			messageId: MSG_A,
		});
		expect(prefetch).toEqual([0.9]);
		expect(calls.count).toBe(1);

		// 3) Compose-time recall caller (relevant-conversations / document recall):
		//    runId only, no messageId. The adopted slot now carries RUN_A → hit.
		const composeTime = await embedRecallQuery(runtime, "same text");
		expect(composeTime).toEqual([0.9]);
		expect(calls.count).toBe(1);
	});

	test("real runtime shape: a transient pre-run runId replaced by startRun still unifies to one embed via messageId adoption", async () => {
		// `AgentRuntime.getCurrentRunId()` lazily mints a run id, so the pre-run
		// augmentation embed lands under a transient id (R_AUG) that `startRun`
		// then replaces with the turn's real id (RUN_A). Without the messageId key,
		// the in-run prefetch would miss R_AUG's slot and re-embed. Model exactly
		// that id transition (no throwing — the real runtime never throws here).
		const R_AUG = "99999999-9999-9999-9999-999999999999";
		let runId = R_AUG;
		const calls = { count: 0 };
		const runtime = createMockRuntime({
			getCurrentRunId: () => runId,
			useModel: (type: string, _params: { text: string }) => {
				if (type !== ModelType.TEXT_EMBEDDING) {
					throw new Error(`unexpected model ${type}`);
				}
				calls.count++;
				return Promise.resolve([0.7]);
			},
		});

		// Augmentation embeds under the transient R_AUG, keyed by messageId.
		await embedRecallQuery(runtime, "same text", { messageId: MSG_A });
		expect(calls.count).toBe(1);

		// startRun replaces the run id; the prefetch presents the same messageId
		// and adopts the R_AUG slot, re-stamping it with RUN_A.
		runId = RUN_A;
		await embedRecallQuery(runtime, "same text", { messageId: MSG_A });
		expect(calls.count).toBe(1);

		// Compose-time recall callers key off runId only and now hit the adopted
		// slot — no second embed for the whole turn.
		await embedRecallQuery(runtime, "same text");
		expect(calls.count).toBe(1);
	});

	test("adoption does not leak across turns: a new turn (different runId + messageId) re-embeds", async () => {
		const { runtime, calls, setRun } = makeControllableRuntime(async () => [
			0.1,
		]);
		await embedRecallQuery(runtime, "text one", { messageId: MSG_A });
		setRun(RUN_A);
		await embedRecallQuery(runtime, "text one", { messageId: MSG_A });
		expect(calls.count).toBe(1);

		// Next turn: fresh run + message → fresh cache → new embed.
		setRun(RUN_B);
		await embedRecallQuery(runtime, "text two", { messageId: MSG_B });
		expect(calls.count).toBe(2);
	});

	test("a concurrent second pre-run turn evicts the single slot; the first turn's in-run call re-embeds (a miss, never a wrong vector)", async () => {
		const { runtime, calls, setRun } = makeControllableRuntime(async () => [
			0.2,
		]);
		// Two pre-run turns warm the single cache slot in sequence; the second
		// replaces the first (single-slot per runtime, unchanged semantics).
		await embedRecallQuery(runtime, "turn one query", { messageId: MSG_A });
		await embedRecallQuery(runtime, "turn two query", { messageId: MSG_B });
		expect(calls.count).toBe(2);

		// Turn one now runs in-run: its messageId no longer matches the slot
		// (occupied by MSG_B) → fresh cache → re-embed. Correct: a cache miss,
		// never MSG_B's vector attributed to turn one.
		setRun(RUN_A);
		await embedRecallQuery(runtime, "turn one query", { messageId: MSG_A });
		expect(calls.count).toBe(3);
	});

	test("a runId-only caller never adopts a pre-run slot without a messageId match (no mis-promotion)", async () => {
		const { runtime, calls, setRun } = makeControllableRuntime(async () => [
			0.3,
		]);
		// Pre-run cache under {runId:"", messageId: MSG_A}.
		await embedRecallQuery(runtime, "query", { messageId: MSG_A });
		expect(calls.count).toBe(1);

		// An in-run caller with a live run but NO messageId must not promote the
		// pre-run slot into its turn: fresh cache → new embed.
		setRun(RUN_A);
		await embedRecallQuery(runtime, "query");
		expect(calls.count).toBe(2);
	});

	test("a failed pre-run embed is not cached across the boundary: the in-run caller re-embeds", async () => {
		let shouldFail = true;
		const { runtime, calls, setRun } = makeControllableRuntime(async () => {
			if (shouldFail) {
				throw new Error("embeddings endpoint 500");
			}
			return [0.4];
		});
		const preRun = await embedRecallQuery(runtime, "query", {
			messageId: MSG_A,
		});
		expect(preRun).toBeNull();
		expect(calls.count).toBe(1);

		// Let the detached in-flight cleanup settle (as real time would).
		await yieldMacrotask();

		// The failed embed left nothing cached; the in-run caller issues a fresh
		// round-trip (which now succeeds) rather than replaying the failure.
		shouldFail = false;
		setRun(RUN_A);
		const inRun = await embedRecallQuery(runtime, "query", {
			messageId: MSG_A,
		});
		expect(inRun).toEqual([0.4]);
		expect(calls.count).toBe(2);
	});

	test("a caller with neither a run nor a messageId stays uncached: two identical calls issue two embeds", async () => {
		const { runtime, calls } = makeControllableRuntime(async () => [0.5]);
		// getCurrentRunId throws (no run) and no messageId → direct, uncached embed.
		await embedRecallQuery(runtime, "background query");
		await embedRecallQuery(runtime, "background query");
		expect(calls.count).toBe(2);
	});

	test("in-flight dedupe spans the pre-run/in-run boundary: a pre-run embed and an in-run adopt of the same messageId share one round-trip", async () => {
		let resolveEmbed: ((v: number[]) => void) | undefined;
		const { runtime, calls, setRun } = makeControllableRuntime(
			() =>
				new Promise<number[]>((resolve) => {
					resolveEmbed = resolve;
				}),
		);
		// Pre-run embed starts and stays in flight.
		const preRun = embedRecallQuery(runtime, "same text", { messageId: MSG_A });
		expect(calls.count).toBe(1);

		// The in-run prefetch adopts the slot and joins the in-flight promise
		// before it resolves — no second round-trip.
		setRun(RUN_A);
		const prefetch = embedRecallQuery(runtime, "same text", {
			messageId: MSG_A,
		});
		expect(calls.count).toBe(1);

		resolveEmbed?.([1, 1, 1]);
		const [a, b] = await Promise.all([preRun, prefetch]);
		expect(a).toEqual([1, 1, 1]);
		expect(b).toEqual([1, 1, 1]);
		expect(calls.count).toBe(1);
	});
});
