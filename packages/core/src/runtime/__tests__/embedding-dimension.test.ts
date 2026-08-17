/**
 * Boot-time TEXT_EMBEDDING dimension-probe semantics (#10702 / #8769), driven
 * against a real AgentRuntime + InMemoryDatabaseAdapter with canned/broken
 * embedding handlers registered via registerModel (no live model):
 *
 * 1. The probe fails over across eligible registered TEXT_EMBEDDING providers
 *    in priority order — any probe error advances, first success wins, sizes
 *    the vector column, and pins that provider for later embedding calls.
 *    EMBEDDING_PROVIDER=local is a strict ownership boundary: only the local
 *    router/on-device handlers are eligible and cloud is never probed.
 * 2. When every probe fails, a typed EmbeddingDimensionProbeError carries each
 *    provider's failure, and the runtime enters a coherent degraded mode:
 *    memory writes skip vector generation (warn once) instead of emitting
 *    vectors the SQL adapter would silently drop on dimension mismatch
 *    (plugins/plugin-sql/src/base.ts insert/update guards).
 * 3. A later successful re-probe (the deferred boot re-probe) clears the flag
 *    and embedding writes resume at the newly probed dimension.
 * 4. A canonical embedding-provider setting selects that provider even when a
 *    different handler has higher plugin priority.
 * 5. runtime.initialize() survives a total probe failure — boot stays alive in
 *    the degraded mode instead of crashing (#10702's original symptom).
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import type { ElizaError } from "../../errors";
import {
	AgentRuntime,
	EmbeddingDimensionProbeError,
	NoModelProviderConfiguredError,
} from "../../runtime";
import {
	canonicalEmbeddingProbeMarker,
	canonicalEmbeddingRegistrationMetadata,
	canonicalTestEmbedding,
} from "../../testing/canonical-embedding";
import { type Character, type Memory, ModelType, type UUID } from "../../types";

const ROOM_ID = "00000000-0000-0000-0000-000000000001" as UUID;

function makeRuntime(
	options: {
		embeddingProvider?: string;
		ELIZA_EMBEDDING_PROVIDER?: string;
	} = {},
): AgentRuntime {
	return new AgentRuntime({
		character: {
			name: "EmbeddingProbeAgent",
			bio: "test",
			settings: options?.embeddingProvider
				? { EMBEDDING_PROVIDER: options.embeddingProvider }
				: {},
		} as Character,
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
		settings: options.ELIZA_EMBEDDING_PROVIDER
			? { ELIZA_EMBEDDING_PROVIDER: options.ELIZA_EMBEDDING_PROVIDER }
			: {},
	});
}

function makeMemory(text: string): Memory {
	return {
		entityId: "00000000-0000-0000-0000-000000000002" as UUID,
		roomId: ROOM_ID,
		content: { text },
	};
}

function registerCanonicalModel(
	runtime: AgentRuntime,
	modelType: typeof ModelType.TEXT_EMBEDDING,
	handler: Parameters<AgentRuntime["registerModel"]>[1],
	provider: string,
	priority?: number,
): void {
	runtime.registerModel(
		modelType,
		handler,
		provider,
		priority,
		canonicalEmbeddingRegistrationMetadata,
	);
}

describe("AgentRuntime.ensureEmbeddingDimension provider failover", () => {
	it("fails closed when a custom adapter cannot reconcile same-width vector spaces", async () => {
		const runtime = makeRuntime();
		(
			runtime.adapter as { reconcileEmbeddingSpace?: unknown }
		).reconcileEmbeddingSpace = undefined;
		const singleHandler = vi.fn(async (_runtime, params) =>
			params === null
				? canonicalEmbeddingProbeMarker(0.1)
				: canonicalTestEmbedding(),
		);
		const batchHandler = vi.fn(async () => [canonicalTestEmbedding()]);
		registerCanonicalModel(
			runtime,
			ModelType.TEXT_EMBEDDING,
			singleHandler,
			"direct",
			0,
		);
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING_BATCH,
			batchHandler,
			"direct",
			0,
			canonicalEmbeddingRegistrationMetadata,
		);
		const searchMemories = vi.spyOn(runtime.adapter, "searchMemories");

		await expect(runtime.ensureEmbeddingDimension()).resolves.toBeUndefined();
		expect(runtime.isEmbeddingGenerationDisabled()).toBe(true);
		await expect(
			runtime.useModel(ModelType.TEXT_EMBEDDING, { text: "must not run" }),
		).rejects.toMatchObject({
			code: "EMBEDDING_SPACE_UNAVAILABLE",
			severity: "ephemeral",
		});
		await expect(
			runtime.useModel(ModelType.TEXT_EMBEDDING_BATCH, { texts: ["blocked"] }),
		).rejects.toMatchObject({ code: "EMBEDDING_SPACE_UNAVAILABLE" });
		await expect(
			runtime.searchMemories({
				tableName: "memories",
				embedding: canonicalTestEmbedding(),
			}),
		).rejects.toMatchObject({ code: "EMBEDDING_SPACE_UNAVAILABLE" });
		expect(batchHandler).not.toHaveBeenCalled();
		expect(searchMemories).not.toHaveBeenCalled();

		// The exact-width finite null marker remains callable so a deferred
		// reconciliation attempt can recover this runtime.
		await expect(
			runtime.useModel(ModelType.TEXT_EMBEDDING, null, "direct"),
		).resolves.toEqual(canonicalEmbeddingProbeMarker(0.1));
		expect(singleHandler).toHaveBeenCalledTimes(2);
	});

	it("normalizes canonical semantic-query vectors before the adapter boundary", async () => {
		const runtime = makeRuntime();
		registerCanonicalModel(
			runtime,
			ModelType.TEXT_EMBEDDING,
			async (_runtime, params) =>
				params === null
					? canonicalEmbeddingProbeMarker()
					: canonicalTestEmbedding(),
			"direct",
			0,
		);
		await runtime.ensureEmbeddingDimension();

		const searchMemories = vi
			.spyOn(runtime.adapter, "searchMemories")
			.mockResolvedValue([]);
		const query = new Array(384).fill(0);
		query[0] = 3;
		query[1] = 4;
		await runtime.searchMemories({
			tableName: "memories",
			embedding: query,
		});
		expect(searchMemories).toHaveBeenCalledWith(
			expect.objectContaining({
				embedding: expect.arrayContaining([0.6, 0.8]),
			}),
		);

		await expect(
			runtime.searchMemories({
				tableName: "memories",
				embedding: new Array(384).fill(0),
			}),
		).rejects.toMatchObject({ code: "EMBEDDING_QUERY_INVALID" });
		expect(searchMemories).toHaveBeenCalledTimes(1);
	});

	it("gates generation and search when fingerprint reconciliation fails", async () => {
		const runtime = makeRuntime();
		const handler = vi.fn(async (_runtime, params) =>
			params === null
				? canonicalEmbeddingProbeMarker()
				: canonicalTestEmbedding(),
		);
		registerCanonicalModel(
			runtime,
			ModelType.TEXT_EMBEDDING,
			handler,
			"direct",
			0,
		);
		vi.spyOn(runtime.adapter, "reconcileEmbeddingSpace").mockRejectedValue(
			new Error("fingerprint store unavailable"),
		);
		const searchMemories = vi.spyOn(runtime.adapter, "searchMemories");

		await expect(runtime.ensureEmbeddingDimension()).resolves.toBeUndefined();
		expect(runtime.isEmbeddingGenerationDisabled()).toBe(true);
		await expect(
			runtime.useModel(ModelType.TEXT_EMBEDDING, { text: "blocked" }),
		).rejects.toMatchObject({
			code: "EMBEDDING_SPACE_UNAVAILABLE",
			context: {
				reason: expect.stringContaining("fingerprint store unavailable"),
			},
		});
		await expect(
			runtime.searchMemories({
				tableName: "memories",
				embedding: canonicalTestEmbedding(),
			}),
		).rejects.toMatchObject({ code: "EMBEDDING_SPACE_UNAVAILABLE" });
		expect(searchMemories).not.toHaveBeenCalled();
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("pins the canonically routed embedding provider instead of plugin priority", async () => {
		const runtime = makeRuntime({ ELIZA_EMBEDDING_PROVIDER: "direct" });
		const cloudHandler = vi.fn(async () => new Array(1536).fill(0));
		const directHandler = vi.fn(async () => new Array(384).fill(0));

		registerCanonicalModel(
			runtime,
			ModelType.TEXT_EMBEDDING,
			cloudHandler,
			"cloud",
			100,
		);
		registerCanonicalModel(
			runtime,
			ModelType.TEXT_EMBEDDING,
			directHandler,
			"direct",
			0,
		);
		const ensureDim = vi.spyOn(runtime.adapter, "ensureEmbeddingDimension");

		await expect(runtime.ensureEmbeddingDimension()).resolves.toBeUndefined();
		expect(cloudHandler).not.toHaveBeenCalled();
		expect(directHandler).toHaveBeenCalledTimes(1);
		expect(ensureDim).toHaveBeenCalledWith(384);
	});

	it("regenerates empty vectors while preserving non-empty idempotency", async () => {
		const runtime = makeRuntime();
		const embedHandler = vi.fn(async () => canonicalTestEmbedding());
		registerCanonicalModel(
			runtime,
			ModelType.TEXT_EMBEDDING,
			embedHandler,
			"direct",
			0,
		);

		const empty = makeMemory("empty vector");
		empty.embedding = [];
		await expect(runtime.addEmbeddingToMemory(empty)).resolves.toBe(empty);
		expect(empty.embedding).toHaveLength(384);
		expect(Math.hypot(...(empty.embedding ?? []))).toBeCloseTo(1);

		const existing = makeMemory("existing vector");
		existing.embedding = [9];
		await expect(runtime.addEmbeddingToMemory(existing)).resolves.toBe(
			existing,
		);
		expect(existing.embedding).toEqual([9]);
		expect(embedHandler).toHaveBeenCalledTimes(1);
	});

	it("rejects an empty provider result before a caller can persist the memory", async () => {
		const runtime = makeRuntime();
		registerCanonicalModel(
			runtime,
			ModelType.TEXT_EMBEDDING,
			async () => [],
			"direct",
			0,
		);
		const memory = {
			...makeMemory("provider returned no vector"),
			id: "00000000-0000-0000-0000-000000000003" as UUID,
		};
		const createMemory = vi.spyOn(runtime, "createMemory");

		const embedThenPersist = async (): Promise<void> => {
			await runtime.addEmbeddingToMemory(memory);
			await runtime.createMemory(memory, "documents");
		};

		await expect(embedThenPersist()).rejects.toMatchObject<Partial<ElizaError>>(
			{
				code: "EMBEDDING_MODEL_OUTPUT_INVALID",
				severity: "fatal",
				context: {
					modelType: ModelType.TEXT_EMBEDDING,
					provider: "direct",
				},
			},
		);
		expect(createMemory).not.toHaveBeenCalled();
		await expect(runtime.getMemoryById(memory.id)).resolves.toBeNull();
	});

	it("queues empty vectors while skipping non-empty vectors", async () => {
		const runtime = makeRuntime();
		registerCanonicalModel(
			runtime,
			ModelType.TEXT_EMBEDDING,
			async () => canonicalTestEmbedding(),
			"direct",
			0,
		);
		const emitEvent = vi.spyOn(runtime, "emitEvent");

		const empty = makeMemory("queue empty vector");
		empty.embedding = [];
		await runtime.queueEmbeddingGeneration(empty);
		expect(emitEvent).toHaveBeenCalledTimes(1);

		const existing = makeMemory("queue existing vector");
		existing.embedding = [9];
		await runtime.queueEmbeddingGeneration(existing);
		expect(emitEvent).toHaveBeenCalledTimes(1);
	});

	it("fails over past a broken provider on a non-rate-limit probe error and pins the working provider", async () => {
		const runtime = makeRuntime();
		const brokenHandler = vi.fn(async () => {
			throw new Error("Not Implemented");
		});
		const healthyHandler = vi.fn(async (_runtime, params) =>
			params === null
				? canonicalEmbeddingProbeMarker()
				: canonicalTestEmbedding(),
		);

		registerCanonicalModel(
			runtime,
			ModelType.TEXT_EMBEDDING,
			brokenHandler,
			"ollama",
			100,
		);
		registerCanonicalModel(
			runtime,
			ModelType.TEXT_EMBEDDING,
			healthyHandler,
			"elizacloud",
			10,
		);
		const ensureDim = vi.spyOn(runtime.adapter, "ensureEmbeddingDimension");

		await expect(runtime.ensureEmbeddingDimension()).resolves.toBeUndefined();

		expect(brokenHandler).toHaveBeenCalledTimes(1);
		expect(healthyHandler).toHaveBeenCalledTimes(1);
		expect(ensureDim).toHaveBeenCalledWith(384);
		expect(runtime.isEmbeddingGenerationDisabled()).toBe(false);

		// The column was sized from elizacloud's output, so later embedding
		// calls are pinned to it — the higher-priority broken provider must NOT
		// be retried (its vectors could have a different width and would be
		// silently dropped by the SQL adapter's dimension guard).
		const memory = await runtime.addEmbeddingToMemory(makeMemory("hello"));
		expect(memory.embedding).toHaveLength(384);
		expect(brokenHandler).toHaveBeenCalledTimes(1);
		expect(healthyHandler).toHaveBeenCalledTimes(2);
	});

	it("never probes a remote provider when EMBEDDING_PROVIDER=local", async () => {
		const runtime = makeRuntime({ embeddingProvider: "local" });
		const localRouter = vi.fn(async () => {
			throw new Error("local GGUF is still staging");
		});
		const cloudHandler = vi.fn(async () => new Array(1536).fill(0));

		registerCanonicalModel(
			runtime,
			ModelType.TEXT_EMBEDDING,
			cloudHandler,
			"elizacloud",
			100,
		);
		registerCanonicalModel(
			runtime,
			ModelType.TEXT_EMBEDDING,
			localRouter,
			"eliza-router",
			Number.MAX_SAFE_INTEGER,
		);

		const error: unknown = await runtime
			.ensureEmbeddingDimension()
			.catch((err: unknown) => err);

		expect(error).toBeInstanceOf(EmbeddingDimensionProbeError);
		expect((error as EmbeddingDimensionProbeError).attempts).toEqual([
			{
				provider: "eliza-router",
				modelKey: ModelType.TEXT_EMBEDDING,
				error: "local GGUF is still staging",
			},
		]);
		expect(localRouter).toHaveBeenCalledTimes(1);
		expect(cloudHandler).not.toHaveBeenCalled();
		expect(runtime.isEmbeddingGenerationDisabled()).toBe(true);
	});

	it("fails closed when local ownership is configured without an on-device handler", async () => {
		const runtime = makeRuntime({ embeddingProvider: "local" });
		const cloudHandler = vi.fn(async () => new Array(1536).fill(0));
		registerCanonicalModel(
			runtime,
			ModelType.TEXT_EMBEDDING,
			cloudHandler,
			"elizacloud",
			100,
		);

		const error: unknown = await runtime
			.ensureEmbeddingDimension()
			.catch((err: unknown) => err);

		expect(error).toBeInstanceOf(EmbeddingDimensionProbeError);
		expect((error as EmbeddingDimensionProbeError).attempts[0]).toMatchObject({
			provider: "local",
			error: expect.stringContaining("no on-device embedding handler"),
		});
		expect(cloudHandler).not.toHaveBeenCalled();
		expect(runtime.isEmbeddingGenerationDisabled()).toBe(true);
	});

	it("treats an invalid probe embedding as a failed attempt and advances", async () => {
		const runtime = makeRuntime();
		const emptyHandler = vi.fn(async () => []);
		const healthyHandler = vi.fn(async () => canonicalEmbeddingProbeMarker());

		registerCanonicalModel(
			runtime,
			ModelType.TEXT_EMBEDDING,
			emptyHandler,
			"empty",
			50,
		);
		registerCanonicalModel(
			runtime,
			ModelType.TEXT_EMBEDDING,
			healthyHandler,
			"healthy",
			10,
		);
		const ensureDim = vi.spyOn(runtime.adapter, "ensureEmbeddingDimension");

		await expect(runtime.ensureEmbeddingDimension()).resolves.toBeUndefined();
		expect(ensureDim).toHaveBeenCalledWith(384);
		expect(runtime.isEmbeddingGenerationDisabled()).toBe(false);
	});

	it("throws a typed error carrying every provider's failure when all probes fail, and gates memory writes with a single warning", async () => {
		const runtime = makeRuntime();
		const ollamaHandler = vi.fn(async () => {
			throw new Error("Not Implemented");
		});
		const cloudHandler = vi.fn(async () => {
			throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
		});

		registerCanonicalModel(
			runtime,
			ModelType.TEXT_EMBEDDING,
			ollamaHandler,
			"ollama",
			100,
		);
		registerCanonicalModel(
			runtime,
			ModelType.TEXT_EMBEDDING,
			cloudHandler,
			"elizacloud",
			10,
		);
		const ensureDim = vi.spyOn(runtime.adapter, "ensureEmbeddingDimension");

		const error: unknown = await runtime
			.ensureEmbeddingDimension()
			.catch((err: unknown) => err);
		expect(error).toBeInstanceOf(EmbeddingDimensionProbeError);
		const probeError = error as EmbeddingDimensionProbeError;
		expect(probeError.attempts).toEqual([
			{
				provider: "ollama",
				modelKey: ModelType.TEXT_EMBEDDING,
				error: "Not Implemented",
			},
			{
				provider: "elizacloud",
				modelKey: ModelType.TEXT_EMBEDDING,
				error: "connect ECONNREFUSED 127.0.0.1:11434",
			},
		]);
		expect(probeError.message).toContain("ollama: Not Implemented");
		expect(probeError.message).toContain(
			"elizacloud: connect ECONNREFUSED 127.0.0.1:11434",
		);

		// Coherent degraded mode: no dimension was pinned, and the write path
		// skips embedding generation instead of calling a broken provider (or
		// writing vectors a default-sized column would silently drop).
		expect(ensureDim).not.toHaveBeenCalled();
		expect(runtime.isEmbeddingGenerationDisabled()).toBe(true);

		const warn = vi.spyOn(runtime.logger, "warn");
		const first = await runtime.addEmbeddingToMemory(makeMemory("hello"));
		const second = await runtime.addEmbeddingToMemory(makeMemory("world"));
		expect(first.embedding).toBeUndefined();
		expect(second.embedding).toBeUndefined();
		expect(ollamaHandler).toHaveBeenCalledTimes(1); // probe only, no per-write calls
		expect(cloudHandler).toHaveBeenCalledTimes(1);

		// queueEmbeddingGeneration must also skip: no embedding event is emitted.
		const emitEvent = vi.spyOn(runtime, "emitEvent");
		await runtime.queueEmbeddingGeneration(makeMemory("queued"));
		expect(emitEvent).not.toHaveBeenCalled();

		// Once-latch: exactly one skip warning across all three writes.
		const skipWarnings = warn.mock.calls.filter(([, message]) =>
			String(message).includes("Embedding generation is disabled"),
		);
		expect(skipWarnings).toHaveLength(1);
	});

	it("re-enables embedding writes at the correct dimension after a successful re-probe (recovery)", async () => {
		const runtime = makeRuntime();
		let recovered = false;
		const flakyHandler = vi.fn(async (_runtime, params) => {
			if (!recovered) {
				throw new Error("Not Implemented");
			}
			return params === null
				? canonicalEmbeddingProbeMarker()
				: canonicalTestEmbedding();
		});

		registerCanonicalModel(
			runtime,
			ModelType.TEXT_EMBEDDING,
			flakyHandler,
			"elizacloud",
			100,
		);
		const ensureDim = vi.spyOn(runtime.adapter, "ensureEmbeddingDimension");

		// Boot-time probe: provider down → degraded mode, writes skip vectors.
		await expect(runtime.ensureEmbeddingDimension()).rejects.toBeInstanceOf(
			EmbeddingDimensionProbeError,
		);
		expect(runtime.isEmbeddingGenerationDisabled()).toBe(true);
		const degraded = await runtime.addEmbeddingToMemory(makeMemory("early"));
		expect(degraded.embedding).toBeUndefined();

		// Provider recovers; the deferred re-probe (packages/agent runDeferredBoot)
		// calls ensureEmbeddingDimension again.
		recovered = true;
		await expect(runtime.ensureEmbeddingDimension()).resolves.toBeUndefined();

		expect(runtime.isEmbeddingGenerationDisabled()).toBe(false);
		expect(ensureDim).toHaveBeenCalledWith(384);

		// No silent drop after recovery: the write resumes and its vector width
		// matches the dimension the adapter column was just configured with, so
		// the plugin-sql dimension guard cannot drop it.
		const restored = await runtime.addEmbeddingToMemory(makeMemory("late"));
		expect(restored.embedding).toHaveLength(384);
		expect(ensureDim).toHaveBeenLastCalledWith(384);
	});

	it("fails semantic operations closed when every handler has no backing provider", async () => {
		const runtime = makeRuntime();
		const proxyHandler = vi.fn(async () => {
			throw new NoModelProviderConfiguredError();
		});
		registerCanonicalModel(
			runtime,
			ModelType.TEXT_EMBEDDING,
			proxyHandler,
			"elizacloud",
			100,
		);
		const ensureDim = vi.spyOn(runtime.adapter, "ensureEmbeddingDimension");

		// No provider can attest/reconcile the active space, so even a caller-
		// supplied vector must not query potentially stale same-width rows.
		await expect(runtime.ensureEmbeddingDimension()).resolves.toBeUndefined();
		expect(ensureDim).not.toHaveBeenCalled();
		expect(runtime.isEmbeddingGenerationDisabled()).toBe(true);
		await expect(
			runtime.searchMemories({
				tableName: "memories",
				embedding: canonicalTestEmbedding(),
			}),
		).rejects.toMatchObject({ code: "EMBEDDING_SPACE_UNAVAILABLE" });
	});
});

describe("AgentRuntime.initialize with a broken TEXT_EMBEDDING provider (#10702)", () => {
	it("treats the pre-plugin local handler gap as expected startup sequencing", async () => {
		const runtime = makeRuntime({ embeddingProvider: "local" });
		registerCanonicalModel(
			runtime,
			ModelType.TEXT_EMBEDDING,
			async () => new Array(1536).fill(0),
			"elizacloud",
			100,
		);
		const reportError = vi.spyOn(runtime, "reportError");
		const errorLog = vi.spyOn(runtime.logger, "error");

		await expect(runtime.initialize()).resolves.toBeUndefined();

		expect(runtime.isEmbeddingGenerationDisabled()).toBe(true);
		expect(reportError).not.toHaveBeenCalled();
		expect(errorLog).not.toHaveBeenCalled();
	});

	it("boots in degraded mode when the only provider fails the probe, instead of crashing", async () => {
		const runtime = makeRuntime();
		const ollamaHandler = vi.fn(async () => {
			throw new Error("Not Implemented");
		});
		registerCanonicalModel(
			runtime,
			ModelType.TEXT_EMBEDDING,
			ollamaHandler,
			"ollama",
			100,
		);

		// #10702's original symptom: this rejected and killed agent boot.
		await expect(runtime.initialize()).resolves.toBeUndefined();

		// The degraded mode is explicit, not silent: embedding generation is
		// flagged off and memory writes persist without vectors instead of the
		// SQL adapter silently dropping mismatched ones.
		expect(runtime.isEmbeddingGenerationDisabled()).toBe(true);
		const memory = await runtime.addEmbeddingToMemory(makeMemory("post-boot"));
		expect(memory.embedding).toBeUndefined();
	});
});
