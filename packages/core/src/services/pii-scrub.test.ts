/**
 * Exercises {@link PiiScrubService}: the async PII scrub rails (#14808):
 *   - enqueue -> drain -> scrub applied (seam invoked, done-marker written,
 *     COMPLETED emitted),
 *   - content-hash idempotency (same content -> skip enqueue AND skip drain,
 *     zero extra model calls),
 *   - crash/retry safety (a throw does NOT write a done-marker; the item is
 *     retried; exhaustion emits FAILED + reportError; content stays un-marked),
 *   - tier-0-only content completes with zero model calls,
 *   - drain config mirrors the embedding service (interval/priority/serial).
 *
 * Runs against a mock runtime whose cache is an in-memory Map (the DB-backed
 * done-marker store) and a stubbed PII_SCRUB model.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { hashScrubContent } from "../security/pii-scrub-markers.js";
import type { Memory } from "../types/memory.js";
import type { PiiScrubResult } from "../types/model.js";
import { ModelType } from "../types/model.js";
import type { PipelineHookSpec } from "../types/pipeline-hooks.js";
import type { UUID } from "../types/primitives.js";
import type { IAgentRuntime } from "../types/runtime.js";
import { PiiScrubService } from "./pii-scrub.js";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const RULESET = "2026.07";

interface RuntimeMockOpts {
	/** Handler for ModelType.PII_SCRUB. Undefined means no model registered. */
	scrubHandler?: (params: unknown) => Promise<PiiScrubResult>;
}

interface MockRuntime extends IAgentRuntime {
	__cache: Map<string, unknown>;
	__events: { type: string; payload: Record<string, unknown> }[];
	__reported: { scope: string; error: unknown }[];
	__useModelCalls: number;
}

function makeRuntime(opts: RuntimeMockOpts = {}): MockRuntime {
	const cache = new Map<string, unknown>();
	const events: { type: string; payload: Record<string, unknown> }[] = [];
	const reported: { scope: string; error: unknown }[] = [];
	const noop = () => {};
	let useModelCalls = 0;

	const runtime = {
		agentId: AGENT_ID,
		logger: { info: noop, warn: noop, debug: noop, error: noop },
		getModel: (type: string) => {
			if (type === ModelType.PII_SCRUB) {
				if (opts.scrubHandler) {
					return async (_runtime: IAgentRuntime, params: unknown) =>
						opts.scrubHandler?.(params);
				}
			}
			return undefined;
		},
		useModel: async (type: string, params: unknown) => {
			if (type === ModelType.PII_SCRUB) {
				useModelCalls++;
				if (opts.scrubHandler) return opts.scrubHandler(params);
			}
			throw new Error(`No handler for ${type}`);
		},
		getService: () => null,
		getEntityById: async () => null,
		adapter: { searchMessages: vi.fn(async () => []) },
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
		registerPipelineHook: vi.fn(),
		unregisterPipelineHook: vi.fn(),
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
		__useModelCalls: { get: () => useModelCalls },
	});
	return runtime;
}

/** A well-formed "all clear" PII_SCRUB result for the given required span. */
function cleanResult(span: string, rulesetVersion = RULESET): PiiScrubResult {
	return {
		modelId: "test-local-gguf",
		rulesetVersion,
		verdicts: [{ span, kind: "safe" }],
	} as PiiScrubResult;
}

/** Directly drain the service's private BatchQueue (test drives the tick). */
async function drain(service: PiiScrubService): Promise<void> {
	// biome-ignore lint/suspicious/noExplicitAny: reach the private queue to drive a drain deterministically
	await (service as any).batchQueue.drain();
}

async function enqueue(
	service: PiiScrubService,
	payload: Record<string, unknown>,
): Promise<void> {
	// biome-ignore lint/suspicious/noExplicitAny: exercise the event handler directly
	await (service as any).handleScrubRequest({
		itemRef: "test:item",
		writeBack: async () => {},
		...payload,
	});
}

describe("PiiScrubService drain config", () => {
	const prev = process.env.ELIZA_FAST_SHUTDOWN;
	afterEach(() => {
		if (prev === undefined) delete process.env.ELIZA_FAST_SHUTDOWN;
		else process.env.ELIZA_FAST_SHUTDOWN = prev;
	});

	test("mirrors the embedding drain shape (interval, background-serial)", async () => {
		const runtime = makeRuntime();
		const service = (await PiiScrubService.start(runtime)) as PiiScrubService;
		// biome-ignore lint/suspicious/noExplicitAny: inspect private queue config
		const queue = (service as any).batchQueue;
		expect(queue).toBeTruthy();
		expect(queue.options.drainIntervalMs).toBe(100);
		// Serial-ish: never fan a burst of background model calls over an
		// interactive turn.
		expect(queue.options.maxParallel).toBe(2);
		expect(typeof queue.options.process).toBe("function");
		expect(queue.options.processBatch).toBeUndefined();
		await service.stop();
	});

	test("registers the PII_SCRUB_REQUESTED event handler", async () => {
		const runtime = makeRuntime();
		await PiiScrubService.start(runtime);
		expect(runtime.registerEvent).toHaveBeenCalledWith(
			"PII_SCRUB_REQUESTED",
			expect.any(Function),
		);
	});

	test("scrubs persisted memories through the production hook and durable write-back", async () => {
		const originalText = "pay 4111 1111 1111 1111";
		const runtime = makeRuntime({
			scrubHandler: async () => cleanResult(originalText, "2026.08"),
		});
		const service = (await PiiScrubService.start(runtime)) as PiiScrubService;
		const memoryId = "00000000-0000-0000-0000-000000000010" as UUID;
		let stored: Memory = {
			id: memoryId,
			entityId: "00000000-0000-0000-0000-000000000011" as UUID,
			roomId: "00000000-0000-0000-0000-000000000012" as UUID,
			content: { text: originalText },
		};
		runtime.getMemoryById = vi.fn(async () => stored);
		runtime.updateMemory = vi.fn(
			async (update: Parameters<IAgentRuntime["updateMemory"]>[0]) => {
				stored = { ...stored, ...update };
				return true;
			},
		);
		const registered = runtime.registerPipelineHook as unknown as {
			mock: { calls: Array<[PipelineHookSpec]> };
		};
		const hook = registered.mock.calls
			.map(([spec]) => spec)
			.find((spec) => spec.id === "core:pii-scrub:after-memory-persisted");
		expect(hook).toBeDefined();

		await hook?.handler(runtime, {
			phase: "after_memory_persisted",
			memory: stored,
			tableName: "memories",
			memoryId,
		});
		const requested = runtime.__events.find(
			(event) => event.type === "PII_SCRUB_REQUESTED",
		);
		expect(requested).toBeDefined();
		await enqueue(service, requested?.payload ?? {});
		await drain(service);

		expect(stored.content.text).toBe("pay [REDACTED]");
		expect(
			await service.getMarker(originalText, "2026.08", memoryId),
		).toBeDefined();
		await service.stop();
	});

	test("routes lowercase free text through live context and the dedicated PII model", async () => {
		const runtime = makeRuntime({
			scrubHandler: async () => ({
				modelId: "test-local-privacy-gguf",
				rulesetVersion: "2026.08",
				verdicts: [
					{
						span: "met jordan yesterday",
						kind: "pii",
						replacement: "met Person 1 yesterday",
					},
				],
			}),
		});
		const service = (await PiiScrubService.start(runtime)) as PiiScrubService;
		const memoryId = "00000000-0000-0000-0000-000000000020" as UUID;
		let stored: Memory = {
			id: memoryId,
			entityId: "00000000-0000-0000-0000-000000000021" as UUID,
			roomId: "00000000-0000-0000-0000-000000000022" as UUID,
			content: { text: "met jordan yesterday" },
		};
		runtime.getMemoryById = vi.fn(async () => stored);
		runtime.updateMemory = vi.fn(
			async (update: Parameters<IAgentRuntime["updateMemory"]>[0]) => {
				stored = { ...stored, ...update };
				return true;
			},
		);
		const registered = runtime.registerPipelineHook as unknown as {
			mock: { calls: Array<[PipelineHookSpec]> };
		};
		const hook = registered.mock.calls
			.map(([spec]) => spec)
			.find((spec) => spec.id === "core:pii-scrub:after-memory-persisted");

		await hook?.handler(runtime, {
			phase: "after_memory_persisted",
			memory: stored,
			tableName: "memories",
			memoryId,
		});
		const requested = runtime.__events.find(
			(event) => event.type === "PII_SCRUB_REQUESTED",
		);
		expect(requested?.payload.candidateSpans).toEqual(["met jordan yesterday"]);
		expect(requested?.payload.contextPack).toEqual(expect.any(String));

		await enqueue(service, requested?.payload ?? {});
		await drain(service);

		expect(runtime.__useModelCalls).toBe(1);
		expect(stored.content.text).toBe("met Person 1 yesterday");
		expect(
			await service.getMarker(stored.content.text, "2026.08", memoryId),
		).toBeUndefined();
		expect(
			await service.getMarker("met jordan yesterday", "2026.08", memoryId),
		).toBeDefined();
		await service.stop();
	});
});

describe("PiiScrubService enqueue -> drain -> scrub applied", () => {
	test("tier-0-only content completes with ZERO model calls + writes marker", async () => {
		// No candidateSpans means the seam has no residue to escalate, so it never
		// calls a model: an explicit "tier-0 covered everything" completion.
		const runtime = makeRuntime();
		const service = (await PiiScrubService.start(runtime)) as PiiScrubService;
		const content = "my card is 4111 1111 1111 1111";

		await enqueue(service, { content, rulesetVersion: RULESET });
		await drain(service);

		expect(runtime.__useModelCalls).toBe(0);
		const marker = await service.getMarker(content, RULESET, "test:item");
		expect(marker).toBeDefined();
		expect(marker?.tier0Only).toBe(true);
		expect(marker?.modelId).toBe("tier0");
		expect(marker?.contentHash).toBe(hashScrubContent(content));

		const completed = runtime.__events.filter(
			(e) => e.type === "PII_SCRUB_COMPLETED",
		);
		expect(completed).toHaveLength(1);
		expect(completed[0].payload.tier0Only).toBe(true);
		await service.stop();
	});

	test("durably writes tier-0 output before marking and emits the transformed text", async () => {
		const runtime = makeRuntime();
		const service = (await PiiScrubService.start(runtime)) as PiiScrubService;
		const content = "my card is 4111 1111 1111 1111";
		const order: string[] = [];
		const setCache = runtime.setCache.bind(runtime);
		runtime.setCache = async (key, value) => {
			order.push("marker");
			return setCache(key, value);
		};

		await enqueue(service, {
			content,
			rulesetVersion: RULESET,
			writeBack: async (scrubbedText: string) => {
				order.push("writeBack");
				expect(scrubbedText).toBe("my card is [REDACTED]");
			},
		});
		await drain(service);

		expect(order).toEqual(["writeBack", "marker"]);
		const completed = runtime.__events.find(
			(event) => event.type === "PII_SCRUB_COMPLETED",
		);
		expect(completed?.payload.scrubbedText).toBe("my card is [REDACTED]");
		await service.stop();
	});

	test("residue content escalates to the model, then marks done", async () => {
		const name = "Jordan Rivers";
		const runtime = makeRuntime({
			scrubHandler: async () => cleanResult(name),
		});
		const service = (await PiiScrubService.start(runtime)) as PiiScrubService;
		const content = `spoke with ${name} yesterday`;

		await enqueue(service, {
			content,
			rulesetVersion: RULESET,
			candidateSpans: [name],
		});
		await drain(service);

		expect(runtime.__useModelCalls).toBe(1);
		const marker = await service.getMarker(content, RULESET, "test:item");
		expect(marker?.tier0Only).toBe(false);
		expect(marker?.modelId).toBe("test-local-gguf");
		expect(
			runtime.__events.filter((e) => e.type === "PII_SCRUB_COMPLETED"),
		).toHaveLength(1);
		await service.stop();
	});
});

describe("PiiScrubService content-hash idempotency", () => {
	test("requires a source reference and durable write-back before enqueue", async () => {
		const runtime = makeRuntime();
		const service = (await PiiScrubService.start(runtime)) as PiiScrubService;
		await expect(
			enqueue(service, {
				content: "my card is 4111 1111 1111 1111",
				rulesetVersion: RULESET,
				writeBack: undefined,
			}),
		).rejects.toMatchObject({ code: "PII_SCRUB_WRITE_BACK_REQUIRED" });
		await service.stop();
	});

	test("scrubs identical content independently for distinct source artifacts", async () => {
		const runtime = makeRuntime({
			scrubHandler: async () => cleanResult("Alex Doe"),
		});
		const service = (await PiiScrubService.start(runtime)) as PiiScrubService;
		const content = "met Alex Doe";
		const firstWriteBack = vi.fn(async () => {});
		const secondWriteBack = vi.fn(async () => {});

		await enqueue(service, {
			content,
			rulesetVersion: RULESET,
			candidateSpans: ["Alex Doe"],
			itemRef: "memory:a",
			writeBack: firstWriteBack,
		});
		await drain(service);
		await enqueue(service, {
			content,
			rulesetVersion: RULESET,
			candidateSpans: ["Alex Doe"],
			itemRef: "memory:b",
			writeBack: secondWriteBack,
		});
		await drain(service);

		expect(runtime.__useModelCalls).toBe(2);
		expect(firstWriteBack).toHaveBeenCalledOnce();
		expect(secondWriteBack).toHaveBeenCalledOnce();
		expect(await service.getMarker(content, RULESET, "memory:a")).toBeDefined();
		expect(await service.getMarker(content, RULESET, "memory:b")).toBeDefined();
		await service.stop();
	});

	test("re-enqueue of UNCHANGED content skips before the queue (no drain work)", async () => {
		const runtime = makeRuntime({
			scrubHandler: async () => cleanResult("Alex Doe"),
		});
		const service = (await PiiScrubService.start(runtime)) as PiiScrubService;
		const content = "met Alex Doe";

		await enqueue(service, {
			content,
			rulesetVersion: RULESET,
			candidateSpans: ["Alex Doe"],
		});
		await drain(service);
		expect(runtime.__useModelCalls).toBe(1);

		// Second enqueue of the exact same content+ruleset: pre-enqueue
		// idempotency check short-circuits, nothing is queued.
		await enqueue(service, {
			content,
			rulesetVersion: RULESET,
			candidateSpans: ["Alex Doe"],
		});
		expect(service.getQueueSize()).toBe(0);
		await drain(service);
		// Still exactly one model call: the re-scrub was a no-op.
		expect(runtime.__useModelCalls).toBe(1);
		await service.stop();
	});

	test("drain-time idempotency: a stale duplicate re-enqueued after completion no-ops", async () => {
		const runtime = makeRuntime({
			scrubHandler: async () => cleanResult("Sam Vale"),
		});
		const service = (await PiiScrubService.start(runtime)) as PiiScrubService;
		const content = "call Sam Vale";

		await enqueue(service, {
			content,
			rulesetVersion: RULESET,
			candidateSpans: ["Sam Vale"],
		});
		await drain(service);
		expect(runtime.__useModelCalls).toBe(1);

		// A duplicate pushed directly onto the queue AFTER the first drain
		// completed (bypassing the pre-enqueue check) still no-ops at drain time:
		// the isScrubDone re-check inside scrubItem sees the marker from drain 1.
		// biome-ignore lint/suspicious/noExplicitAny: push a duplicate raw item to simulate a stale re-enqueue
		(service as any).batchQueue.enqueue({
			content,
			rulesetVersion: RULESET,
			candidateSpans: ["Sam Vale"],
			priority: "low",
			inferencePriority: "background",
			itemRef: "test:item",
			writeBack: async () => {},
		});
		expect(service.getQueueSize()).toBe(1);
		await drain(service);
		expect(runtime.__useModelCalls).toBe(1);
		await service.stop();
	});

	test("a ruleset bump re-scrubs the same content (new v<...> key)", async () => {
		const runtime = makeRuntime({
			scrubHandler: async (params) => {
				const p = params as { rulesetVersion: string };
				return cleanResult("Robin Fox", p.rulesetVersion);
			},
		});
		const service = (await PiiScrubService.start(runtime)) as PiiScrubService;
		const content = "email Robin Fox";

		await enqueue(service, {
			content,
			rulesetVersion: "2026.07",
			candidateSpans: ["Robin Fox"],
		});
		await drain(service);
		expect(runtime.__useModelCalls).toBe(1);

		// Ruleset upgraded: same content, new key, so it is re-scrubbed.
		await enqueue(service, {
			content,
			rulesetVersion: "2026.08",
			candidateSpans: ["Robin Fox"],
		});
		await drain(service);
		expect(runtime.__useModelCalls).toBe(2);
		expect(
			await service.getMarker(content, "2026.07", "test:item"),
		).toBeDefined();
		expect(
			await service.getMarker(content, "2026.08", "test:item"),
		).toBeDefined();
		await service.stop();
	});
});

describe("PiiScrubService crash/retry safety (fail-closed)", () => {
	test("a missing model for residue does NOT mark done (fail-closed, retried, then FAILED)", async () => {
		// No scrubHandler means getModel returns undefined, so the seam throws for
		// residue. The item must NOT be marked done.
		const runtime = makeRuntime();
		const service = (await PiiScrubService.start(runtime)) as PiiScrubService;
		const content = "contact Dana Reed";

		await enqueue(service, {
			content,
			rulesetVersion: RULESET,
			candidateSpans: ["Dana Reed"],
		});

		// Drain enough to exhaust retries (maxRetriesAfterFailure: 3).
		for (let i = 0; i < 6; i++) {
			await drain(service);
		}

		// The content is NEVER marked done: it stays quarantined for a later
		// retry once a model is registered.
		expect(
			await service.getMarker(content, RULESET, "test:item"),
		).toBeUndefined();
		// Exhaustion surfaced a FAILED event + a reportError.
		expect(runtime.__events.some((e) => e.type === "PII_SCRUB_FAILED")).toBe(
			true,
		);
		expect(runtime.__reported.some((r) => r.scope === "pii-scrub")).toBe(true);
		await service.stop();
	});

	test("a transient model error is retried within the drain; done-marker only after success", async () => {
		// The BatchProcessor retries a throwing item in-place
		// (maxRetriesAfterFailure: 3). We prove the item ends marked done ONLY
		// after the scrub actually succeeds: a throw never marks an item done.
		let attempts = 0;
		const span = "Kai Long";
		const runtime = makeRuntime({
			scrubHandler: async () => {
				attempts++;
				if (attempts === 1) {
					throw new Error("simulated transient model crash");
				}
				return cleanResult(span);
			},
		});
		const service = (await PiiScrubService.start(runtime)) as PiiScrubService;
		const content = `ping ${span}`;

		await enqueue(service, {
			content,
			rulesetVersion: RULESET,
			candidateSpans: [span],
		});

		await drain(service);
		const marker = await service.getMarker(content, RULESET, "test:item");
		expect(marker).toBeDefined();
		expect(marker?.tier0Only).toBe(false);
		expect(attempts).toBeGreaterThanOrEqual(2);
		expect(
			runtime.__events.filter((e) => e.type === "PII_SCRUB_COMPLETED"),
		).toHaveLength(1);
		expect(runtime.__events.some((e) => e.type === "PII_SCRUB_FAILED")).toBe(
			false,
		);
		await service.stop();
	});
});
