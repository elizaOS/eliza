/**
 * End-to-end corpus consistency through the LANDED rails (#14805 over #14808 +
 * #14809): context pack -> `buildScrubRequestDraft` -> `PiiScrubService` drain
 * -> `scrubWithEscalation` -> `PII_SCRUB` model verdicts, with the corpus
 * pseudonym map supplying the per-chunk assignment slice.
 *
 * Proves, over a seeded four-artifact corpus (document full name, second
 * document first name, chat nickname, transcript @handle) plus a second
 * similarly-named person:
 *   - every artifact's rewrite uses the SAME pseudonym for the same person and
 *     a different one for the other person (one person = one replacement),
 *   - deterministic tier-0 content completes with ZERO model calls,
 *   - the fail-closed path holds: residue with no PII_SCRUB handler throws,
 *     the item is never marked done, and no clean verdict is fabricated,
 *   - the content-hash done-markers make re-runs no-ops under the same
 *     ruleset and re-scrubs (with STABLE pseudonyms) under a bumped one.
 */

import { describe, expect, test, vi } from "vitest";
import { PiiScrubService } from "../services/pii-scrub.js";
import type {
	PiiPseudonymAssignment,
	PiiScrubParams,
	PiiScrubResult,
} from "../types/model.js";
import { ModelType } from "../types/model.js";
import type { IAgentRuntime } from "../types/runtime.js";
import {
	assembleContextPack,
	buildScrubRequestDraft,
} from "./pii-context-pack.js";
import { CorpusPseudonymMap } from "./pii-pseudonym-map.js";
import { getScrubMarker } from "./pii-scrub-markers.js";
import { scrubWithEscalation } from "./pii-scrub-seam.js";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const RULESET = "2026.07";

interface MockRuntime extends IAgentRuntime {
	__cache: Map<string, unknown>;
	__events: { type: string; payload: Record<string, unknown> }[];
	__useModelCalls: number;
}

/**
 * Mock runtime mirroring `services/pii-scrub.test.ts`. The optional scrub
 * handler is a CONTRACT-FAITHFUL stand-in for the local privacy GGUF: it
 * judges each candidate span, reusing the pseudonym assignment slice when the
 * span belongs to a mapped cluster — exactly what the LLM-pass prompt
 * instructs a real model to do. (Live-model trajectories are the sibling
 * LLM-pass issue's evidence; this exercises the deterministic contract.)
 */
function makeRuntime(opts: {
	scrubHandler?: (params: PiiScrubParams) => Promise<PiiScrubResult>;
}): MockRuntime {
	const cache = new Map<string, unknown>();
	const events: { type: string; payload: Record<string, unknown> }[] = [];
	const noop = () => {};
	let useModelCalls = 0;

	const runtime = {
		agentId: AGENT_ID,
		logger: { info: noop, warn: noop, debug: noop, error: noop },
		getModel: (type: string) =>
			type === ModelType.PII_SCRUB && opts.scrubHandler
				? opts.scrubHandler
				: undefined,
		useModel: async (type: string, params: PiiScrubParams) => {
			if (type !== ModelType.PII_SCRUB || !opts.scrubHandler) {
				throw new Error(`No handler for ${type}`);
			}
			useModelCalls++;
			return opts.scrubHandler(params);
		},
		getCache: async <T>(key: string): Promise<T | undefined> =>
			cache.has(key) ? (cache.get(key) as T) : undefined,
		setCache: async <T>(key: string, value: T): Promise<boolean> => {
			cache.set(key, value);
			return true;
		},
		deleteCache: async (key: string): Promise<boolean> => cache.delete(key),
		reportError: noop,
		emitEvent: async (type: string, payload: Record<string, unknown>) => {
			events.push({ type, payload });
		},
		registerEvent: vi.fn(),
		registerTaskWorker: vi.fn(),
		getTasksByName: async () => [],
		getTask: async () => null,
		updateTask: async () => {},
		createTask: vi.fn(async () => AGENT_ID),
		deleteTask: vi.fn(async () => {}),
		log: async () => {},
	} as unknown as MockRuntime;

	Object.defineProperties(runtime, {
		__cache: { get: () => cache },
		__events: { get: () => events },
		__useModelCalls: { get: () => useModelCalls },
	});
	return runtime;
}

/** The contract-faithful PII_SCRUB handler described on {@link makeRuntime}. */
function assignmentAwareHandler(
	aliasToCluster: Map<string, string>,
): (params: PiiScrubParams) => Promise<PiiScrubResult> {
	return async (params) => {
		const bySlice = new Map<string, PiiPseudonymAssignment>();
		for (const assignment of params.pseudonymAssignments ?? []) {
			bySlice.set(assignment.entityClusterId, assignment);
		}
		return {
			modelId: "test-local-privacy-gguf",
			rulesetVersion: params.rulesetVersion,
			verdicts: params.candidateSpans.map((span) => {
				const clusterId = aliasToCluster.get(span);
				const assignment = clusterId ? bySlice.get(clusterId) : undefined;
				if (assignment) {
					return {
						span,
						kind: "pii" as const,
						entityClusterId: assignment.entityClusterId,
						replacement: assignment.surrogate,
					};
				}
				return { span, kind: "safe" as const };
			}),
		};
	};
}

/** Drive the service's private queue deterministically (test owns the tick). */
async function drain(service: PiiScrubService): Promise<void> {
	// biome-ignore lint/suspicious/noExplicitAny: reach the private queue to drive a drain deterministically
	await (service as any).batchQueue.drain();
}

async function enqueue(
	service: PiiScrubService,
	payload: Record<string, unknown>,
): Promise<void> {
	// biome-ignore lint/suspicious/noExplicitAny: exercise the event handler directly
	await (service as any).handleScrubRequest(payload);
}

/** Seed the corpus map exactly as the context pass does for resolved entities. */
function seedMap(map: CorpusPseudonymMap): void {
	map.assign({
		clusterId: "entity:john",
		kind: "person",
		aliases: ["John Smith", "John", "Johnny", "@jsmith"],
		identities: [{ platform: "discord", handle: "jsmith" }],
		rulesetVersion: RULESET,
	});
	map.assign({
		clusterId: "entity:smythe",
		kind: "person",
		aliases: ["Jon Smythe"],
		rulesetVersion: RULESET,
	});
}

const CORPUS: { itemRef: string; content: string; spans: string[] }[] = [
	{
		itemRef: "document:d1",
		content: "Contract addendum drafted by John Smith for the buyer.",
		spans: ["John Smith"],
	},
	{
		itemRef: "document:d2",
		content: "John reviewed the draft and approved it.",
		spans: ["John"],
	},
	{
		itemRef: "message:m1",
		content: "Johnny said he'd send the wire on Friday",
		spans: ["Johnny"],
	},
	{
		itemRef: "transcript:t1",
		content: "@jsmith joined the call with Jon Smythe",
		spans: ["@jsmith", "Jon Smythe"],
	},
];

const ALIAS_TO_CLUSTER = new Map<string, string>([
	["John Smith", "entity:john"],
	["John", "entity:john"],
	["Johnny", "entity:john"],
	["@jsmith", "entity:john"],
	["Jon Smythe", "entity:smythe"],
]);

describe("corpus-wide pseudonym consistency through the rails", () => {
	test("four artifact types, two people: one pseudonym each, everywhere", async () => {
		const map = new CorpusPseudonymMap({ salt: "fixed-test-salt" });
		seedMap(map);
		const john = map.getCluster("entity:john");
		const smythe = map.getCluster("entity:smythe");
		if (!john || !smythe) throw new Error("clusters missing");

		const runtime = makeRuntime({
			scrubHandler: assignmentAwareHandler(ALIAS_TO_CLUSTER),
		});
		const service = (await PiiScrubService.start(runtime)) as PiiScrubService;

		const verdictsByItem = new Map<
			string,
			readonly PiiScrubResult["verdicts"][number][]
		>();
		for (const artifact of CORPUS) {
			const pack = await assembleContextPack(
				{},
				{
					chunk: artifact.content,
					candidates: artifact.spans.map((surfaceForm) => ({
						surfaceForm,
						kind: "person",
					})),
					map,
					rulesetVersion: RULESET,
				},
			);
			// The per-chunk slice carries only clusters present in this chunk.
			for (const assignment of pack.assignments) {
				expect(["entity:john", "entity:smythe"]).toContain(
					assignment.entityClusterId,
				);
			}
			// Run the exact seam the drain runs, to capture verdicts for
			// write-back assertions (the service itself asserts markers/events).
			const escalation = await scrubWithEscalation(runtime, {
				text: artifact.content,
				candidateSpans: pack.candidateSpans,
				rulesetVersion: RULESET,
				contextPack: pack.contextPack,
				pseudonymAssignments: pack.assignments,
			});
			if (!escalation.escalation) throw new Error("expected escalation");
			verdictsByItem.set(artifact.itemRef, [...escalation.escalation.verdicts]);

			await enqueue(
				service,
				buildScrubRequestDraft({
					content: artifact.content,
					rulesetVersion: RULESET,
					pack,
					itemRef: artifact.itemRef,
				}) as unknown as Record<string, unknown>,
			);
		}
		await drain(service);

		// Every artifact completed and is marker-done.
		const completed = runtime.__events.filter(
			(e) => e.type === "PII_SCRUB_COMPLETED",
		);
		expect(completed).toHaveLength(CORPUS.length);
		for (const artifact of CORPUS) {
			const marker = await getScrubMarker(runtime, artifact.content, RULESET);
			expect(marker?.modelId).toBe("test-local-privacy-gguf");
		}

		// One person = one replacement, across document, chat, and transcript.
		const johnReplacements = new Set<string>();
		for (const [itemRef, verdicts] of verdictsByItem) {
			for (const verdict of verdicts) {
				if (verdict.entityClusterId === "entity:john") {
					expect(verdict.kind).toBe("pii");
					if (verdict.replacement) johnReplacements.add(verdict.replacement);
				}
			}
			void itemRef;
		}
		expect([...johnReplacements]).toEqual([john.pseudonym]);

		// The second, similarly-named person got a DIFFERENT pseudonym.
		const transcriptVerdicts = verdictsByItem.get("transcript:t1");
		const smytheVerdict = transcriptVerdicts?.find(
			(v) => v.entityClusterId === "entity:smythe",
		);
		expect(smytheVerdict?.replacement).toBe(smythe.pseudonym);
		expect(smytheVerdict?.replacement).not.toBe(john.pseudonym);

		// Applying the verdicts leaves zero alias occurrences corpus-wide.
		for (const artifact of CORPUS) {
			let rewritten = artifact.content;
			for (const verdict of verdictsByItem.get(artifact.itemRef) ?? []) {
				if (verdict.kind === "pii" && verdict.replacement) {
					rewritten = rewritten.split(verdict.span).join(verdict.replacement);
				}
			}
			for (const alias of ALIAS_TO_CLUSTER.keys()) {
				expect(rewritten).not.toContain(alias);
			}
		}

		await service.stop();
	});

	test("re-run under the same ruleset is a marker no-op; a ruleset bump re-scrubs with STABLE pseudonyms", async () => {
		const map = new CorpusPseudonymMap({ salt: "fixed-test-salt" });
		seedMap(map);
		const john = map.getCluster("entity:john");
		if (!john) throw new Error("cluster missing");

		const runtime = makeRuntime({
			scrubHandler: assignmentAwareHandler(ALIAS_TO_CLUSTER),
		});
		const service = (await PiiScrubService.start(runtime)) as PiiScrubService;
		const artifact = CORPUS[0];

		const makeDraft = async (rulesetVersion: string) => {
			// Assign under the active ruleset, as the context pass would.
			map.assign({
				clusterId: "entity:john",
				kind: "person",
				aliases: ["John Smith"],
				rulesetVersion,
			});
			const pack = await assembleContextPack(
				{},
				{
					chunk: artifact.content,
					candidates: [{ surfaceForm: "John Smith", kind: "person" }],
					map,
					rulesetVersion,
				},
			);
			return buildScrubRequestDraft({
				content: artifact.content,
				rulesetVersion,
				pack,
				itemRef: artifact.itemRef,
			}) as unknown as Record<string, unknown>;
		};

		await enqueue(service, await makeDraft(RULESET));
		await drain(service);
		expect(runtime.__useModelCalls).toBe(1);

		// Same content + same ruleset: the done-marker short-circuits everything.
		await enqueue(service, await makeDraft(RULESET));
		await drain(service);
		expect(runtime.__useModelCalls).toBe(1);

		// Ruleset bump: the marker no longer matches -> the item re-scrubs, and
		// the corpus map hands out the SAME pseudonym (stability across bumps).
		const bumped = "2026.08";
		const draft = await makeDraft(bumped);
		expect(
			(draft.pseudonymAssignments as PiiPseudonymAssignment[]).find(
				(a) => a.entityClusterId === "entity:john",
			)?.surrogate,
		).toBe(john.pseudonym);
		await enqueue(service, draft);
		await drain(service);
		expect(runtime.__useModelCalls).toBe(2);
		expect(
			await getScrubMarker(runtime, artifact.content, bumped),
		).toBeTruthy();

		await service.stop();
	});

	test("tier-0-only content completes with ZERO model calls (deterministic floor)", async () => {
		const runtime = makeRuntime({
			scrubHandler: assignmentAwareHandler(ALIAS_TO_CLUSTER),
		});
		const service = (await PiiScrubService.start(runtime)) as PiiScrubService;
		// Structured PII fully covered by tier-0 detectors; no mined candidates.
		const content = "Card on file: 4111 1111 1111 1111";
		const map = new CorpusPseudonymMap({ salt: "fixed-test-salt" });
		const pack = await assembleContextPack(
			{},
			{ chunk: content, candidates: [], map, rulesetVersion: RULESET },
		);
		await enqueue(
			service,
			buildScrubRequestDraft({
				content,
				rulesetVersion: RULESET,
				pack,
				itemRef: "document:card",
			}) as unknown as Record<string, unknown>,
		);
		await drain(service);
		expect(runtime.__useModelCalls).toBe(0);
		const marker = await getScrubMarker(runtime, content, RULESET);
		expect(marker?.tier0Only).toBe(true);
		await service.stop();
	});

	test("fail-closed: residue with no PII_SCRUB handler throws and the item is NEVER marked done", async () => {
		const runtime = makeRuntime({});
		const map = new CorpusPseudonymMap({ salt: "fixed-test-salt" });
		seedMap(map);
		const artifact = CORPUS[0];
		const pack = await assembleContextPack(
			{},
			{
				chunk: artifact.content,
				candidates: [{ surfaceForm: "John Smith", kind: "person" }],
				map,
				rulesetVersion: RULESET,
			},
		);

		// The seam refuses to pass un-inspected residue as clean.
		await expect(
			scrubWithEscalation(runtime, {
				text: artifact.content,
				candidateSpans: pack.candidateSpans,
				rulesetVersion: RULESET,
				contextPack: pack.contextPack,
				pseudonymAssignments: pack.assignments,
			}),
		).rejects.toThrow(/refusing to pass un-inspected content/);

		// And through the service: retries exhaust into FAILED, no marker written.
		const service = (await PiiScrubService.start(runtime)) as PiiScrubService;
		await enqueue(
			service,
			buildScrubRequestDraft({
				content: artifact.content,
				rulesetVersion: RULESET,
				pack,
				itemRef: artifact.itemRef,
			}) as unknown as Record<string, unknown>,
		);
		// Drain enough to exhaust retries (maxRetriesAfterFailure: 3).
		for (let i = 0; i < 6; i += 1) {
			await drain(service);
		}
		const failed = runtime.__events.filter(
			(e) => e.type === "PII_SCRUB_FAILED",
		);
		expect(failed.length).toBe(1);
		expect(
			runtime.__events.filter((e) => e.type === "PII_SCRUB_COMPLETED"),
		).toHaveLength(0);
		expect(
			await getScrubMarker(runtime, artifact.content, RULESET),
		).toBeUndefined();
		await service.stop();
	});
});
