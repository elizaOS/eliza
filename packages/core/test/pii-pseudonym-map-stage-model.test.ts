/**
 * Two PII scrub items drained together keep each other's pseudonyms.
 *
 * PiiScrubService drains up to two items at once (BatchQueue maxParallel 2).
 * An item without a requester-built context pack loads the encrypted corpus
 * pseudonym map, mints a pseudonym for each new person, waits for the
 * PII_SCRUB model and then saves its copy of the map, which replaces the
 * stored map. `quint/PiiPseudonymMapStage.qnt` models that map stage. Its
 * conformance script passes every generated sequence here through
 * `ELIZA_PII_MAP_STAGE_MODEL_CASES`.
 */

import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { AgentRuntime } from "../src/runtime";
import { EncryptedCachePseudonymMapStore } from "../src/security/pii-pseudonym-map-store";
import { PiiScrubService } from "../src/services/pii-scrub";
import { EventType, type PiiScrubResultPayload } from "../src/types/events";
import { ModelType, type PiiScrubParams } from "../src/types/model";
import type { IAgentRuntime } from "../src/types/runtime";
import { Service } from "../src/types/service";
import { createInitializedRuntime } from "./initialized-runtime";

const RULESET = "pii-map-stage-model";
const DRAIN_TASK = "PII_SCRUB_DRAIN";
// Long enough for a second drained item to reach the model when nothing
// holds it back.
const SETTLE_MS = 150;

const PEOPLE = {
	1: { name: "Ada Lovelace", entityId: "ada" },
	2: { name: "Grace Hopper", entityId: "grace" },
} as const;
type Person = keyof typeof PEOPLE;

interface ModelCase {
	/** The person item 2 names; item 1 always names person 1. */
	second: Person;
	/** The order in which the two requests reach the drain. */
	arrival: [1 | 2, 1 | 2];
	/** "<event> <item> <token> <stored person 1> <stored person 2>". */
	steps: string[];
}

// "<second> <arrival> | <step>; <step>; ...": the twelve sequences
// check-pii-pseudonym-map-stage.mjs generates, so a plain vitest run replays
// them too.
const GENERATED_CASES = [
	"1 1,2 | load 1 1 0 0; complete 1 0 1 0; load 2 1 1 0; complete 2 0 1 0",
	"1 1,2 | load 1 1 0 0; complete 1 0 1 0; load 2 1 1 0; reject 2 0 1 0; load 2 1 1 0; complete 2 0 1 0",
	"1 1,2 | load 1 1 0 0; reject 1 0 0 0; load 2 2 0 0; complete 2 0 2 0; load 1 2 2 0; complete 1 0 2 0",
	"1 2,1 | load 2 1 0 0; complete 2 0 1 0; load 1 1 1 0; complete 1 0 1 0",
	"1 2,1 | load 2 1 0 0; complete 2 0 1 0; load 1 1 1 0; reject 1 0 1 0; load 1 1 1 0; complete 1 0 1 0",
	"1 2,1 | load 2 1 0 0; reject 2 0 0 0; load 1 2 0 0; complete 1 0 2 0; load 2 2 2 0; complete 2 0 2 0",
	"2 1,2 | load 1 1 0 0; complete 1 0 1 0; load 2 2 1 0; complete 2 0 1 2",
	"2 1,2 | load 1 1 0 0; complete 1 0 1 0; load 2 2 1 0; reject 2 0 1 0; load 2 3 1 0; complete 2 0 1 3",
	"2 1,2 | load 1 1 0 0; reject 1 0 0 0; load 2 2 0 0; complete 2 0 0 2; load 1 3 0 2; complete 1 0 3 2",
	"2 2,1 | load 2 1 0 0; complete 2 0 0 1; load 1 2 0 1; complete 1 0 2 1",
	"2 2,1 | load 2 1 0 0; complete 2 0 0 1; load 1 2 0 1; reject 1 0 0 1; load 1 3 0 1; complete 1 0 3 1",
	"2 2,1 | load 2 1 0 0; reject 2 0 0 0; load 1 2 0 0; complete 1 0 2 0; load 2 3 2 0; complete 2 0 2 3",
];

function parseCase(text: string): ModelCase {
	const [head = "", body = ""] = text.split(" | ");
	const [second = "", arrival = ""] = head.split(" ");
	return {
		second: Number(second) as Person,
		arrival: arrival.split(",").map(Number) as ModelCase["arrival"],
		steps: body.split("; "),
	};
}

const modelCases: ModelCase[] = process.env.ELIZA_PII_MAP_STAGE_MODEL_CASES
	? JSON.parse(
			readFileSync(process.env.ELIZA_PII_MAP_STAGE_MODEL_CASES, "utf8"),
		)
	: GENERATED_CASES.map(parseCase);

/** The agent-side knowledge graph resolves both names to stable entities. */
class EntityGraph extends Service {
	static serviceType = "eliza_knowledge_graph";
	capabilityDescription = "Resolves the two test people";
	static async start(runtime: IAgentRuntime): Promise<Service> {
		return new EntityGraph(runtime);
	}
	async stop(): Promise<void> {}
	getEntityStore() {
		return {
			resolve: async (query: { name?: string }) => {
				const person = Object.values(PEOPLE).find(
					(candidate) => candidate.name === query.name,
				);
				return person
					? [
							{
								entity: {
									entityId: person.entityId,
									type: "person",
									preferredName: person.name,
									identities: [],
								},
								confidence: 0.95,
								evidence: [],
							},
						]
					: [];
			},
		};
	}
}

interface OpenCall {
	surrogate: string;
	settle: (succeed: boolean) => void;
}

/** A runtime whose PII_SCRUB model calls stay open until the test settles them. */
async function startScrubRuntime(contents: Record<number, string>) {
	const runtime = await createInitializedRuntime({
		character: { name: "PiiMapStage" },
		logLevel: "fatal",
	});
	await runtime.registerService(EntityGraph);
	await runtime.getServiceLoadPromise("eliza_knowledge_graph");
	const open = new Map<number, OpenCall>();
	const completed = new Set<string>();
	let calls = 0;
	// Registered like a provider plugin's PII_SCRUB handler.
	await runtime.registerPlugin({
		name: "pii-map-stage-replay",
		description: "Holds each PII_SCRUB call until the test settles it",
		models: {
			[ModelType.PII_SCRUB]: async (_runtime, params: PiiScrubParams) => {
				calls += 1;
				// A runaway retry loop would otherwise keep the drain busy.
				if (calls > 8) throw new Error("PII_SCRUB call-count guard");
				const item = Number(
					Object.entries(contents).find(
						([, text]) => text === params.text,
					)?.[0],
				);
				const surrogate = params.pseudonymAssignments?.[0]?.surrogate ?? "";
				const succeed = await new Promise<boolean>((settle) => {
					open.set(item, { surrogate, settle });
				});
				open.delete(item);
				if (!succeed) throw new Error("The replay rejected this model call");
				return {
					modelId: "pii-map-stage-replay",
					rulesetVersion: params.rulesetVersion,
					verdicts: params.candidateSpans.map((span) => ({
						span,
						kind: "pii" as const,
						replacement: surrogate,
					})),
				};
			},
		},
	});
	runtime.registerEvent(
		EventType.PII_SCRUB_COMPLETED,
		async (payload: PiiScrubResultPayload) => {
			completed.add(payload.content);
		},
	);
	await PiiScrubService.start(runtime);
	return { runtime, open, completed };
}

async function request(
	runtime: AgentRuntime,
	content: string,
	span: string,
	extra: Record<string, unknown> = {},
): Promise<void> {
	await runtime.emitEvent(EventType.PII_SCRUB_REQUESTED, {
		runtime,
		source: "pii-map-stage-model",
		content,
		rulesetVersion: RULESET,
		candidateSpans: [span],
		...extra,
	});
}

function drain(runtime: AgentRuntime): Promise<unknown> {
	return runtime.getTasksByName(DRAIN_TASK).then(([task]) => {
		const worker = runtime.getTaskWorker(DRAIN_TASK);
		if (!task || !worker) throw new Error("PII scrub drain is not registered");
		return worker.execute(runtime, {}, task);
	});
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
	for (let waited = 0; !condition(); waited += 5) {
		if (waited > 5_000) throw new Error(`Timed out waiting for ${what}`);
		await delay(5);
	}
}

async function storedPseudonyms(
	runtime: AgentRuntime,
): Promise<Record<string, string>> {
	const snapshot = await new EncryptedCachePseudonymMapStore(runtime).load();
	return Object.fromEntries(
		(snapshot?.clusters ?? []).map((cluster) => [
			cluster.clusterId,
			cluster.pseudonym,
		]),
	);
}

async function replay(modelCase: ModelCase): Promise<void> {
	const person: Record<number, Person> = { 1: 1, 2: modelCase.second };
	const contents: Record<number, string> = {
		1: "Please call Ada Lovelace tomorrow.",
		2:
			modelCase.second === 1
				? "Ada Lovelace sent the notes."
				: "Please ask Grace Hopper today.",
	};
	const { runtime, open, completed } = await startScrubRuntime(contents);
	for (const item of modelCase.arrival) {
		await request(runtime, contents[item], PEOPLE[person[item]].name);
	}
	const drained = drain(runtime);
	// Model token -> the surrogate the production map minted for it.
	const surrogates = new Map<number, string>();
	for (const step of modelCase.steps) {
		const [event, item, token, ...stored] = step.split(" ");
		const index = Number(item);
		if (event === "load") {
			await waitFor(() => open.has(index), `item ${item} to load`);
			const surrogate = open.get(index)?.surrogate ?? "";
			expect(surrogate, step).not.toBe("");
			const known = surrogates.get(Number(token));
			if (known !== undefined) expect(surrogate, step).toBe(known);
			surrogates.set(Number(token), surrogate);
			await delay(SETTLE_MS);
			// The item holds the map stage: no other map item reaches the model.
			expect([...open.keys()], step).toEqual([index]);
		} else {
			const call = open.get(index);
			expect(call, step).toBeDefined();
			call?.settle(event === "complete");
			await waitFor(
				() =>
					event === "complete"
						? completed.has(contents[index])
						: open.get(index) !== call,
				`item ${item} to ${event}`,
			);
		}
		const expected: Record<string, string> = {};
		stored.forEach((value, position) => {
			const entityId = PEOPLE[(position + 1) as Person].entityId;
			if (value !== "0") {
				expected[`entity:${entityId}`] = surrogates.get(Number(value)) ?? "";
			}
		});
		expect(await storedPseudonyms(runtime), step).toEqual(expected);
	}
	await drained;
	// One stored map holds distinct pseudonyms for distinct people.
	const saved = Object.values(await storedPseudonyms(runtime));
	expect(new Set(saved).size).toBe(saved.length);
}

describe("PiiPseudonymMapStage model", () => {
	for (const first of [1, 2] as const) {
		for (const second of [1, 2] as const) {
			const group = modelCases.filter(
				(modelCase) =>
					modelCase.arrival[0] === first && modelCase.second === second,
			);
			it(`replays item ${first} arriving first with item 2 naming person ${second}`, async () => {
				// No rejection, or one rejection of either item.
				expect(group).toHaveLength(3);
				for (const modelCase of group) await replay(modelCase);
			}, 60_000);
		}
	}

	it("keeps a request with its own assignments out of the map stage", async () => {
		const contents = {
			1: "Please call Ada Lovelace tomorrow.",
			3: "Grace Hopper reviewed the draft.",
		};
		const { runtime, open, completed } = await startScrubRuntime(contents);
		await request(runtime, contents[1], PEOPLE[1].name);
		await request(runtime, contents[3], PEOPLE[2].name, {
			contextPack: "Grace Hopper is a colleague.",
			pseudonymAssignments: [
				{
					entityClusterId: "entity:grace",
					surrogate: "Rosa Mendes",
					kind: "person",
				},
			],
		});
		const drained = drain(runtime);
		await waitFor(() => open.has(1) && open.has(3), "both model calls");
		open.get(3)?.settle(true);
		await waitFor(() => completed.has(contents[3]), "the requester-built item");
		expect(open.has(1)).toBe(true);
		open.get(1)?.settle(true);
		await drained;
		expect(Object.keys(await storedPseudonyms(runtime))).toEqual([
			"entity:ada",
		]);
	}, 30_000);
});
