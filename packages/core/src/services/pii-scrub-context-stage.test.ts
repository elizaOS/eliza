/**
 * Exercises the production context-retrieval / pseudonym-consistency stage of
 * {@link PiiScrubService} (#15973) through the service's real request entry and
 * drain path: requests that arrive WITHOUT a pre-assembled context pack get
 * one assembled from the REAL encrypted corpus pseudonym map
 * (`EncryptedCachePseudonymMapStore` over the runtime cache) and the real
 * `assembleContextPack` stage, the grown map is persisted encrypted BEFORE the
 * done-marker, and a service restarted over the same cache reuses the same
 * surrogate for the same entity. The model handler is a scripted judge; every
 * other collaborator (seam, map, store, markers) is the production code.
 */

import { describe, expect, test, vi } from "vitest";
import { PII_PSEUDONYM_MAP_CACHE_KEY } from "../security/pii-pseudonym-map-store.js";
import type {
	PiiScrubParams,
	PiiScrubResult,
	PiiScrubVerdict,
} from "../types/model.js";
import { ModelType } from "../types/model.js";
import type { IAgentRuntime } from "../types/runtime.js";
import { PiiScrubService } from "./pii-scrub.js";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const RULESET = "2026.08";

interface MockRuntime extends IAgentRuntime {
	__cache: Map<string, unknown>;
	__events: { type: string; payload: Record<string, unknown> }[];
	__reported: { scope: string; error: unknown }[];
	__scrubCalls: PiiScrubParams[];
}

/**
 * Mock runtime with a REAL durable cache map (the encrypted map store and the
 * done-markers write through it), a scripted PII_SCRUB judge that answers
 * every required span using the supplied pseudonym assignments, and a fake
 * knowledge-graph service resolving "Alice Johnson" to one stable entity.
 */
function makeRuntime(
	options: { cache?: Map<string, unknown> } = {},
): MockRuntime {
	const cache = options.cache ?? new Map<string, unknown>();
	const events: { type: string; payload: Record<string, unknown> }[] = [];
	const reported: { scope: string; error: unknown }[] = [];
	const scrubCalls: PiiScrubParams[] = [];
	const noop = () => {};

	const scrubHandler = async (
		params: PiiScrubParams,
	): Promise<PiiScrubResult> => {
		scrubCalls.push(params);
		const byCluster = new Map(
			(params.pseudonymAssignments ?? []).map((a) => [a.entityClusterId, a]),
		);
		const verdicts: PiiScrubVerdict[] = params.candidateSpans.map((span) => {
			const assignment = [...byCluster.values()][0];
			return {
				span,
				kind: "pii" as const,
				replacement: assignment?.surrogate ?? "Redacted Person",
				...(assignment ? { entityClusterId: assignment.entityClusterId } : {}),
			};
		});
		return {
			verdicts,
			modelId: "scripted-judge",
			rulesetVersion: params.rulesetVersion,
		};
	};

	const kgService = {
		getEntityStore: () => ({
			resolve: async (query: { name?: string }) =>
				query.name?.includes("Alice Johnson")
					? [
							{
								entity: {
									entityId: "e1",
									type: "person",
									preferredName: "Alice Johnson",
									identities: [],
								},
								confidence: 0.9,
								evidence: ["exact-name"],
							},
						]
					: [],
		}),
	};

	const runtime = {
		agentId: AGENT_ID,
		logger: { info: noop, warn: noop, debug: noop, error: noop },
		getModel: (type: string) =>
			type === ModelType.PII_SCRUB ? scrubHandler : undefined,
		useModel: async (type: string, params: unknown) => {
			if (type !== ModelType.PII_SCRUB) {
				throw new Error(`No handler for ${type}`);
			}
			return scrubHandler(params as PiiScrubParams);
		},
		getService: (name: string) =>
			name === "eliza_knowledge_graph" ? kgService : null,
		getCache: async <T>(key: string): Promise<T | undefined> =>
			cache.has(key) ? (cache.get(key) as T) : undefined,
		setCache: async <T>(key: string, value: T): Promise<boolean> => {
			cache.set(key, value);
			return true;
		},
		deleteCache: async (key: string): Promise<boolean> => cache.delete(key),
		reportError: (scope: string, error: unknown) => {
			reported.push({ scope, error });
		},
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
		__reported: { get: () => reported },
		__scrubCalls: { get: () => scrubCalls },
	});
	return runtime;
}

async function drain(service: PiiScrubService): Promise<void> {
	// biome-ignore lint/suspicious/noExplicitAny: reach the private queue to drive a drain deterministically
	await (service as any).batchQueue.drain();
}

async function enqueue(
	service: PiiScrubService,
	payload: Record<string, unknown>,
): Promise<void> {
	// biome-ignore lint/suspicious/noExplicitAny: exercise the request entry the PII_SCRUB_REQUESTED event invokes
	await (service as any).handleScrubRequest(payload);
}

describe("PiiScrubService context stage (#15973)", () => {
	test("assembles context + assignments and persists the encrypted map before the marker", async () => {
		const runtime = makeRuntime();
		const service = (await PiiScrubService.start(runtime)) as PiiScrubService;
		const content = "Meeting notes: Alice Johnson approved the audit.";

		await enqueue(service, {
			content,
			rulesetVersion: RULESET,
			candidateSpans: ["Alice Johnson"],
		});
		await drain(service);

		// The model call carried the assembled stage outputs, not raw defaults.
		expect(runtime.__scrubCalls).toHaveLength(1);
		const call = runtime.__scrubCalls[0];
		expect(call.contextPack).toContain("Resolved entity candidates");
		expect(call.contextPack).toContain("entity:e1");
		expect(call.pseudonymAssignments).toHaveLength(1);
		const assignment = call.pseudonymAssignments?.[0];
		expect(assignment?.entityClusterId).toBe("entity:e1");
		expect(assignment?.kind).toBe("person");
		expect(assignment?.surrogate).toBeTruthy();
		expect(assignment?.surrogate).not.toContain("Alice");

		// The map was persisted as v2 ciphertext — never plaintext, never the
		// alias — and the done-marker exists (persist happens before the marker).
		const stored = runtime.__cache.get(PII_PSEUDONYM_MAP_CACHE_KEY);
		expect(typeof stored).toBe("string");
		expect((stored as string).startsWith("v2:")).toBe(true);
		expect(stored as string).not.toContain("Alice");
		expect(await service.getMarker(content, RULESET)).toBeDefined();
		await service.stop();
	});

	test("a restarted service over the same cache reuses the SAME surrogate for the same entity", async () => {
		const cache = new Map<string, unknown>();
		const first = makeRuntime({ cache });
		const service1 = (await PiiScrubService.start(first)) as PiiScrubService;
		await enqueue(service1, {
			content: "Alice Johnson attended the standup.",
			rulesetVersion: RULESET,
			candidateSpans: ["Alice Johnson"],
		});
		await drain(service1);
		await service1.stop();
		const surrogate1 =
			first.__scrubCalls[0]?.pseudonymAssignments?.[0]?.surrogate;
		expect(surrogate1).toBeTruthy();

		// "Restart": a fresh service + fresh runtime instance over the SAME
		// durable cache — only the encrypted artifact carries the assignment.
		const second = makeRuntime({ cache });
		const service2 = (await PiiScrubService.start(second)) as PiiScrubService;
		await enqueue(service2, {
			content: "Alice Johnson sent the follow-up memo.",
			rulesetVersion: RULESET,
			candidateSpans: ["Alice Johnson"],
		});
		await drain(service2);
		await service2.stop();

		const surrogate2 =
			second.__scrubCalls[0]?.pseudonymAssignments?.[0]?.surrogate;
		expect(surrogate2).toBe(surrogate1);
	});

	test("pre-assembled requests bypass the stage untouched (no second assembly, no map write)", async () => {
		const runtime = makeRuntime();
		const service = (await PiiScrubService.start(runtime)) as PiiScrubService;
		const content = "Notes from Alice Johnson.";

		await enqueue(service, {
			content,
			rulesetVersion: RULESET,
			candidateSpans: ["Alice Johnson"],
			contextPack: "prebuilt pack",
			pseudonymAssignments: [
				{
					entityClusterId: "entity:pre",
					surrogate: "Pre Built",
					kind: "person",
				},
			],
		});
		await drain(service);

		const call = runtime.__scrubCalls[0];
		expect(call.contextPack).toBe("prebuilt pack");
		expect(call.pseudonymAssignments?.[0]?.entityClusterId).toBe("entity:pre");
		// The stage never ran: nothing loaded or persisted the map artifact.
		expect(runtime.__cache.has(PII_PSEUDONYM_MAP_CACHE_KEY)).toBe(false);
		await service.stop();
	});

	test("a tampered map artifact fails closed: no model call, no marker, FAILED after retries", async () => {
		const runtime = makeRuntime();
		runtime.__cache.set(PII_PSEUDONYM_MAP_CACHE_KEY, "v2:zz:zz:zz");
		const service = (await PiiScrubService.start(runtime)) as PiiScrubService;
		const content = "Escalate Alice Johnson's ticket.";

		await enqueue(service, {
			content,
			rulesetVersion: RULESET,
			candidateSpans: ["Alice Johnson"],
		});
		for (let i = 0; i < 6; i++) {
			await drain(service);
		}

		expect(runtime.__scrubCalls).toHaveLength(0);
		expect(await service.getMarker(content, RULESET)).toBeUndefined();
		expect(runtime.__events.some((e) => e.type === "PII_SCRUB_FAILED")).toBe(
			true,
		);
		expect(runtime.__reported.some((r) => r.scope === "pii-scrub")).toBe(true);
		await service.stop();
	});
});
