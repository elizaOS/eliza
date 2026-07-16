/**
 * Unit tests for `embedRecallQuery` + `aliasRecallQuery`: the embed returns the
 * vector on success, fails open to `null` on an embed error (never throwing
 * onto the reply path), and caches/dedupes identical normalized recall queries
 * within a turn (including across providers); the alias maps a rewritten
 * (document-augmented) prompt onto the clean prompt's cached or in-flight
 * vector so a rewrite never costs a second per-turn embed. Runs against
 * a real AgentRuntime with deterministic embedding API handlers registered
 * through the production model router.
 */
import { describe, expect, test } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import { ModelType } from "../../types";
import { aliasRecallQuery, embedRecallQuery } from "./recall-embed.ts";

const MSG_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const MSG_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

interface RuntimeMockOpts {
	embed: (params: { text: string }) => Promise<number[]>;
}

function makeRuntime(opts: RuntimeMockOpts): {
	runtime: AgentRuntime;
	calls: { count: number };
} {
	const calls = { count: 0 };
	const runtime = new AgentRuntime({
		character: {
			name: "RecallEmbedIntegrationAgent",
			bio: "Exercises recall embedding through the real model router.",
			settings: {},
		},
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
	runtime.registerModel(
		ModelType.TEXT_EMBEDDING,
		async (_runtime, params: { text: string }) => {
			calls.count++;
			return opts.embed(params);
		},
		"embedding-api-test",
		100,
	);
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

	test("a SYNCHRONOUSLY-throwing model handler also fails open — fire-and-forget callers never see an unhandled rejection", async () => {
		const { runtime } = makeRuntime({
			embed: () => {
				throw new Error("no TEXT_EMBEDDING handler registered");
			},
		});
		await expect(embedRecallQuery(runtime, "boom")).resolves.toBeNull();
	});

	test("a handler resolving to a non-array fails open to null, not a garbage value", async () => {
		const { runtime } = makeRuntime({
			embed: async () => undefined as never,
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
		await yieldMacrotask();
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
		await yieldMacrotask();
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
		const { runtime, calls } = makeRuntime({
			embed: async () => [0.1],
		});

		await embedRecallQuery(runtime, "shared query");
		expect(calls.count).toBe(1);

		runtime.startRun();
		await embedRecallQuery(runtime, "shared query");
		// New turn → fresh cache → a second embed call.
		expect(calls.count).toBe(2);
	});
});

function makeControllableRuntime(
	embed: (params: { text: string }) => Promise<number[]>,
): {
	runtime: AgentRuntime;
	calls: { count: number };
	startRun: () => void;
} {
	const { runtime, calls } = makeRuntime({ embed });
	return {
		runtime,
		calls,
		startRun: () => {
			runtime.startRun();
		},
	};
}

/** Yield a macrotask so the detached in-flight-cleanup `.finally` settles —
 * mirrors the real gap between pre-run augmentation and the in-run prefetch. */
const yieldMacrotask = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));

describe("embedRecallQuery — pre-run messageId cache + in-run adoption (#15253)", () => {
	test("pre-run embed caches by messageId, the in-run prefetch adopts it, and later runId-only callers share the slot — one embed for the whole turn", async () => {
		const { runtime, calls, startRun } = makeControllableRuntime(async () => [
			0.9,
		]);

		// 1) Pre-run augmentation: AgentRuntime lazily creates a transient run id.
		const preRun = await embedRecallQuery(runtime, "same text", {
			messageId: MSG_A,
		});
		expect(preRun).toEqual([0.9]);
		expect(calls.count).toBe(1);

		// 2) In-run TTFT prefetch: same messageId, now with a live run → adopts the
		//    pre-run slot and resolves from cache, no new embed.
		startRun();
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
		const { runtime, calls } = makeRuntime({
			embed: async () => [0.7],
		});

		// Augmentation embeds under the transient R_AUG, keyed by messageId.
		await embedRecallQuery(runtime, "same text", { messageId: MSG_A });
		expect(calls.count).toBe(1);

		// startRun replaces the run id; the prefetch presents the same messageId
		// and adopts the R_AUG slot, re-stamping it with RUN_A.
		runtime.startRun();
		await embedRecallQuery(runtime, "same text", { messageId: MSG_A });
		expect(calls.count).toBe(1);

		// Compose-time recall callers key off runId only and now hit the adopted
		// slot — no second embed for the whole turn.
		await embedRecallQuery(runtime, "same text");
		expect(calls.count).toBe(1);
	});

	test("adoption does not leak across turns: a new turn (different runId + messageId) re-embeds", async () => {
		const { runtime, calls, startRun } = makeControllableRuntime(async () => [
			0.1,
		]);
		await embedRecallQuery(runtime, "text one", { messageId: MSG_A });
		startRun();
		await embedRecallQuery(runtime, "text one", { messageId: MSG_A });
		expect(calls.count).toBe(1);

		// Next turn: fresh run + message → fresh cache → new embed.
		startRun();
		await embedRecallQuery(runtime, "text two", { messageId: MSG_B });
		expect(calls.count).toBe(2);
	});

	test("a runId-only caller never adopts a pre-run slot without a messageId match (no mis-promotion)", async () => {
		const { runtime, calls, startRun } = makeControllableRuntime(async () => [
			0.3,
		]);
		// Pre-run cache under {runId:"", messageId: MSG_A}.
		await embedRecallQuery(runtime, "query", { messageId: MSG_A });
		expect(calls.count).toBe(1);

		// An in-run caller with a live run but NO messageId must not promote the
		// pre-run slot into its turn: fresh cache → new embed.
		startRun();
		await embedRecallQuery(runtime, "query");
		expect(calls.count).toBe(2);
	});

	test("a failed pre-run embed is not cached across the boundary: the in-run caller re-embeds", async () => {
		let shouldFail = true;
		const { runtime, calls, startRun } = makeControllableRuntime(async () => {
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
		startRun();
		const inRun = await embedRecallQuery(runtime, "query", {
			messageId: MSG_A,
		});
		expect(inRun).toEqual([0.4]);
		expect(calls.count).toBe(2);
	});

	test("aliasRecallQuery maps a rewritten prompt onto a RESOLVED clean-prompt vector — the in-run envelope caller issues zero new embeds", async () => {
		const { runtime, calls, startRun } = makeControllableRuntime(async () => [
			0.6, 0.7,
		]);

		// Pre-run document augmentation embeds the clean user prompt…
		const clean = await embedRecallQuery(
			runtime,
			"what is the refund policy?",
			{
				messageId: MSG_A,
			},
		);
		expect(clean).toEqual([0.6, 0.7]);
		expect(calls.count).toBe(1);

		// …then rewrites the message into the contextual-documents envelope and
		// declares the two texts equivalent for this turn's recall.
		const envelope =
			"Answer the user request using the contextual documents below…\n<user_request>\nwhat is the refund policy?\n</user_request>";
		aliasRecallQuery(runtime, {
			messageId: MSG_A,
			sourceText: "what is the refund policy?",
			aliasText: envelope,
		});

		// In-run recall callers (prefetch / relevant-conversations / FACTS) present
		// the envelope text: same vector, no second round-trip.
		startRun();
		const inRun = await embedRecallQuery(runtime, envelope, {
			messageId: MSG_A,
		});
		expect(inRun).toEqual([0.6, 0.7]);
		const composeTime = await embedRecallQuery(runtime, envelope);
		expect(composeTime).toEqual([0.6, 0.7]);
		expect(calls.count).toBe(1);
	});

	test("aliasRecallQuery joins an IN-FLIGHT source embed — alias registered synchronously after a fire-and-forget warm still shares the one round-trip", async () => {
		let resolveEmbed: ((v: number[]) => void) | undefined;
		const { runtime, calls, startRun } = makeControllableRuntime(
			() =>
				new Promise<number[]>((resolve) => {
					resolveEmbed = resolve;
				}),
		);

		// Fire-and-forget warm of the clean prompt (the keyword/seed-only path:
		// no search embed preceded it), alias registered immediately while the
		// embed is still in flight.
		const warm = embedRecallQuery(runtime, "clean prompt", {
			messageId: MSG_A,
		});
		aliasRecallQuery(runtime, {
			messageId: MSG_A,
			sourceText: "clean prompt",
			aliasText: "envelope wrapping the clean prompt",
		});
		await yieldMacrotask();
		expect(calls.count).toBe(1);

		// The in-run envelope caller joins the shared in-flight promise.
		startRun();
		const inRun = embedRecallQuery(
			runtime,
			"envelope wrapping the clean prompt",
			{
				messageId: MSG_A,
			},
		);
		expect(calls.count).toBe(1);

		resolveEmbed?.([0.8]);
		await expect(warm).resolves.toEqual([0.8]);
		await expect(inRun).resolves.toEqual([0.8]);
		expect(calls.count).toBe(1);

		// Once resolved, later envelope callers hit the result cache.
		await expect(
			embedRecallQuery(runtime, "envelope wrapping the clean prompt"),
		).resolves.toEqual([0.8]);
		expect(calls.count).toBe(1);
	});

	test("aliasRecallQuery is a safe no-op when the source was never embedded — the alias-text caller embeds directly (fail-open unchanged)", async () => {
		const { runtime, calls, startRun } = makeControllableRuntime(async () => [
			0.2,
		]);
		aliasRecallQuery(runtime, {
			messageId: MSG_A,
			sourceText: "never embedded",
			aliasText: "envelope text",
		});
		startRun();
		const vec = await embedRecallQuery(runtime, "envelope text", {
			messageId: MSG_A,
		});
		expect(vec).toEqual([0.2]);
		expect(calls.count).toBe(1);
	});

	test("aliasRecallQuery does not cache a FAILED source embed under the alias: the alias caller joins the in-flight failure, fails open, then re-embeds fresh", async () => {
		let shouldFail = true;
		const { runtime, calls, startRun } = makeControllableRuntime(async () => {
			if (shouldFail) {
				throw new Error("embeddings endpoint 500");
			}
			return [0.9];
		});

		const warm = embedRecallQuery(runtime, "clean prompt", {
			messageId: MSG_A,
		});
		aliasRecallQuery(runtime, {
			messageId: MSG_A,
			sourceText: "clean prompt",
			aliasText: "envelope text",
		});
		startRun();
		// Joins the shared (failing) in-flight promise → fails open to null.
		const joined = embedRecallQuery(runtime, "envelope text", {
			messageId: MSG_A,
		});
		await expect(warm).resolves.toBeNull();
		await expect(joined).resolves.toBeNull();
		expect(calls.count).toBe(1);

		await yieldMacrotask();

		// Nothing poisoned the cache: the next envelope caller re-embeds fresh.
		shouldFail = false;
		await expect(
			embedRecallQuery(runtime, "envelope text", { messageId: MSG_A }),
		).resolves.toEqual([0.9]);
		expect(calls.count).toBe(2);
	});

	test("aliasRecallQuery no-ops on identical normalized texts", async () => {
		const { runtime, calls, startRun } = makeControllableRuntime(async () => [
			0.5,
		]);
		await embedRecallQuery(runtime, "same text", { messageId: MSG_A });
		expect(calls.count).toBe(1);

		// Identical normalized source/alias: nothing to map.
		aliasRecallQuery(runtime, {
			messageId: MSG_A,
			sourceText: "same text",
			aliasText: "  SAME   text ",
		});
		startRun();
		await embedRecallQuery(runtime, "same text", { messageId: MSG_A });
		expect(calls.count).toBe(1);
	});

	test("in-flight dedupe spans the pre-run/in-run boundary: a pre-run embed and an in-run adopt of the same messageId share one round-trip", async () => {
		let resolveEmbed: ((v: number[]) => void) | undefined;
		const { runtime, calls, startRun } = makeControllableRuntime(
			() =>
				new Promise<number[]>((resolve) => {
					resolveEmbed = resolve;
				}),
		);
		// Pre-run embed starts and stays in flight.
		const preRun = embedRecallQuery(runtime, "same text", { messageId: MSG_A });
		await yieldMacrotask();
		expect(calls.count).toBe(1);

		// The in-run prefetch adopts the slot and joins the in-flight promise
		// before it resolves — no second round-trip.
		startRun();
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
