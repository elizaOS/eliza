import { randomUUID } from "node:crypto";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, expect, test, vi } from "vitest";
import { identifyEmbeddingVector } from "../src/embedding-vector-space";
import {
	EmbeddingGenerationService,
	PREPARED_EMBEDDING_MAX_AGE_MS,
} from "../src/services/embedding";
import { EventType } from "../src/types/events";
import type { Memory } from "../src/types/memory";
import { ModelType } from "../src/types/model";
import type { UUID } from "../src/types/primitives";

const space = "test:prepared:3";
const vector = () => identifyEmbeddingVector([1, 0, 0], space);
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});
async function fixture() {
	const runtime = createSQLiteTestRuntime({
		character: { name: randomUUID(), bio: [] },
		logLevel: "fatal",
	});
	await runtime.adapter.initialize();
	const calls: string[] = [];
	runtime.registerModel(
		ModelType.TEXT_EMBEDDING,
		async (_runtime, params) => {
			if (params !== null)
				calls.push(typeof params === "string" ? params : params.text);
			return vector();
		},
		"prepared-fixture",
		100,
	);
	await runtime.ensureEmbeddingDimension();
	const service = (await EmbeddingGenerationService.start(
		runtime,
	)) as EmbeddingGenerationService;
	cleanups.push(async () => {
		await service.stop();
		await runtime.close();
	});
	const memory: Memory & { id: UUID } = {
		id: randomUUID() as UUID,
		agentId: runtime.agentId,
		entityId: runtime.agentId,
		roomId: runtime.agentId,
		content: { text: "Exact source text" },
	};
	await runtime.createMemory(memory, "messages");
	const logs = vi.spyOn(runtime, "log");
	const queue = (item = memory) =>
		runtime.emitEvent(EventType.EMBEDDING_GENERATION_REQUESTED, {
			runtime,
			memory: item,
			priority: "high",
		});
	const drain = async () => {
		const [task] = await runtime.getTasksByName("EMBEDDING_DRAIN");
		const worker = runtime.getTaskWorker("EMBEDDING_DRAIN");
		if (!task || !worker) throw new Error("Missing real drain task");
		await worker.execute(runtime, {}, task);
	};
	return { runtime, service, memory, calls, queue, drain, logs };
}

test.each(["ready", "pending"])(
	"persists exact prepared vector once (%s)",
	async (order) => {
		const f = await fixture();
		const source = deferred<number[]>();
		f.service.offerPreparedEmbedding(f.memory, source.promise);
		if (order === "ready") source.resolve(vector());
		await Promise.all([f.queue(), f.queue()]);
		const draining = f.drain();
		if (order === "pending") {
			await new Promise((resolve) => setImmediate(resolve));
			source.resolve(vector());
		}
		await draining;
		expect(f.calls).toEqual([]);
		expect((await f.runtime.getMemoryById(f.memory.id))?.embedding).toEqual([
			1, 0, 0,
		]);
		expect(
			f.logs.mock.calls.filter(([entry]) => entry.type === "embedding_event"),
		).toHaveLength(1);
		expect(
			f.logs.mock.calls.some(
				([entry]) => entry.body?.metadata?.reused === true,
			),
		).toBe(true);
		// A completed queue consumes the handoff; requeueing a fresh snapshot does real work.
		await f.queue();
		await f.drain();
		expect(f.calls).toEqual([f.memory.content.text]);
	},
);

test.each([
	"failure",
	"cancelled",
	"wrong-space",
	"wrong-dimension",
	"provider-change",
	"expired",
])("falls back to queue-owned inference: %s", async (mode) => {
	const f = await fixture();
	const source = deferred<number[]>();
	const controller = new AbortController();
	if (mode === "expired")
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	f.service.offerPreparedEmbedding(f.memory, source.promise, controller.signal);
	await f.queue();
	const draining = f.drain();
	await new Promise((resolve) => setImmediate(resolve));
	if (mode === "failure") source.reject(new Error("Foreground failed"));
	else if (mode === "cancelled")
		controller.abort(new Error("Caller cancelled"));
	else if (mode === "expired")
		await vi.advanceTimersByTimeAsync(PREPARED_EMBEDDING_MAX_AGE_MS);
	else if (mode === "wrong-space")
		source.resolve(identifyEmbeddingVector([1, 0, 0], "different"));
	else if (mode === "wrong-dimension")
		source.resolve(identifyEmbeddingVector([1, 0], space));
	else {
		const identity = f.runtime.getEmbeddingIdentity();
		if (!identity) throw new Error("Missing fixture identity");
		vi.spyOn(f.runtime, "getEmbeddingIdentity").mockReturnValue({
			...identity,
			provider: "changed",
		});
		source.resolve(vector());
	}
	await draining;
	expect(f.calls).toEqual([f.memory.content.text]);
	expect((await f.runtime.getMemoryById(f.memory.id))?.embedding).toEqual([
		1, 0, 0,
	]);
	expect(
		f.logs.mock.calls.some(([entry]) => entry.body?.metadata?.reused === false),
	).toBe(true);
	source.resolve(vector());
});

test("changed source is independently embedded; stale prepared write preserves the new source", async () => {
	const f = await fixture();
	const source = deferred<number[]>();
	f.service.offerPreparedEmbedding(f.memory, source.promise);
	await f.queue();
	const draining = f.drain();
	await new Promise((resolve) => setImmediate(resolve));
	const changed = { ...f.memory, content: { text: "Changed exact text" } };
	await f.runtime.updateMemory(changed);
	source.resolve(vector());
	await draining;
	expect(f.calls).toEqual([]);
	expect((await f.runtime.getMemoryById(f.memory.id))?.content.text).toBe(
		changed.content.text,
	);
	expect(
		f.logs.mock.calls.some(
			([entry]) => entry.body?.status === "discarded_stale_source",
		),
	).toBe(true);
	await f.queue(changed);
	await f.drain();
	expect(f.calls).toEqual([changed.content.text]);
});

test("never shares across runtimes or different message identities", async () => {
	const a = await fixture();
	const b = await fixture();
	a.service.offerPreparedEmbedding(a.memory, Promise.resolve(vector()));
	const other = { ...a.memory, id: randomUUID() as UUID };
	await a.runtime.createMemory(other, "messages");
	await a.queue(other);
	await b.queue();
	await Promise.all([a.drain(), b.drain()]);
	expect(a.calls).toEqual([other.content.text]);
	expect(b.calls).toEqual([b.memory.content.text]);
});

test("shutdown releases a pending handoff without cancelling queued storage", async () => {
	const f = await fixture();
	const source = deferred<number[]>();
	f.service.offerPreparedEmbedding(f.memory, source.promise);
	await f.queue();
	const draining = f.drain();
	await new Promise((resolve) => setImmediate(resolve));
	await Promise.all([draining, f.service.stop()]);
	expect(f.calls).toEqual([f.memory.content.text]);
	expect((await f.runtime.getMemoryById(f.memory.id))?.embedding).toEqual([
		1, 0, 0,
	]);
	source.reject(new Error("Late foreground rejection"));
});

test("a failed offer leaves normal queue retry and eventual persistence intact", async () => {
	const f = await fixture();
	const source = deferred<number[]>();
	f.service.offerPreparedEmbedding(f.memory, source.promise);
	source.reject(new Error("Recall failed"));
	const dispatch = vi
		.spyOn(f.runtime, "useModel")
		.mockRejectedValueOnce(new Error("Transient storage inference failure"));
	await f.queue();
	await f.drain();
	expect(dispatch).toHaveBeenCalledTimes(2);
	expect((await f.runtime.getMemoryById(f.memory.id))?.embedding).toEqual([
		1, 0, 0,
	]);
});
